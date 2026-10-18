import { checkOrder as capsuleCheck } from "@/lib/capsules/gate";
import { applyFillToCapsule } from "@/lib/capsules/journal";
import { getCapsule, updateRealtime as updateCapsuleRealtime } from "@/lib/capsules/store";
import { db } from "@/lib/db/client";
import { insertEvolutionEvent } from "@/lib/db/queries";
import { emptyPortfolio, getDefaultRiskEngine, type RiskEngine } from "@/lib/risk/engine";
import { getDefaultKillSwitch, type KillSwitch } from "@/lib/risk/kill-switch";
import type { PortfolioSnapshot } from "@/lib/risk/types";
import { CoinbaseAdapter } from "./adapters/coinbase";
import { PolymarketAdapter } from "./adapters/polymarket";
import { SimAdapter } from "./adapters/sim";
import { appendOrderEvent } from "./order-events";
import type { SubmitVerdict, UnifiedOrder, VenueAdapter } from "./types";

/**
 * ExecutionRouter — single submit entry point for every venue.
 *
 * Ported from TradingBot/src/execution/router.py, narrowed to the gates that
 * matter for this workspace:
 *   1. Idempotency (clientOrderId dedup, in-memory)
 *   2. Global halt gate (KillSwitch / RiskEngine.halted)
 *   3. Capsule gate (per-agent risk envelope, optional)
 *   4. Global RiskEngine.check (notional, daily loss, rate, concentration)
 *   5. Adapter.submit (venue-specific safety gates still apply on top — they
 *      pre-date the router and stay the source of truth for per-venue caps)
 *
 * Every gate decision writes to the append-only hash-chained order_events
 * table for an auditable execution trail. Adapters auto-register with the
 * kill switch so haltAll() cancels every venue's open orders.
 */
export class ExecutionRouter {
  private adapters = new Map<string, VenueAdapter>();
  private orders = new Map<string, UnifiedOrder>(); // clientOrderId → order
  private lastSubmitAt = new Map<string, number>(); // (capsuleId|symbol|side) → ms
  readonly riskEngine: RiskEngine;
  readonly killSwitch: KillSwitch;

  constructor(opts: { riskEngine?: RiskEngine; killSwitch?: KillSwitch } = {}) {
    this.riskEngine = opts.riskEngine ?? getDefaultRiskEngine();
    this.killSwitch = opts.killSwitch ?? getDefaultKillSwitch();
  }

  // ---------------------------------------------------------------- registration

  registerAdapter(adapter: VenueAdapter): void {
    this.adapters.set(adapter.name, adapter);
    // Auto-register with the kill switch so haltAll() reaches this venue.
    this.killSwitch.registerBroker({
      name: adapter.name,
      cancelOpenOrders: () => adapter.cancelAll(),
    });
  }

  getAdapter(venue: string): VenueAdapter | undefined {
    return this.adapters.get(venue);
  }

  registeredVenues(): string[] {
    return Array.from(this.adapters.keys());
  }

  // ---------------------------------------------------------------- submit

