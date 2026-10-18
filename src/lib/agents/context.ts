/**
 * AgentContext — the safety + history snapshot every evaluator/agent gets
 * when it's about to make a decision.
 *
 * Why this exists: until now, evaluators had access to fresh market signals
 * but ZERO visibility into safety state. They could happily propose a spec
 * that immediately hits CAPSULE_NOT_ACTIVE, RISK_DAILY_LOSS, or HALTED at
 * submit time. That's a silent failure mode and an audit-trail mess.
 *
 * The context surfaces:
 *   - Capsules bound to this agent (status, headroom, daily PnL)
 *   - Current global risk limits + halt state
 *   - Last 20 order_events for the venues the agent might trade on
 *   - Last 20 evolution_log events for THIS strategy (so an agent doesn't
 *     re-propose a recently-rejected mutation)
 *   - Last backtest score on the current version
 *   - Sampled performance metrics
 *
 * Designed to be cheap (one snapshot per evaluator pass) and JSON-serializable
 * so an LLM evaluator can stringify it into its prompt without surgery.
 */
import { db } from "@/lib/db/client";
import { listCapsules } from "@/lib/capsules/store";
import type { Capsule } from "@/lib/capsules/types";
import { getDefaultKillSwitch } from "@/lib/risk/kill-switch";
import { getDefaultRouter } from "@/lib/venue/router";
import type { RiskLimits } from "@/lib/risk/types";
import { listOrderEvents, type OrderEventRow } from "@/lib/venue/order-events";

export type EvolutionEventRow = {
  id: number;
  event_type: string;
  summary: string;
  payload_json: string;
  created_at: string;
};

export type PerformanceMetricRow = {
  window: string;
  trades_count: number;
  win_rate: number | null;
  total_pnl_usd: number | null;
  max_drawdown_usd: number | null;
  computed_at: string;
};

/**
 * Compact view of a wallet-typology event (latest classification per wallet).
 * Surfaces the bucket + copyability class so agents know which wallets are
 * potentially-copyable vs un-copyable HFT.
 */
export type TypologyEventBrief = {
  wallet: string;
  primaryBucket: string;
  copyabilityClass: string;
  realizedPnlUsd: number;
  portfolioValueUsd: number | null;
  confidence: number;
  ts: string;
};

/**
 * Compact view of a cross-wallet consensus signal — N tracked wallets agreeing
 * on a market+direction within a window.
 */
export type ConsensusEventBrief = {
  marketKey: string;
  marketTitle?: string;
  direction: string;
  effectiveWallets: number;
  combinedTrust: number;
  combinedUsd: number;
  avgPrice: number;
  ts: string;
};

/**
 * Compact view of a per-trade classification event from the observer worker.
 */
export type TradeClassificationBrief = {
  wallet: string;
  marketKey: string;
  side: "BUY" | "SELL";
  direction: string;
  price: number;
  usd: number;
  intent: string;
  topDriver: string;
  ts: string;
};

/**
 * Compact view of a strategy-opportunity signal emitted by one of the new
 * scanners (near-resolution, cross-timeframe spread, orderbook imbalance).
 */
export type StrategyOpportunityBrief = {
  type: "near-resolution" | "cross-timeframe-spread" | "orderbook-imbalance";
  marketKey: string;
  marketTitle?: string;
  side?: "YES" | "NO" | "BUY" | "SELL";
  edge: number;
  annualizedEdge?: number;
  signalStrength?: number;
  reason: string;
  ts: string;
};

