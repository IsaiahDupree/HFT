/**
 * Near-resolution auto-executor — long-running worker.
 *
 *   npm run worker:nrs-exec
 *   NRS_LIVE=1 npm run worker:nrs-exec     # arm live (CAREFUL)
 *
 * Polls evolution_log for new `near-resolution-opportunity` events.
 * For each unseen opportunity:
 *   - Kelly-sizes via kellyFraction(winProb=entryPrice, b=(1/(1-p))-1, lam=0.25)
 *   - Clamps to per-signal USD cap + remaining daily budget
 *   - Submits a BUY of the winning side through ExecutionRouter
 *   - Writes a `nrs-auto-exec` event with full provenance + verdict
 *
 * Defaults are conservative:
 *   - venue = 'sim' (no money) unless NRS_LIVE=1 → 'polymarket'
 *   - per-signal cap   = $25       (NRS_PER_SIGNAL_USD)
 *   - daily USD cap    = $100      (NRS_DAILY_USD_CAP)
 *   - poll interval    = 60s       (NRS_POLL_MS)
 *   - capsule          = "near-resolution-scrape" (NRS_CAPSULE)
 *   - kelly lambda     = 0.25      (NRS_KELLY_LAMBDA) — Quarter Kelly
 *
 * Idempotency: dedup key = source opportunity event ID. Re-runs never double-execute.
 *
 * NO PATH BYPASSES THE ROUTER. Capsule + risk gates apply. The capsule must
 * exist for the strategy to actually trade; missing capsule → router rejects
 * with CAPSULE_NOT_FOUND and the executor logs + moves on.
 */
import { randomUUID } from "node:crypto";
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { insertEvolutionEvent } from "../src/lib/db/queries.ts";
import { getDefaultRouter } from "../src/lib/venue/router.ts";
import type { UnifiedOrder } from "../src/lib/venue/types.ts";

const LIVE = process.env.NRS_LIVE === "1" || process.env.NRS_LIVE === "true";
const PER_SIGNAL_USD = Number(process.env.NRS_PER_SIGNAL_USD ?? 25);
const DAILY_CAP_USD = Number(process.env.NRS_DAILY_USD_CAP ?? 100);
const POLL_MS = Number(process.env.NRS_POLL_MS ?? 60_000);
const CAPSULE_ID = process.env.NRS_CAPSULE ?? "near-resolution-scrape";
/** Reference "max edge" for sizing — opportunities at this edge get full PER_SIGNAL_USD. */
const TARGET_EDGE = Number(process.env.NRS_TARGET_EDGE ?? 0.05);
const VENUE = LIVE ? "polymarket" : "sim";