  async submit(order: UnifiedOrder): Promise<SubmitVerdict> {
    // 1. Idempotency
    const existingOrder = this.orders.get(order.clientOrderId);
    if (existingOrder) {
      return {
        ok: false,
        code: "DUPLICATE_CLIENT_ORDER_ID",
        reason: `clientOrderId ${order.clientOrderId} already submitted`,
      };
    }
    this.orders.set(order.clientOrderId, order);

    // 2. Halt gate
    if (this.riskEngine.isHalted()) {
      const verdict: SubmitVerdict = {
        ok: false,
        code: "HALTED",
        reason: `Trading halted: ${this.riskEngine.getHaltReason() || "kill switch engaged"}`,
      };
      this.logEvent("rejected_halt", order, verdict);
      return verdict;
    }

    // 3. Capsule gate (optional — only when order is bound to a capsule)
    if (order.capsuleId) {
      const capsule = getCapsule(order.capsuleId);
      if (!capsule) {
        const verdict: SubmitVerdict = {
          ok: false,
          code: "CAPSULE_NOT_FOUND",
          reason: `capsule ${order.capsuleId} not found`,
        };
        this.logEvent("rejected_capsule", order, verdict);
        return verdict;
      }
      const cooldownKey = `${order.capsuleId}|${order.symbol}|${order.side}`;
      const lastAt = this.lastSubmitAt.get(cooldownKey);
      const secondsSinceLastTrade = lastAt != null ? (Date.now() - lastAt) / 1000 : undefined;
      const capCheck = capsuleCheck({
        capsule,
        venue: order.venue,
        symbol: order.symbol,
        side: order.side,
        qty: order.size,
        refPrice: order.refPrice,
        secondsSinceLastTrade,
      });
      if (!capCheck.ok) {
        const verdict: SubmitVerdict = {
          ok: false,
          code: capCheck.code,
          reason: capCheck.reason,
        };
        this.logEvent("rejected_capsule", order, verdict);
        return verdict;
      }
    }

    // 4. Global risk engine
    const portfolio = await this.snapshotPortfolio(order);
    const riskResult = this.riskEngine.check({
      symbol: order.symbol,
      side: order.side,
      qty: order.size,
      price: order.refPrice,
      portfolio,
    });
    if (!riskResult.ok) {
      const verdict: SubmitVerdict = {
        ok: false,
        code: `RISK_${riskResult.code}`,
        reason: riskResult.message,
      };
      this.logEvent("rejected_risk", order, verdict);
      return verdict;
    }

    // 5. Adapter dispatch
    const adapter = this.adapters.get(order.venue);
    if (!adapter) {
      const verdict: SubmitVerdict = {
        ok: false,
        code: "NO_ADAPTER",
        reason: `no adapter registered for venue=${order.venue}`,
      };
      this.logEvent("rejected_no_adapter", order, verdict);
      return verdict;
    }
    if (!adapter.isAvailable()) {
      const verdict: SubmitVerdict = {
        ok: false,
        code: "ADAPTER_UNAVAILABLE",
        reason: `adapter=${order.venue} reports not available (missing creds?)`,
      };
      this.logEvent("rejected_no_adapter", order, verdict);
      return verdict;
    }

    // Capability gate — short-circuit instead of letting an adapter throw on
    // a feature it doesn't implement. Mirrors ccxt's `has[methodName]` check.
    const need =
      order.type === "MARKET" ? "market" :
      order.type === "LIMIT"  ? "limit"  :
      order.type === "FOK_BASKET" ? "fok" : null;
    if (need && !adapter.capabilities[need]) {
      const verdict: SubmitVerdict = {
        ok: false,
        code: "UNSUPPORTED",
        reason: `adapter=${order.venue} does not support type=${order.type}`,
      };
      this.logEvent("rejected_unsupported", order, verdict);
      return verdict;
    }

    this.logEvent("submitting", order);
    // Record submit ts before adapter call so a slow venue can't backdate cooldowns.
    if (order.capsuleId) {
      this.lastSubmitAt.set(`${order.capsuleId}|${order.symbol}|${order.side}`, Date.now());
    }

    let verdict: SubmitVerdict;
    try {
      verdict = await adapter.submit(order);
    } catch (err) {
      verdict = {
        ok: false,
        code: "ADAPTER_ERROR",
        reason: `adapter ${order.venue} threw: ${(err as Error).message}`,
      };
    }

    const event =
      verdict.ok && "status" in verdict && verdict.status === "dry_run"
        ? "dry_run"
        : verdict.ok
          ? `status_${verdict.status}`
          : `rejected_adapter`;
    this.logEvent(event, order, verdict);

    // Journal the fill onto the bound capsule so its realtime fields
    // (daily_pnl_usd, capital_deployed_usd, trades_today, open_position_*)
    // actually move. Without this the capsule DAILY_LOSS cap never trips.
    // Skipped for dry-runs and rejections; only real fills count.
    this.journalToCapsule(order, verdict);

    // Record what cross-wallet / strategy signals were visible at decision
    // time. This is audit + future ML training data ("did orders submitted
    // alongside a consensus signal outperform isolated ones?"). Fire-and-
    // forget — never blocks trading.
    this.recordSignalSnapshot(order, verdict);

    return verdict;
  }

  /**
   * Capture cross-wallet + strategy signals visible at decision time for any
   * successfully-routed order. Writes one `order-context-snapshot` event per
   * order with counts + samples of relevant signals scoped to this symbol.
   *
   * - Skipped for rejections, dry-runs, and adapter-no-status responses.
   * - Never throws — wrapped in try/catch with stderr logging only.
   * - DB-lookup is bounded (5 consensus, 5 opps, 10 trade-classifications
   *   matching the symbol) so the query cost stays predictable.
   */
  private recordSignalSnapshot(order: UnifiedOrder, verdict: SubmitVerdict): void {
    if (!verdict.ok) return;
    if (!("status" in verdict)) return;
    if (verdict.status === "dry_run") return;
    try {
      const handle = db();
      const symbol = String(order.symbol);
      const symbolLike = `%${symbol}%`;

      const consensusRows = handle
        .prepare(
          `SELECT payload_json FROM evolution_log
            WHERE event_type = 'consensus-signal'
              AND created_at >= datetime('now', '-1 hour')
              AND payload_json LIKE ?
            ORDER BY created_at DESC LIMIT 5`,
        )
        .all(symbolLike) as Array<{ payload_json: string }>;
      const oppRows = handle
        .prepare(
          `SELECT event_type, payload_json FROM evolution_log
            WHERE event_type IN ('near-resolution-opportunity', 'cross-timeframe-spread', 'orderbook-imbalance-signal')
              AND created_at >= datetime('now', '-30 minutes')
              AND payload_json LIKE ?
            ORDER BY created_at DESC LIMIT 5`,
        )
        .all(symbolLike) as Array<{ event_type: string; payload_json: string }>;
      const tcRows = handle
        .prepare(
          `SELECT payload_json FROM evolution_log
            WHERE event_type = 'wallet-trade-classified'
              AND created_at >= datetime('now', '-15 minutes')
              AND payload_json LIKE ?
            ORDER BY created_at DESC LIMIT 10`,
        )
        .all(symbolLike) as Array<{ payload_json: string }>;

      function safeParse(s: string): any {
        try { return JSON.parse(s); } catch { return null; }
      }

      insertEvolutionEvent({
        event_type: "order-context-snapshot",
        summary: `snapshot ${order.clientOrderId}: ${consensusRows.length} consensus / ${oppRows.length} opps / ${tcRows.length} trade-class on ${symbol.slice(0, 18)}`,
        payload_json: JSON.stringify({
          clientOrderId: order.clientOrderId,
          venue: order.venue,
          symbol,
          side: order.side,
          size: order.size,
          refPrice: order.refPrice,
          agentId: order.agentId,
          strategyId: order.strategyId,
          capsuleId: order.capsuleId,
          counts: {
            consensus: consensusRows.length,
            opportunities: oppRows.length,
            tradeClassifications: tcRows.length,
          },
          consensusSample: consensusRows[0] ? safeParse(consensusRows[0].payload_json) : null,
          opportunitySample: oppRows[0]
            ? { type: oppRows[0].event_type, payload: safeParse(oppRows[0].payload_json) }
            : null,
        }),
      });
    } catch (err) {
      console.error(`[router] signal snapshot failed: ${(err as Error).message}`);
    }
  }

