/**
 * Live-capsule bridge for the arena.
 *
 * When a paper agent is bound to a capsule in stage='live', its signals route
 * through ExecutionRouter (real orders) instead of the pure-sim apply path.
 * The router's 5 gates (idempotency, halt, capsule, risk engine, adapter)
 * + per-venue ALLOW_TRADE safety still apply on top — there's no way for a
 * live signal to fire without all of those passing.
 *
 * v1 → v2 changes:
 *   - Coinbase ENTRIES routed live (BUY quote_size)
 *   - Coinbase EXITS routed live (SELL base_size = size_usd/entry_price)
 *   - Polymarket ENTRIES + EXITS stay sim-tracked (PolymarketAdapter only
 *     supports FOK_BASKET; adding single-side support is a follow-up)
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { getDefaultRouter } from "@/lib/venue/router";
import { insertEvolutionEvent } from "@/lib/db/queries";
import { getBinaryMeta } from "./short-binaries";
import { runDecisionPipeline } from "@/lib/decision/pipeline";
import { recordDecision } from "@/lib/decision/journal";
import { loadMetaModel } from "@/lib/decision/meta-label-store";
import { activeRegimeFitTable } from "@/lib/decision/regime-fit-table";
import type { MetaLabelSizing } from "@/lib/decision/meta-label";
import type { DecisionContext } from "@/lib/decision/types";
import { snapshotFromWindow } from "./context";
import { genomeKindOr } from "./genome";
import type { Position, Signal, SnapshotWindow } from "./types";

// Meta-label sizing (trim-only) is opt-in via META_LABEL_SIZING=1 + a trained
// model at data/meta-label-model.json (npm run train:metalabel). Loaded once,
// lazily; absent/empty model ⇒ disabled (no behaviour change).
let _metaSizing: MetaLabelSizing | null | undefined;
function metaLabelSizing(): MetaLabelSizing | undefined {
  if (process.env.META_LABEL_SIZING !== "1") return undefined;
  if (_metaSizing === undefined) {
    const model = loadMetaModel();
    _metaSizing = model && model.n > 0 ? { model } : null;
  }
  return _metaSizing ?? undefined;
}

export type LiveCapsuleBinding = {
  id: string;
  paper_agent_id: number;
  capital_allocated_usd: number;
  capital_available_usd: number;
  max_position_pct: number;
  max_open_positions: number;
  max_daily_loss_usd: number;
  daily_pnl_usd: number;
  status: string;
};

export function findLiveCapsuleForPaperAgent(paperAgentId: number): LiveCapsuleBinding | undefined {
  return db().prepare(
    `SELECT id, paper_agent_id, capital_allocated_usd, capital_available_usd,
            max_position_pct, max_open_positions, max_daily_loss_usd, daily_pnl_usd, status
       FROM capsules WHERE paper_agent_id = ? AND status = 'live'
       LIMIT 1`,
  ).get(paperAgentId) as LiveCapsuleBinding | undefined;
}

function venueLabel(arenaVenue: "sim-poly" | "sim-coinbase"): "polymarket" | "coinbase" {
  return arenaVenue === "sim-poly" ? "polymarket" : "coinbase";
}

/** Small helper — guarantees a positive number for the SELL share-count
 *  estimator in the exit path so a stale 0 refPrice doesn't divide-by-zero. */
function ctx_refPrice(refPrice: number): number {
  return refPrice > 0 ? refPrice : 0.5;
}

/**
 * Whether the live-trading path supports this signal.
 *   - sim-coinbase: entries + exits (Coinbase adapter handles SELL too)
 *   - sim-poly entries: BUY YES, or SELL-via-NO when the binary metadata has
 *     a no_token_id (adapter swaps to BUY NO)
 *   - sim-poly exits: supported ONLY when the open position carries a
 *     `live_token_id` (set after a successful live entry). Without that we
 *     don't know which token (YES vs NO) is sitting in the wallet, so the
 *     caller should fall back to sim. The resolver handles end-of-life
 *     settlements separately at `expiry_iso`.
 *
 * NOTE: the exit-decision needs to inspect the open Position; that lookup
 * happens in `routeArenaSignal` (which has the position arg). This function
 * only screens the signal kind; positional check happens at submit time.
 */