console.log("[nrs-exec] starting");
console.log(`  mode:        ${LIVE ? "LIVE (CAREFUL!)" : "sim (no money)"}`);
console.log(`  venue:       ${VENUE}`);
console.log(`  per-signal:  $${PER_SIGNAL_USD} cap`);
console.log(`  daily:       $${DAILY_CAP_USD} cap`);
console.log(`  poll:        ${POLL_MS}ms`);
console.log(`  capsule:     ${CAPSULE_ID}`);
console.log(`  target edge: ${(TARGET_EDGE * 100).toFixed(1)}% (per-signal cap at this level)`);

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function pollOnce(): Promise<{ checked: number; executed: number; skipped: number; remainingBudget: number }> {
  const handle = db();
  const today = todayUtc();

  // Today's deployed USD on this strategy (sum from nrs-auto-exec payloads).
  const todayDeployed = (
    handle
      .prepare(
        `SELECT COALESCE(SUM(CAST(json_extract(payload_json, '$.orderUsd') AS REAL)), 0) AS d
           FROM evolution_log
          WHERE event_type = 'nrs-auto-exec'
            AND date(created_at) = ?`,
      )
      .get(today) as { d: number }
  ).d;

  let remainingBudget = DAILY_CAP_USD - todayDeployed;
  if (remainingBudget <= 0) {
    console.log(`[nrs-exec] daily cap hit ($${todayDeployed.toFixed(0)}/$${DAILY_CAP_USD}); idling`);
    return { checked: 0, executed: 0, skipped: 0, remainingBudget: 0 };
  }

  const opps = handle
    .prepare(
      `SELECT id, summary, payload_json, created_at
         FROM evolution_log
        WHERE event_type = 'near-resolution-opportunity'
          AND created_at >= datetime('now', '-2 hours')
        ORDER BY created_at ASC`,
    )
    .all() as Array<{ id: number; summary: string; payload_json: string; created_at: string }>;
  if (opps.length === 0) return { checked: 0, executed: 0, skipped: 0, remainingBudget };

  const executedRows = handle
    .prepare("SELECT payload_json FROM evolution_log WHERE event_type = 'nrs-auto-exec'")
    .all() as Array<{ payload_json: string }>;
  const executedIds = new Set<number>();
  for (const e of executedRows) {
    try {
      executedIds.add(JSON.parse(e.payload_json).opportunityId);
    } catch {
      /* ignore */
    }
  }

  const router = getDefaultRouter();
  let executed = 0;
  let skipped = 0;

  for (const opp of opps) {
    if (executedIds.has(opp.id)) {
      skipped++;
      continue;
    }
    if (remainingBudget <= 0) break;

    let payload: any;
    try {
      payload = JSON.parse(opp.payload_json);
    } catch (err) {
      console.error(`[nrs-exec] bad payload on opp ${opp.id}: ${(err as Error).message}`);
      skipped++;
      continue;
    }

    const entryPrice = Number(payload.entryPrice);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1) {
      skipped++;
      continue;
    }

    // Sizing logic: edge-proportional, NOT classical Kelly.
    // For near-resolution scrape we have NO probability edge over the market
    // (the market's implied prob ≈ our prob, both ≈ entryPrice). The edge is
    // pure time-decay convergence: price goes from 0.97 → 1.00 by resolution.
    // Kelly assumes p_true ≠ p_market; that doesn't apply here. Instead we
    // scale position by edge magnitude relative to TARGET_EDGE (default 5%).
    // sizeMult = clamp(edge / TARGET_EDGE, 0.1, 1.0)
    const edge = Number(payload.edge ?? 0);
    if (edge <= 0) {
      skipped++;
      continue;
    }
    const sizeMult = Math.min(1, Math.max(0.1, edge / TARGET_EDGE));
    const desiredUsd = Math.min(PER_SIGNAL_USD * sizeMult, remainingBudget);
    if (desiredUsd < 1) {
      skipped++;
      continue;
    }

    const order: UnifiedOrder = {
      clientOrderId: `nrs-${opp.id}-${randomUUID().slice(0, 8)}`,
      venue: VENUE,
      symbol: String(payload.conditionId ?? payload.marketKey ?? ""),
      side: "BUY",
      type: "MARKET",
      size: desiredUsd / entryPrice,
      refPrice: entryPrice,
      capsuleId: CAPSULE_ID,
      metadata: {
        source: "nrs-auto-exec",
        opportunityId: opp.id,
        nrsSide: payload.side,
        daysToResolution: payload.daysToResolution,
        edge,
        annualizedEdge: payload.annualizedEdge,
        sizeMult,
      },
    };

    try {
      const verdict = await router.submit(order);
      const ok = verdict.ok;
      const status = ok && "status" in verdict ? verdict.status : verdict.code;
      console.log(
        `[nrs-exec] opp ${opp.id} → ${status} ${payload.side} @ ${entryPrice.toFixed(3)} ($${desiredUsd.toFixed(0)}, sizeMult=${sizeMult.toFixed(2)})`,
      );
      insertEvolutionEvent({
        event_type: "nrs-auto-exec",
        summary: `NRS auto-exec opp ${opp.id}: ${status} ${payload.side} ${String(payload.marketKey ?? payload.conditionId).slice(0, 24)} @ ${entryPrice.toFixed(3)} ($${desiredUsd.toFixed(0)})`,
        payload_json: JSON.stringify({
          opportunityId: opp.id,
          mode: VENUE,
          orderUsd: desiredUsd,
          sizeMult,
          edge,
          verdict: ok
            ? { status, brokerOrderId: "brokerOrderId" in verdict ? verdict.brokerOrderId : undefined }
            : { status, reason: verdict.reason },
        }),
      });
      executed++;
      remainingBudget -= desiredUsd;
    } catch (err) {
      console.error(`[nrs-exec] opp ${opp.id} threw: ${(err as Error).message}`);
      insertEvolutionEvent({
        event_type: "nrs-auto-exec",
        summary: `NRS auto-exec opp ${opp.id} FAILED`,
        payload_json: JSON.stringify({ opportunityId: opp.id, error: (err as Error).message }),
      });
      executed++;
    }
  }
  return { checked: opps.length, executed, skipped, remainingBudget };
}

async function main(): Promise<void> {
  await pollOnce();
  let stopped = false;
  process.on("SIGINT", () => {
    stopped = true;
    console.log("[nrs-exec] stopping (SIGINT)");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stopped = true;
    process.exit(0);
  });
  while (!stopped) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      await pollOnce();
    } catch (e) {
      console.error("[nrs-exec] poll error:", e);
    }
  }
}

if (process.argv[1]?.endsWith("worker-near-resolution-exec.ts")) {
  main().catch((err) => {
    console.error("[nrs-exec] FATAL:", err);
    process.exit(1);
  });
}