export type AgentContext = {
  /** ISO timestamp when the context was built. */
  builtAt: string;
  /** Agent + strategy identity. */
  agentId: number | null;
  strategyId: number;
  /** Capsules attached to this agent (empty array if none). */
  capsules: Capsule[];
  /** Subset of capsules currently active for paper or live trading. */
  activeCapsules: Capsule[];
  /** Global risk limits in effect right now. */
  riskLimits: RiskLimits;
  /** Halt + registered-broker state. */
  killSwitch: {
    halted: boolean;
    reason: string;
    haltedAt: string | null;
    registeredBrokers: string[];
  };
  /** Most recent rejection from the global RiskEngine (null if none this lifetime). */
  lastRejection: { code: string; message: string } | null;
  /** Most recent order_events (default 20) — useful for noticing recent rejects. */
  recentOrderEvents: OrderEventRow[];
  /** Counts of recent rejected_* events by code (so the agent can see "I keep tripping X"). */
  recentRejectCounts: Record<string, number>;
  /** Last N evolution_log events for THIS strategy (proposal / promotion / backtest / stage-change). */
  recentEvolution: EvolutionEventRow[];
  /** Last backtest summary persisted for the current version. */
  lastBacktest: { window: string; score: number | null; pnlUsd: number | null; maxDrawdownUsd: number | null; computedAt: string } | null;
  /** Per-window perf metrics for the current version. */
  performance: PerformanceMetricRow[];

  // --- New signal arrays (2026-05-26) — bounded slices of evolution_log
  // grouped by event_type. Always defined (empty array when no events).

  /** Latest typology per wallet — agents can see which wallets are copyable. */
  recentTypologies: TypologyEventBrief[];
  /** Recent cross-wallet consensus signals in the last hour. */
  recentConsensusSignals: ConsensusEventBrief[];
  /** Per-trade classifications from the observer worker (last 15 min). */
  recentTradeClassifications: TradeClassificationBrief[];
  /** Strategy-opportunity signals from the new scanners (last 30 min). */
  recentStrategyOpportunities: StrategyOpportunityBrief[];
};

export type BuildContextOptions = {
  agentId?: number | null;
  eventLimit?: number;        // default 20
  orderEventLimit?: number;   // default 20
  /** Cap on each of the new signal arrays. Default 20. */
  signalLimit?: number;
};

function loadTypologies(handle: ReturnType<typeof db>, limit: number): TypologyEventBrief[] {
  // Order by created_at DESC then id DESC so two events with the same
  // datetime('now') second are still returned newest-insert-first.
  const rows = handle
    .prepare(
      `SELECT payload_json, created_at FROM evolution_log
        WHERE event_type = 'wallet-typology'
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(Math.max(limit * 4, 80)) as Array<{ payload_json: string; created_at: string }>;
  // Dedupe by wallet — most recent per wallet wins.
  const seen = new Set<string>();
  const out: TypologyEventBrief[] = [];
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload_json);
      if (!p?.wallet || seen.has(p.wallet)) continue;
      seen.add(p.wallet);
      out.push({
        wallet: p.wallet,
        primaryBucket: p.primaryBucket,
        copyabilityClass: p.copyabilityClass,
        realizedPnlUsd: Number(p.features?.realizedPnlUsd ?? 0),
        portfolioValueUsd: p.features?.portfolioValueUsd ?? null,
        confidence: Number(p.confidence ?? 0),
        ts: r.created_at,
      });
      if (out.length >= limit) break;
    } catch {
      /* ignore parse errors */
    }
  }
  return out;
}

function loadConsensusSignals(handle: ReturnType<typeof db>, limit: number): ConsensusEventBrief[] {
  const rows = handle
    .prepare(
      `SELECT payload_json, created_at FROM evolution_log
        WHERE event_type = 'consensus-signal'
          AND created_at >= datetime('now', '-1 hour')
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(limit) as Array<{ payload_json: string; created_at: string }>;
  const out: ConsensusEventBrief[] = [];
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload_json);
      if (!p?.marketKey) continue;
      out.push({
        marketKey: p.marketKey,
        marketTitle: p.marketTitle,
        direction: p.direction ?? "",
        effectiveWallets: Number(p.effectiveWallets ?? p.walletCount ?? p.wallets?.length ?? 0),
        combinedTrust: Number(p.combinedTrust ?? 0),
        combinedUsd: Number(p.combinedUsd ?? 0),
        avgPrice: Number(p.avgPrice ?? 0),
        ts: r.created_at,
      });
    } catch {
      /* ignore */
    }
  }
  return out.sort((a, b) => b.effectiveWallets - a.effectiveWallets || b.combinedTrust - a.combinedTrust);
}