export function supportsLiveRouting(signal: Signal): boolean {
  if (signal.kind === "hold") return false;
  if (signal.venue === "sim-coinbase") return true;
  if (signal.venue === "sim-poly" && signal.kind === "entry") return true;
  // sim-poly EXIT: caller must additionally check position.live_token_id;
  // we return true to allow the dispatcher to try, and reject below if
  // metadata is missing.
  if (signal.venue === "sim-poly" && signal.kind === "exit") return true;
  return false;
}

export type RouteResult =
  | {
      ok: true; status: "filled" | "dry_run"; usdEquivalent: number;
      brokerOrderId?: string; raw?: unknown;
      /** Token actually filled (= YES tokenId, or the NO tokenId after a
       *  SELL→BUY-NO swap on a directional poly entry). Caller writes this
       *  to the freshly-created Position so the EXIT/resolver paths can find
       *  the right token to settle against. */
      liveTokenId?: string;
      liveSizeUsd?: number;
      /** The clientOrderId we sent — surfaced so arena-tick can stamp it on
       *  the Position. The reconciler matches by this OR broker order id. */
      clientOrderId?: string;
    }
  | { ok: false; code: string; reason: string };

/**
 * Submit an arena entry OR exit signal through ExecutionRouter using the
 * capsule binding. For exits, `position` must be the open Position being closed
 * (used to compute base_size for SELL).
 */