  private journalToCapsule(order: UnifiedOrder, verdict: SubmitVerdict): void {
    if (!order.capsuleId) return;
    if (!verdict.ok) return;
    if (!("status" in verdict)) return;
    if (verdict.status === "dry_run") return;
    if (verdict.status !== "filled" && verdict.status !== "partially_filled") return;
    try {
      const capsule = getCapsule(order.capsuleId);
      if (!capsule) return;
      const patch = applyFillToCapsule(capsule, {
        side: order.side,
        qty: order.size,
        price: order.refPrice,
        usdEquivalent: "usdEquivalent" in verdict ? verdict.usdEquivalent : order.refPrice * order.size,
      });
      const { realized_pnl_usd: _ignored, ...storePatch } = patch;
      updateCapsuleRealtime(order.capsuleId, storePatch);
    } catch (err) {
      // Audit, never block trading.
      console.error(`[router] capsule journal failed for ${order.capsuleId}: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- queries

  getOrder(clientOrderId: string): UnifiedOrder | undefined {
    return this.orders.get(clientOrderId);
  }

  listOrders(limit = 100): UnifiedOrder[] {
    return Array.from(this.orders.values()).slice(-limit).reverse();
  }

  async health(): Promise<Array<{ ok: boolean; name: string; details?: Record<string, unknown> }>> {
    const out: Array<{ ok: boolean; name: string; details?: Record<string, unknown> }> = [];
    for (const a of this.adapters.values()) {
      if (a.health) out.push(await a.health());
      else out.push({ ok: a.isAvailable(), name: a.name });
    }
    return out;
  }

  // ---------------------------------------------------------------- internals

  private logEvent(event: string, order: UnifiedOrder, verdict?: SubmitVerdict): void {
    try {
      appendOrderEvent({
        event,
        venue: order.venue,
        clientOrderId: order.clientOrderId,
        brokerOrderId: verdict && verdict.ok && "brokerOrderId" in verdict ? (verdict.brokerOrderId ?? undefined) : undefined,
        capsuleId: order.capsuleId,
        agentId: order.agentId,
        symbol: order.symbol,
        side: order.side,
        qty: order.size,
        price: order.refPrice,
        status: verdict
          ? verdict.ok
            ? "status" in verdict
              ? verdict.status
              : "ok"
            : verdict.code
          : "pending",
        error: verdict && !verdict.ok ? verdict.reason : undefined,
        metadata: {
          type: order.type,
          ...(order.metadata ?? {}),
          ...(verdict && verdict.ok && "usdEquivalent" in verdict ? { usd_equivalent: verdict.usdEquivalent } : {}),
        },
      });
    } catch (err) {
      // Audit failures must never block trading. Surface to stderr only.
      console.error(`[router] failed to append order event: ${(err as Error).message}`);
    }
  }

  private async snapshotPortfolio(_order: UnifiedOrder): Promise<PortfolioSnapshot> {
    // v1: empty portfolio. Adapter-level position queries are wired in the
    // reconciler; once that's running on a schedule, this can pull the most
    // recent reconciled snapshot from order_events / capsules realtime fields.
    return emptyPortfolio();
  }
}

// ------------------------------------------------------------------- singleton

let defaultRouter: ExecutionRouter | null = null;

/**
 * Returns the singleton router pre-wired with both adapters. Lazy because
 * importing the Polymarket adapter pulls in @polymarket/clob-client / ethers
 * (heavy) and we want the cost to be opt-in.
 */
export function getDefaultRouter(): ExecutionRouter {
  if (defaultRouter) return defaultRouter;
  const router = new ExecutionRouter();
  router.registerAdapter(new SimAdapter());
  router.registerAdapter(new PolymarketAdapter());
  router.registerAdapter(new CoinbaseAdapter());
  defaultRouter = router;
  return defaultRouter;
}

export function resetDefaultRouterForTests(): void {
  defaultRouter = null;
}