function loadTradeClassifications(handle: ReturnType<typeof db>, limit: number): TradeClassificationBrief[] {
  const rows = handle
    .prepare(
      `SELECT payload_json, created_at FROM evolution_log
        WHERE event_type = 'wallet-trade-classified'
          AND created_at >= datetime('now', '-15 minutes')
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(limit) as Array<{ payload_json: string; created_at: string }>;
  const out: TradeClassificationBrief[] = [];
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload_json);
      if (!p?.wallet || !p?.trade) continue;
      out.push({
        wallet: p.wallet,
        marketKey: p.trade.marketKey,
        side: (p.trade.side ?? "BUY") as "BUY" | "SELL",
        direction: p.trade.direction ?? "",
        price: Number(p.trade.price ?? 0),
        usd: Number(p.trade.usd ?? 0),
        intent: p.intent?.label ?? "",
        topDriver: p.features?.likelyDrivers?.[0] ?? "",
        ts: r.created_at,
      });
    } catch {
      /* ignore */
    }
  }
  return out;
}

function loadStrategyOpportunities(
  handle: ReturnType<typeof db>,
  limit: number,
): StrategyOpportunityBrief[] {
  const rows = handle
    .prepare(
      `SELECT event_type, payload_json, created_at FROM evolution_log
        WHERE event_type IN ('near-resolution-opportunity', 'cross-timeframe-spread', 'orderbook-imbalance-signal')
          AND created_at >= datetime('now', '-30 minutes')
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(limit) as Array<{ event_type: string; payload_json: string; created_at: string }>;
  const typeMap: Record<string, StrategyOpportunityBrief["type"]> = {
    "near-resolution-opportunity": "near-resolution",
    "cross-timeframe-spread": "cross-timeframe-spread",
    "orderbook-imbalance-signal": "orderbook-imbalance",
  };
  const out: StrategyOpportunityBrief[] = [];
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload_json);
      if (!p?.marketKey) continue;
      out.push({
        type: typeMap[r.event_type] ?? "near-resolution",
        marketKey: p.marketKey,
        marketTitle: p.marketTitle,
        side: p.side,
        edge: Number(p.edge ?? 0),
        annualizedEdge: p.annualizedEdge != null ? Number(p.annualizedEdge) : undefined,
        signalStrength: p.signalStrength != null ? Number(p.signalStrength) : undefined,
        reason: String(p.reason ?? ""),
        ts: r.created_at,
      });
    } catch {
      /* ignore */
    }
  }
  return out.sort((a, b) => b.edge - a.edge);
}