export async function routeArenaSignal(
  signal: Signal,
  capsule: LiveCapsuleBinding,
  agentId: number,
  refPrice: number,
  position?: Position,
  win?: SnapshotWindow, // the caller's already-built tick window for signal.market_id (regime features)
): Promise<RouteResult> {
  if (signal.kind === "hold") return { ok: false, code: "NO_SIGNAL", reason: "hold" };
  if (!supportsLiveRouting(signal)) {
    return { ok: false, code: "UNSUPPORTED_VENUE_LIVE", reason: `${signal.venue} not supported for live routing in v1` };
  }

  const router = getDefaultRouter();

  let side: "BUY" | "SELL";
  let size: number;
  let intent: "entry" | "exit";
  let market_id: string;
  let rationale: string;

  if (signal.kind === "entry") {
    side = signal.side;
    // Clamp the live entry size to the tighter of:
    //   - what the strategy asked for (signal.size_usd)
    //   - the capsule's remaining available capital
    //   - the global per-trade cap (MAX_TRADE_USD, default $5)
    // Strategies in sim can request large bets (fade_spike up to $100); for
    // live trading we honor the operator's safety caps. Bug-fix 2026-05-27
    // (#20) — without this clamp, a fade-spike agent with entry_size_usd=$36
    // gets rejected by execute.ts's MAX_TRADE_USD gate and the capsule fires
    // 0 trades.
    const maxTradeUsd = Number(process.env.MAX_TRADE_USD ?? "25");
    const capsuleAvailable = capsule.capital_available_usd ?? capsule.capital_allocated_usd ?? Infinity;
    size = Math.min(signal.size_usd, capsuleAvailable, Number.isFinite(maxTradeUsd) ? maxTradeUsd : signal.size_usd);
    intent = "entry";
    market_id = signal.market_id;
    rationale = signal.rationale;
  } else {
    // EXIT: derive the closing-side + size from the open position.
    if (!position) return { ok: false, code: "MISSING_POSITION", reason: "exit signal but no position passed" };
    market_id = signal.market_id;
    rationale = signal.rationale;
    intent = "exit";

    // sim-poly EXIT must have a live_token_id on the position (set by a
    // successful entry route). Without it we don't know which token is in
    // the wallet — fall back to sim.
    if (signal.venue === "sim-poly") {
      if (!position.live_token_id) {
        return { ok: false, code: "NO_LIVE_TOKEN", reason: "sim-poly exit without live_token_id (paper-only position)" };
      }
      // Route to the actual filled token. Polymarket positions are always
      // LONG in CLOB terms (BUY YES or BUY NO); the exit is always SELL.
      market_id = position.live_token_id;
      side = "SELL";
      // size for SELL is share count. We use live_filled_shares if the
      // reconciler populated it; otherwise estimate from paid_usd / mid.
      const refMid = ctx_refPrice(refPrice);
      const filled = position.live_filled_shares;
      if (filled && filled > 0) size = filled;
      else if (position.live_paid_usd && refMid > 0) size = position.live_paid_usd / refMid;
      else size = position.size_usd / (position.entry_price > 0 ? position.entry_price : 0.5);
    } else {
      // sim-coinbase exit: original logic.
      side = position.side === "BUY" ? "SELL" : "BUY";
      if (side === "SELL") {
        if (!(position.entry_price > 0)) return { ok: false, code: "BAD_POSITION", reason: "entry_price <= 0" };
        size = position.size_usd / position.entry_price;
      } else {
        size = position.size_usd;
      }
    }
  }

  // For sim-poly entries, look up the binary's NO token id so the adapter can
  // swap a SELL-YES bet into a BUY-NO order. Non-binary poly tokens won't have
  // a matching row — adapter handles undefined gracefully.
  let polyMetadata: Record<string, unknown> = {};
  if (signal.venue === "sim-poly" && intent === "entry") {
    const meta = getBinaryMeta(market_id);
    if (meta?.no_token_id) polyMetadata = { no_token_id: meta.no_token_id, asset: meta.asset };
    // sizeUsd is needed by the adapter MARKET path to size the BUY notional.
    // Must use the CLAMPED `size` (already constrained to MAX_TRADE_USD +
    // capsule capital) — the adapter reads metadata.sizeUsd BEFORE falling
    // back to order.size, so this is the authoritative source. Bug-fix
    // 2026-05-27 (#20 follow-up).
    polyMetadata.sizeUsd = size;
  }

  const order = {
    clientOrderId: `arena-${capsule.id.slice(0, 8)}-${agentId}-${intent}-${randomUUID().slice(0, 8)}`,
    venue: venueLabel(signal.venue),
    symbol: market_id,
    side,
    type: "MARKET" as const,
    size,
    refPrice,
    capsuleId: capsule.id,
    agentId,
    metadata: {
      source: "arena", intent, rationale,
      ...(intent === "exit" && position ? { entry_price: position.entry_price, opened_at: position.opened_at } : {}),
      ...polyMetadata,
    },
  };

  // ───────────────────────────────────────────────────────────────────────
  // Decision-pipeline integration (Phases 2 + 3).
  //
  // SHADOW mode (DECISION_PIPELINE_SHADOW=1):
  //   - Pipeline runs, decision is journaled, real trade flow is UNAFFECTED.
  //   - Observability only — operator reviews /decisions before flipping active.
  //
  // ACTIVE mode (DECISION_PIPELINE_ENABLED=1):
  //   - Pipeline result modulates the trade:
  //       REJECTED / KILL_SWITCH      → return early, no submit
  //       WATCHLIST                    → return early, paper-only (no submit)
  //       APPROVED_REDUCED             → clamp order.size by size_multiplier
  //       APPROVED_FULL                → submit unchanged
  //
  // PRE-FLIGHT before flipping ENABLED=1 (per implementation plan):
  //   1. Shadow has run ≥24h with ≥10 journaled decisions
  //   2. SELECT * FROM decision_journal WHERE approval_score IS NULL OR
  //      gate_results_json = '' → 0 rows
  //   3. Manually inspect 5 random REJECTED rows — every reason sensible
  //   4. Manually inspect 5 random APPROVED_FULL rows — none would obviously
  //      have been bad trades
  //   5. apply-risk-budget.ts re-run immediately before flipping
  //   6. RISK_STAKE_USD at low value ($2) so misbehaviour can't cost much
  //
  // BOTH modes are wrapped in try/catch — pipeline failure is non-fatal:
  // logs to evolution_log and the original code path continues unchanged.
  // ───────────────────────────────────────────────────────────────────────
  const pipelineShadow = process.env.DECISION_PIPELINE_SHADOW === "1";
  const pipelineEnabled = process.env.DECISION_PIPELINE_ENABLED === "1";
  // ENTRY-ONLY: the decision pipeline is an entry gate — the meta-labeler + regime-fit
  // table are trained EXCLUSIVELY on entries (calibration grades each entry by its linked
  // exit's PnL). It must NEVER gate or trim an EXIT: a "reduce size" applied to a closing
  // order means "close LESS" = MORE live exposure, using an out-of-distribution model that
  // has no exit labels. Exits always flow through to flatten risk. (Review finding F1.)
  if ((pipelineShadow || pipelineEnabled) && intent === "entry") {
    try {
      // Real snapshot for the regime / eligibility features, built from the caller's
      // ALREADY-RESOLVED tick window (no per-order full-table rebuild; same default
      // history horizon + the signal.market_id key the sim/train path uses → train/serve
      // parity). A missing window → undefined → regime 'unknown' → meta-label no-op (the
      // prior safe fallback), so this never blocks or changes a trade when data is absent.
      const liveSnapshot: DecisionContext["snapshot"] = win ? snapshotFromWindow(win, order.refPrice) : undefined;
      // Real strategy kind from the bound paper_agent's genome so the regime-fit table
      // (keyed on genome kind) is live-capable — parity with the sim path. Composite
      // ('multi_strategy') genomes key on their top-level kind on BOTH paths; that is not a
      // SubGenomeKind, so regime-fit stays on the static rail for composites by design.
      // Venue fallback if the genome is unavailable (→ regime-fit static, safe).
      let stratKind: string = signal.venue;
      try {
        const row = db().prepare(`SELECT genome_json FROM paper_agents WHERE id = ?`).get(capsule.paper_agent_id) as { genome_json?: string } | undefined;
        stratKind = genomeKindOr(row?.genome_json, signal.venue);
      } catch { /* genome lookup is best-effort → venue fallback */ }
      const decisionCtx: DecisionContext = {
        agentId,
        capsuleId: capsule.id,
        strategyKind: stratKind, // genome.kind from the bound paper_agent (regime-fit-table live-capable); venue fallback
        proposal: {
          venue: order.venue,
          symbol: order.symbol,
          side: order.side,
          sizeUsd: order.size,
          price: order.refPrice,
          conditionId: order.symbol,
          metadata: order.metadata,
        },
        snapshot: liveSnapshot,
        ts: new Date().toISOString(),
      };
      // skipGovernor: match the sim/train path (sim.ts passes skipGovernor:true), so the
      // serve score-space has the same gate set the meta-labeler trained on. The live
      // router enforces portfolio-level risk independently (capsules/gate.ts + risk/engine).
      const decisionResult = runDecisionPipeline(decisionCtx, { metaLabel: metaLabelSizing(), regimeFitTable: activeRegimeFitTable(), skipGovernor: true });
      recordDecision(decisionCtx, decisionResult);

      // ─── ACTIVE ENFORCEMENT ────────────────────────────────────────────
      if (pipelineEnabled) {
        // Short-circuit rejections + kill switch + watchlist.
        if (decisionResult.decision === "KILL_SWITCH") {
          insertEvolutionEvent({
            event_type: "decision-pipeline-killswitch",
            summary: `pipeline KILL_SWITCH on capsule ${capsule.id.slice(0, 8)} — order blocked`,
            payload_json: JSON.stringify({ decision: decisionResult, capsule_id: capsule.id, agent_id: agentId }),
          });
          return { ok: false, code: "DECISION_KILL_SWITCH", reason: "decision pipeline triggered KILL_SWITCH — system halt" };
        }
        if (decisionResult.decision === "REJECTED") {
          return { ok: false, code: "DECISION_REJECTED", reason: `decision pipeline rejected (score ${decisionResult.approval_score.toFixed(2)})` };
        }
        if (decisionResult.decision === "WATCHLIST") {
          return { ok: false, code: "DECISION_WATCHLIST", reason: `decision pipeline → watchlist only (score ${decisionResult.approval_score.toFixed(2)}) — no live submit` };
        }
        // Clamp size by size_multiplier for any APPROVED decision whose multiplier
        // is below 1 — APPROVED_REDUCED (bucket), or APPROVED_FULL that the
        // meta-labeler trimmed (size_multiplier < 1 via meta_size_factor).
        if (
          (decisionResult.decision === "APPROVED_REDUCED" || decisionResult.decision === "APPROVED_FULL") &&
          decisionResult.size_multiplier < 1
        ) {
          const newSize = order.size * decisionResult.size_multiplier;
          if (newSize <= 0) {
            return { ok: false, code: "DECISION_REJECTED", reason: `size_multiplier ${decisionResult.size_multiplier} would zero the order` };
          }
          order.size = newSize;
          // sizeUsd in metadata is what the polymarket adapter reads as the
          // authoritative source for MARKET notional — must reflect the clamp.
          const metaAsRecord = order.metadata as Record<string, unknown>;
          if (typeof metaAsRecord.sizeUsd === "number") {
            metaAsRecord.sizeUsd = newSize;
          }
        }
      }
    } catch (err) {
      // Defensive: pipeline failure is non-fatal. Log + continue with the
      // original order so the per-capsule + risk-engine layers still enforce.
      insertEvolutionEvent({
        event_type: pipelineEnabled ? "decision-pipeline-active-error" : "decision-pipeline-shadow-error",
        summary: `pipeline ${pipelineEnabled ? "active" : "shadow"} failed (non-fatal): ${(err as Error).message?.slice(0, 200)}`,
        payload_json: JSON.stringify({ capsule_id: capsule.id, agent_id: agentId, market_id }),
      });
    }
  }

  const verdict = await router.submit(order);
  // For sim-poly entries we need to know which token was actually filled
  // (YES vs NO after the swap). The adapter handles the swap based on
  // metadata.no_token_id; replicate the same decision here so the Position
  // gets the correct token recorded.
  let liveTokenId: string | undefined;
  if (signal.venue === "sim-poly" && intent === "entry") {
    const noTokenId = polyMetadata.no_token_id as string | undefined;
    liveTokenId = (side === "SELL" && noTokenId) ? noTokenId : market_id;
  }

  if (verdict.ok) {
    if ("status" in verdict && verdict.status === "dry_run") {
      insertEvolutionEvent({
        event_type: "live-capsule-dry-run",
        summary: `capsule ${capsule.id.slice(0, 8)} dry-run ${intent} on agent ${agentId}: ${market_id}`,
        payload_json: JSON.stringify({ order, verdict, liveTokenId }),
      });
      return {
        ok: true, status: "dry_run", usdEquivalent: verdict.usdEquivalent,
        liveTokenId, liveSizeUsd: verdict.usdEquivalent,
        clientOrderId: order.clientOrderId,
      };
    }
    insertEvolutionEvent({
      event_type: "live-capsule-fill",
      summary: `capsule ${capsule.id.slice(0, 8)} FILLED ${intent} on agent ${agentId}: ${market_id} $${verdict.usdEquivalent.toFixed(2)}`,
      payload_json: JSON.stringify({ order, verdict, liveTokenId }),
    });
    return {
      ok: true,
      status: "filled",
      usdEquivalent: verdict.usdEquivalent,
      brokerOrderId: "brokerOrderId" in verdict ? verdict.brokerOrderId : undefined,
      raw: "raw" in verdict ? verdict.raw : undefined,
      liveTokenId,
      liveSizeUsd: verdict.usdEquivalent,
      clientOrderId: order.clientOrderId,
    };
  }
  insertEvolutionEvent({
    event_type: "live-capsule-rejected",
    summary: `capsule ${capsule.id.slice(0, 8)} REJECTED ${intent} on agent ${agentId}: ${verdict.code} (${verdict.reason})`,
    payload_json: JSON.stringify({ order, verdict }),
  });
  return { ok: false, code: verdict.code, reason: verdict.reason };
}

export function refreshCapsuleRealtime(capsuleId: string, paperAgentId: number): void {
  const agent = db().prepare(
    `SELECT cash_usd_current, unrealized_pnl_usd, realized_pnl_usd
       FROM paper_agents WHERE id = ?`,
  ).get(paperAgentId) as { cash_usd_current: number; unrealized_pnl_usd: number; realized_pnl_usd: number } | undefined;
  if (!agent) return;
  const currentPnl = agent.realized_pnl_usd + agent.unrealized_pnl_usd;
  const dailyRow = db().prepare(
    `SELECT COALESCE(SUM(json_extract(payload_json, '$.verdict.usdEquivalent')), 0) AS spend
       FROM evolution_log
       WHERE event_type = 'live-capsule-fill'
         AND created_at > datetime('now', 'start of day')
         AND json_extract(payload_json, '$.order.capsuleId') = ?`,
  ).get(capsuleId) as { spend: number };
  db().prepare(
    `UPDATE capsules SET current_pnl_usd = ?, daily_pnl_usd = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(currentPnl, -Math.abs(dailyRow.spend ?? 0), capsuleId);
}