export function buildAgentContext(strategyId: number, opts: BuildContextOptions = {}): AgentContext {
  const handle = db();
  // Resolve agent ID from strategy if not provided
  const row = handle
    .prepare("SELECT agent_id FROM strategies WHERE id = ?")
    .get(strategyId) as { agent_id: number } | undefined;
  const agentId = opts.agentId ?? row?.agent_id ?? null;

  // Make sure adapters are registered with the kill switch
  getDefaultRouter();
  const ks = getDefaultKillSwitch();
  const ksState = ks.getState();

  // Capsules — bound to this agent
  const capsules = agentId != null ? listCapsules({ agentId }) : [];
  const activeCapsules = capsules.filter((c) => c.status === "paper" || c.status === "live");

  // Recent order events (across all venues — small enough to scan)
  const orderEventLimit = opts.orderEventLimit ?? 20;
  const recentOrderEvents = listOrderEvents({ limit: orderEventLimit });

  // Aggregate reject counts by code (the code is stored in the `error` field
  // for rejections; the event field starts with "rejected_").
  const recentRejectCounts: Record<string, number> = {};
  for (const e of recentOrderEvents) {
    if (!e.event.startsWith("rejected_")) continue;
    const code = e.status ?? e.event;
    recentRejectCounts[code] = (recentRejectCounts[code] ?? 0) + 1;
  }

  // Recent evolution events for this strategy
  const eventLimit = opts.eventLimit ?? 20;
  const recentEvolution = handle
    .prepare(
      `SELECT id, event_type, summary, payload_json, created_at
         FROM evolution_log
         WHERE strategy_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
    )
    .all(strategyId, eventLimit) as EvolutionEventRow[];

  // Last backtest summary for the current version
  const currentVersion = handle
    .prepare("SELECT id, backtest_summary FROM strategy_versions WHERE strategy_id = ? AND is_current = 1")
    .get(strategyId) as { id: number; backtest_summary: string | null } | undefined;
  let lastBacktest: AgentContext["lastBacktest"] = null;
  if (currentVersion) {
    const perfRow = handle
      .prepare(
        `SELECT window, total_pnl_usd, max_drawdown_usd, computed_at
           FROM performance_metrics
           WHERE strategy_version_id = ? AND window = 'backtest'
           ORDER BY computed_at DESC
           LIMIT 1`,
      )
      .get(currentVersion.id) as { window: string; total_pnl_usd: number | null; max_drawdown_usd: number | null; computed_at: string } | undefined;
    if (perfRow) {
      let score: number | null = null;
      try {
        const parsed = currentVersion.backtest_summary ? JSON.parse(currentVersion.backtest_summary) : null;
        score = parsed?.result?.score ?? parsed?.score ?? null;
      } catch (e) {
        console.error(`[agent-context] backtest_summary parse failed for strategy ${strategyId}:`, (e as Error).message);
      }
      lastBacktest = {
        window: perfRow.window,
        score,
        pnlUsd: perfRow.total_pnl_usd,
        maxDrawdownUsd: perfRow.max_drawdown_usd,
        computedAt: perfRow.computed_at,
      };
    }
  }

  // Per-window perf metrics
  const performance = currentVersion
    ? (handle
        .prepare(
          `SELECT window, trades_count, win_rate, total_pnl_usd, max_drawdown_usd, computed_at
             FROM performance_metrics
             WHERE strategy_version_id = ?
             ORDER BY computed_at DESC`,
        )
        .all(currentVersion.id) as PerformanceMetricRow[])
    : [];

  const signalLimit = opts.signalLimit ?? 20;
  const recentTypologies = loadTypologies(handle, signalLimit);
  const recentConsensusSignals = loadConsensusSignals(handle, signalLimit);
  const recentTradeClassifications = loadTradeClassifications(handle, Math.max(signalLimit, 30));
  const recentStrategyOpportunities = loadStrategyOpportunities(handle, signalLimit);

  return {
    builtAt: new Date().toISOString(),
    agentId,
    strategyId,
    capsules,
    activeCapsules,
    riskLimits: ks.riskEngine.getLimits(),
    killSwitch: {
      halted: ksState.halted,
      reason: ksState.reason,
      haltedAt: ksState.haltedAt,
      registeredBrokers: ks.getRegisteredBrokers(),
    },
    lastRejection: ks.riskEngine.getLastRejection(),
    recentOrderEvents,
    recentRejectCounts,
    recentEvolution,
    lastBacktest,
    performance,
    recentTypologies,
    recentConsensusSignals,
    recentTradeClassifications,
    recentStrategyOpportunities,
  };
}

/**
 * Compact one-line summary for log lines. Useful in research-loop output so
 * an operator can see "evaluator running with [halt=no, capsules=2 active,
 * recent rejects: CAPSULE_DAILY_LOSS x3]" without dumping the full JSON.
 */
export function summarizeContext(ctx: AgentContext): string {
  const parts = [
    ctx.killSwitch.halted ? `HALTED(${ctx.killSwitch.reason})` : "halt=no",
    `capsules=${ctx.activeCapsules.length}/${ctx.capsules.length}`,
    `evo=${ctx.recentEvolution.length}`,
  ];
  const topReject = Object.entries(ctx.recentRejectCounts).sort((a, b) => b[1] - a[1])[0];
  if (topReject) parts.push(`reject:${topReject[0]}×${topReject[1]}`);
  if (ctx.lastBacktest?.score != null) parts.push(`bt=${ctx.lastBacktest.score.toFixed(1)}`);
  // New signal counters — short prefixes to keep the line under ~120 chars.
  if (ctx.recentTypologies.length > 0) {
    const counts: Record<string, number> = {};
    for (const t of ctx.recentTypologies) counts[t.primaryBucket] = (counts[t.primaryBucket] ?? 0) + 1;
    const top = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, n]) => `${n}${k.slice(0, 3)}`)
      .join("/");
    parts.push(`typ=${top}`);
  }
  if (ctx.recentConsensusSignals.length > 0) parts.push(`cons=${ctx.recentConsensusSignals.length}`);
  if (ctx.recentTradeClassifications.length > 0) parts.push(`trades=${ctx.recentTradeClassifications.length}`);
  if (ctx.recentStrategyOpportunities.length > 0) parts.push(`opps=${ctx.recentStrategyOpportunities.length}`);
  return `[ctx ${parts.join(" ")}]`;
}
