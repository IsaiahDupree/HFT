/**
 * Arena sim engine — pure decision + bookkeeping functions.
 *
 * `decide(agent, ctx)` is called per agent per tick. It returns a `Signal`.
 * `apply(agent, signal, ctx)` mutates the agent's in-memory state (cash,
 * positions, MtM, drawdown). The caller is responsible for persisting via
 * `persistAgentTick` after the per-agent loop finishes.
 *
 * Convention: prices are in Polymarket "points" (0..1, in points × 100) for
 * sim-poly markets, and dollars for sim-coinbase markets.
 *
 * Fees: simulated 25 bps taker on Coinbase, 0 bps on Polymarket (matches the
 * current fee schedule and is set as a constant — agents don't "know" their
 * fee model, the sim deducts it from realized PnL on exit).
 */
import type { Genome } from "./genome";
import { acceleration, loadRecentCandles, loadRecentCandlesFromCoindesk, velocity, type Candle } from "./momentum";
import { recentFillsForWalletInCategory, walletWinRateByCategory } from "@/lib/wallet/category-stats";
import { peekOracleCache } from "./llm-oracle";
import { assetToFeed, getBinaryMeta, type BinaryAsset } from "./short-binaries";
import { takerFee, makerRebate, type FeeCategory } from "@/lib/strategies/as-market-maker";

/** Map a classifyMarket() category string to a Polymarket V2 fee category. */
function mapFeeCategory(cat?: string): FeeCategory {
  switch (cat) {
    case "elections": case "politics": return "politics";
    case "geopolitics": return "geopolitics";
    case "sports": return "sports";
    case "weather": return "weather";
    case "tech": return "tech";
    case "crypto": case "5min-binary": case "15min-binary": return "crypto";
    case "economics": case "macro": case "finance": return "finance";
    default: return "other";
  }
}
import type {
  LiveAgent, PaperTradeRow, Position, Signal, Snapshot, SnapshotWindow, TickContext, Venue,
} from "./types";
import { runDecisionPipeline } from "@/lib/decision/pipeline";
import { recordDecision } from "@/lib/decision/journal";
import type { DecisionContext } from "@/lib/decision/types";

const CB_TAKER_FEE_BPS = 25;
const POLY_FEE_BPS = 0;

function feeBps(venue: Venue): number {
  return venue === "sim-coinbase" ? CB_TAKER_FEE_BPS : POLY_FEE_BPS;
}

/** Best-effort SHADOW run of the decision gates on a sim ENTRY, so calibration can
 *  later grade their approval_score against the realized PnL of the resulting trade
 *  (entry is stamped with the returned decision_journal.id; the exit carries
 *  realized_pnl via linked_entry_id). Env-gated (ARENA_SHADOW_GATES=1); the
 *  governor gate is skipped (portfolio-level, not per-trade edge); fully non-fatal
 *  — a pipeline failure never blocks the sim. */
function shadowGateEntry(agentId: number, kind: string, venue: string, marketId: string, side: "BUY" | "SELL", sizeUsd: number, price: number, tickAt: string): number | null {
  if (process.env.ARENA_SHADOW_GATES !== "1") return null;
  try {
    const ctx: DecisionContext = {
      agentId,
      capsuleId: `sim-agent-${agentId}`,
      strategyKind: kind,
      proposal: { venue, symbol: marketId, side, sizeUsd, price, conditionId: marketId },
      snapshot: { midPrice: price },
      ts: tickAt,
    };
    return recordDecision(ctx, runDecisionPipeline(ctx, { skipGovernor: true }));
  } catch {
    return null;
  }
}

function hoursSince(iso: string, now: string): number {
  return (new Date(now).getTime() - new Date(iso).getTime()) / 3_600_000;
}
function minutesSince(iso: string, now: string): number {
  return (new Date(now).getTime() - new Date(iso).getTime()) / 60_000;
}

function nthFromEnd(history: Snapshot[], minutesAgo: number, now: string): Snapshot | undefined {
  const cutoffMs = new Date(now).getTime() - minutesAgo * 60_000;
  // Walk back from newest to find the first snapshot at or before the cutoff.
  for (let i = history.length - 1; i >= 0; i--) {
    if (new Date(history[i].captured_at).getTime() <= cutoffMs) return history[i];
  }
  return history[0];
}

function rollingMax(history: Snapshot[]): number {
  let m = -Infinity;
  for (const s of history) if (s.price > m) m = s.price;
  return m;
}
function rollingMean(history: Snapshot[]): number {
  if (history.length === 0) return 0;
  let s = 0;
  for (const x of history) s += x.price;
  return s / history.length;
}
function rollingStdev(history: Snapshot[]): number {
  if (history.length < 2) return 0;
  const m = rollingMean(history);
  let v = 0;
  for (const x of history) v += (x.price - m) ** 2;
  return Math.sqrt(v / (history.length - 1));
}

// ----------------------------------------------------------------------------
// Per-strategy `decide` implementations.
// ----------------------------------------------------------------------------

function holdSignal(reason = ""): Signal { return { kind: "hold" } as Signal; }

function decidePolyFadeSpike(g: Extract<Genome, { kind: "poly_fade_spike" }>, agent: LiveAgent, ctx: TickContext): Signal {
  // Pick the first POLY market we have history on (sim picks the universe).
  for (const [mid, win] of ctx.snapshots) {
    if (win.latest.venue !== "sim-poly") continue;
    const lookbackPriceSnap = nthFromEnd(win.history, g.params.lookback_h * 60, ctx.now);
    const confirmSnap = nthFromEnd(win.history, g.params.confirm_quiet_h * 60, ctx.now);
    if (!lookbackPriceSnap || !confirmSnap) continue;
    const ptsMoveOverLookback = (win.latest.price - lookbackPriceSnap.price) * 100; // poly prices are 0..1, points = ×100
    const ptsMoveSinceQuiet = Math.abs((win.latest.price - confirmSnap.price) * 100);
    const alreadyIn = agent.positions.some((p) => p.market_id === mid);
    if (alreadyIn) continue;
    if (Math.abs(ptsMoveOverLookback) >= g.params.threshold_pts && ptsMoveSinceQuiet <= g.params.threshold_pts / 2) {
      const fadeSide = ptsMoveOverLookback > 0 ? "SELL" : "BUY";
      const target = fadeSide === "BUY"
        ? win.latest.price + g.params.exit_target_pts / 100
        : win.latest.price - g.params.exit_target_pts / 100;
      const stop = fadeSide === "BUY"
        ? win.latest.price - g.params.stop_pts / 100
        : win.latest.price + g.params.stop_pts / 100;
      return {
        kind: "entry",
        venue: "sim-poly",
        market_id: mid,
        side: fadeSide,
        size_usd: Math.min(g.params.entry_size_usd, agent.cash_usd_current),
        rationale: `fade ${ptsMoveOverLookback.toFixed(1)}pt move over ${g.params.lookback_h}h`,
        target_price: target,
        stop_price: stop,
        time_stop_at: new Date(new Date(ctx.now).getTime() + g.params.time_stop_h * 3_600_000).toISOString(),
      };
    }
  }
  return holdSignal();
}

function decidePolyBreakout(g: Extract<Genome, { kind: "poly_breakout" }>, agent: LiveAgent, ctx: TickContext): Signal {
  for (const [mid, win] of ctx.snapshots) {
    if (win.latest.venue !== "sim-poly") continue;
    if (agent.positions.some((p) => p.market_id === mid)) continue;
    const lookbackMin = g.params.lookback_h * 60;
    const inWindow = win.history.filter((s) => minutesSince(s.captured_at, ctx.now) <= lookbackMin);
    if (inWindow.length < 4) continue;
    const recentMax = rollingMax(inWindow);
    if (win.latest.price > recentMax * g.params.breakout_mult) {
      const target = win.latest.price + g.params.target_pts / 100;
      const stop = win.latest.price - g.params.stop_pts / 100;
      return {
        kind: "entry", venue: "sim-poly", market_id: mid, side: "BUY",
        size_usd: Math.min(g.params.entry_size_usd, agent.cash_usd_current),
        rationale: `breakout above ${recentMax.toFixed(3)} × ${g.params.breakout_mult}`,
        target_price: target, stop_price: stop,
        time_stop_at: new Date(new Date(ctx.now).getTime() + g.params.time_stop_h * 3_600_000).toISOString(),
      };
    }
  }
  return holdSignal();
}

function decideCbBreakout(g: Extract<Genome, { kind: "cb_breakout" }>, agent: LiveAgent, ctx: TickContext): Signal {
  const win = ctx.snapshots.get(g.params.product_id);
  if (!win) return holdSignal();
  if (agent.positions.some((p) => p.market_id === g.params.product_id)) return holdSignal();
  const lookbackMin = g.params.lookback_min;
  const inWindow = win.history.filter((s) => minutesSince(s.captured_at, ctx.now) <= lookbackMin);
  if (inWindow.length < 4) return holdSignal();
  const recentMax = rollingMax(inWindow);
  if (win.latest.price > recentMax * g.params.breakout_mult) {
    return {
      kind: "entry", venue: "sim-coinbase", market_id: g.params.product_id, side: "BUY",
      size_usd: Math.min(g.params.entry_size_usd, agent.cash_usd_current),
      rationale: `cb breakout above ${recentMax.toFixed(2)} × ${g.params.breakout_mult}`,
      target_price: win.latest.price * (1 + g.params.target_pct),
      stop_price: win.latest.price * (1 - g.params.stop_pct),
      time_stop_at: new Date(new Date(ctx.now).getTime() + g.params.time_stop_min * 60_000).toISOString(),
    };
  }
  return holdSignal();
}

function decideCbMeanReversion(g: Extract<Genome, { kind: "cb_mean_reversion" }>, agent: LiveAgent, ctx: TickContext): Signal {
  const win = ctx.snapshots.get(g.params.product_id);
  if (!win) return holdSignal();
  if (agent.positions.some((p) => p.market_id === g.params.product_id)) return holdSignal();
  const inWindow = win.history.filter((s) => minutesSince(s.captured_at, ctx.now) <= g.params.lookback_min);
  if (inWindow.length < 12) return holdSignal();
  const mean = rollingMean(inWindow);
  const sd = rollingStdev(inWindow);
  if (sd <= 0) return holdSignal();
  const z = (win.latest.price - mean) / sd;
  if (z <= -g.params.z_entry) {
    return {
      kind: "entry", venue: "sim-coinbase", market_id: g.params.product_id, side: "BUY",
      size_usd: Math.min(g.params.entry_size_usd, agent.cash_usd_current),
      rationale: `mean-revert BUY at z=${z.toFixed(2)} (mean=${mean.toFixed(2)})`,
      target_price: mean + g.params.z_exit * sd,
      stop_price: win.latest.price * (1 - g.params.stop_pct),
      time_stop_at: new Date(new Date(ctx.now).getTime() + g.params.time_stop_min * 60_000).toISOString(),
    };
  }
  return holdSignal();
}

function decideCrossVenueArb(g: Extract<Genome, { kind: "cross_venue_arb" }>, agent: LiveAgent, ctx: TickContext): Signal {
  // Requires the caller to populate ctx.bsImpliedProb (BS-implied prob computed
  // off the Coinbase spot + recent realized vol) and ctx.polyImpliedProb. If not
  // populated, hold. Full implementation lives in the cross-venue worker.
  if (!ctx.bsImpliedProb || !ctx.polyImpliedProb) return holdSignal();
  const polyProb = ctx.polyImpliedProb.get(g.params.poly_condition_id);
  const bsProb = ctx.bsImpliedProb.get(g.params.poly_condition_id);
  if (polyProb === undefined || bsProb === undefined) return holdSignal();
  const spreadPts = (polyProb - bsProb) * 100;
  if (Math.abs(spreadPts) < g.params.edge_pts) return holdSignal();
  if (agent.positions.some((p) => p.market_id === g.params.poly_condition_id)) return holdSignal();
  const fadeSide = spreadPts > 0 ? "SELL" : "BUY";
  return {
    kind: "entry", venue: "sim-poly", market_id: g.params.poly_condition_id, side: fadeSide,
    size_usd: Math.min(g.params.entry_size_usd, agent.cash_usd_current),
    rationale: `xv-arb: poly=${(polyProb * 100).toFixed(1)}% vs bs=${(bsProb * 100).toFixed(1)}% → ${spreadPts.toFixed(1)}pt`,
    time_stop_at: new Date(new Date(ctx.now).getTime() + g.params.time_stop_h * 3_600_000).toISOString(),
  };
}

function decideCbMomentumBurst(g: Extract<Genome, { kind: "cb_momentum_burst" }>, agent: LiveAgent, ctx: TickContext): Signal {
  const win = ctx.snapshots.get(g.params.product_id);
  if (!win) return holdSignal();
  if (agent.positions.some((p) => p.market_id === g.params.product_id)) return holdSignal();
  // Pull 1-min candles up to "now" — replay mode uses simulated now.
  const cutoffUnix = Math.floor(new Date(ctx.now).getTime() / 1000);
  const lookbackMin = Math.max(g.params.vel_window_min * 2 + 5, 30);
  const candles = loadRecentCandles(g.params.product_id, lookbackMin, { cutoffUnix });
  if (candles.length < g.params.vel_window_min + 2) return holdSignal();
  const v = velocity(candles, g.params.vel_window_min);
  const a = acceleration(candles, g.params.vel_window_min);
  if (!Number.isFinite(v) || !Number.isFinite(a)) return holdSignal();

  // Long: price rising AND momentum building.
  if (v >= g.params.vel_entry_pct && a >= g.params.accel_min) {
    const px = win.latest.price;
    return {
      kind: "entry", venue: "sim-coinbase", market_id: g.params.product_id, side: "BUY",
      size_usd: Math.min(g.params.entry_size_usd, agent.cash_usd_current),
      rationale: `momentum-burst LONG v=${(v * 100).toFixed(2)}% a=${(a * 100).toFixed(3)}%`,
      target_price: px * (1 + g.params.target_pct),
      stop_price: px * (1 - g.params.stop_pct),
      time_stop_at: new Date(new Date(ctx.now).getTime() + g.params.time_stop_min * 60_000).toISOString(),
    };
  }
  // Short: only when direction_bias allows it. Sells the asset on the way down.
  if (g.params.direction_bias === "long_short" && v <= -g.params.vel_entry_pct && a <= -g.params.accel_min) {
    const px = win.latest.price;
    return {
      kind: "entry", venue: "sim-coinbase", market_id: g.params.product_id, side: "SELL",
      size_usd: Math.min(g.params.entry_size_usd, agent.cash_usd_current),
      rationale: `momentum-burst SHORT v=${(v * 100).toFixed(2)}% a=${(a * 100).toFixed(3)}%`,
      target_price: px * (1 - g.params.target_pct),
      stop_price: px * (1 + g.params.stop_pct),
      time_stop_at: new Date(new Date(ctx.now).getTime() + g.params.time_stop_min * 60_000).toISOString(),
    };
  }
  return holdSignal();
}

function decidePolyMarketMaker(g: Extract<Genome, { kind: "polymarket_market_maker" }>, agent: LiveAgent, ctx: TickContext): Signal {
  // CemeterySun archetype: alternate small BUY/SELL entries on a poly market
  // to collect spread. Side parity from agent.entries_count gives deterministic
  // rebalancing without needing to query trade history.
  // Pick the target token: explicit token_id, or first available liquid market.
  let mid: string | null = null;
  if (g.params.token_id !== "any" && ctx.snapshots.has(g.params.token_id)) {
    mid = g.params.token_id;
  } else {
    for (const [tokenId, win] of ctx.snapshots) {
      if (win.latest.venue !== "sim-poly") continue;
      if (win.latest.price <= 0.05 || win.latest.price >= 0.95) continue;
      mid = tokenId;
      break;
    }
  }
  if (!mid) return holdSignal();
  if (agent.positions.some((p) => p.market_id === mid)) return holdSignal();
  const win = ctx.snapshots.get(mid)!;
  const px = win.latest.price;
  const side: "BUY" | "SELL" = agent.entries_count % 2 === 0 ? "BUY" : "SELL";
  // Fee-aware spread (Polymarket V2): NEVER quote inside the round-trip taker fee,
  // and fold in the maker rebate as positive edge (the handbook's core economics —
  // see src/lib/strategies/as-market-maker.ts). Capture HALF the spread per side.
  const sizeUsd = Math.min(g.params.entry_size_usd, agent.cash_usd_current);
  const cat = mapFeeCategory(win.latest.category);
  const feePerShare = sizeUsd > 0 ? takerFee(px, sizeUsd, cat) / sizeUsd : 0;
  const rebatePerShare = sizeUsd > 0 ? makerRebate(px, sizeUsd, cat) / sizeUsd : 0;
  // half-spread must clear the per-share fee with margin; rebate widens our edge.
  const halfSpread = Math.max(g.params.spread_pts / 200, feePerShare * 1.25) - rebatePerShare;
  if (halfSpread <= 0) return holdSignal(); // can't profit after fees in this market
  const target = side === "BUY" ? px + halfSpread : px - halfSpread;
  const stop = side === "BUY" ? px - g.params.stop_pts / 100 : px + g.params.stop_pts / 100;
  return {
    kind: "entry", venue: "sim-poly", market_id: mid, side,
    size_usd: sizeUsd,
    rationale: `MM-${side}@${px.toFixed(3)} ${cat} δ=${(halfSpread * 100).toFixed(2)}pt fee=${(feePerShare * 100).toFixed(2)} rebate=${(rebatePerShare * 100).toFixed(2)}`,
    target_price: target, stop_price: stop,
    time_stop_at: new Date(new Date(ctx.now).getTime() + g.params.time_stop_h * 3_600_000).toISOString(),
  };
}

function decideLlmProbabilityOracle(g: Extract<Genome, { kind: "llm_probability_oracle" }>, agent: LiveAgent, ctx: TickContext): Signal {
  // Synchronous — reads ONLY the oracle cache. The async warmer
  // (warmOracleCacheForTick) ran before this in the tick loop and may have
  // populated the cache for one market. We scan our candidate markets and
  // attach the cached pTrue to a signal so the P2 EV+Kelly rail can engage.
  for (const [mid, win] of ctx.snapshots) {
    if (win.latest.venue !== "sim-poly") continue;
    if (g.params.category_filter && win.latest.category !== g.params.category_filter) continue;
    if (agent.positions.some((p) => p.market_id === mid)) continue;
    const cached = peekOracleCache(mid, g.params.prompt_version);
    if (!cached) continue;
    if (cached.confidence === "low") continue; // skip low-confidence per article rule 3
    // Default side: BUY if pTrue > pMarket (we believe YES under-priced), else SELL.
    const pMarket = win.latest.price;
    const side: "BUY" | "SELL" = cached.probability > pMarket ? "BUY" : "SELL";
    const size = Math.min(g.params.entry_size_usd, agent.cash_usd_current);
    if (size <= 0) continue;
    return {
      kind: "entry", venue: "sim-poly", market_id: mid, side,
      size_usd: size,
      rationale: `oracle p=${cached.probability.toFixed(2)} (${cached.confidence}) vs mkt=${pMarket.toFixed(2)}`,
      time_stop_at: new Date(new Date(ctx.now).getTime() + 24 * 3_600_000).toISOString(),
      // The P2 rail engages on this and applies the EV gate (genome's
      // min_ev_pct overrides the default 5%) + Quarter Kelly sizing.
      pTrueEstimate: { pTrue: cached.probability, confidence: cached.confidence, source: "llm-oracle" },
    };
  }
  return holdSignal();
}

function decideMultiStrategy(g: Extract<Genome, { kind: "multi_strategy" }>, agent: LiveAgent, ctx: TickContext, rng: () => number): Signal {
  // "Agent picks the strategy" — walk sub-genomes in priority order; return
  // the first non-hold signal. The composite owns the entry size (overrides
  // the sub's requested size with its own entry_size_usd), but inherits
  // venue/market/side/exits from the sub. PRD §6.2.L2.
  for (const sub of g.params.subs) {
    // Construct a temporary agent view scoped to the sub's genome — sim
    // engine reads `agent.genome` in some sub-paths (e.g. for rand). Using
    // the original positions/state but swapping the genome.
    const subAgent: LiveAgent = { ...agent, genome: sub };
    const sig = decideForSub(sub, subAgent, ctx, rng);
    if (sig.kind !== "hold") {
      if (sig.kind === "entry") {
        // Override size with the composite's own entry_size_usd budget,
        // capped by available cash.
        return { ...sig, size_usd: Math.min(g.params.entry_size_usd, agent.cash_usd_current), rationale: `multi/${sub.kind}: ${sig.rationale}` };
      }
      return sig;
    }
  }
  return holdSignal();
}

/** Dispatch a sub-genome to its decide function. Mirrors the main switch but
 *  excludes multi_strategy (no nested composition). */
function decideForSub(g: import("./genome").SubGenome, agent: LiveAgent, ctx: TickContext, rng: () => number): Signal {
  switch (g.kind) {
    case "poly_fade_spike":      return decidePolyFadeSpike(g, agent, ctx);
    case "poly_breakout":        return decidePolyBreakout(g, agent, ctx);
    case "cb_breakout":          return decideCbBreakout(g, agent, ctx);
    case "cb_mean_reversion":    return decideCbMeanReversion(g, agent, ctx);
    case "cross_venue_arb":      return decideCrossVenueArb(g, agent, ctx);
    case "cb_momentum_burst":    return decideCbMomentumBurst(g, agent, ctx);
    case "random_walk_baseline": return decideRandomWalk(g, agent, ctx, rng);
    case "category_specialist":  return decideCategorySpecialist(g, agent, ctx);
    case "wallet_copy_filtered": return decideWalletCopyFiltered(g, agent, ctx);
    case "polymarket_market_maker": return decidePolyMarketMaker(g, agent, ctx);
    case "llm_probability_oracle": return decideLlmProbabilityOracle(g, agent, ctx);
    case "poly_short_binary_directional": return decidePolyShortBinary(g, agent, ctx);
  }
}

function decideWalletCopyFiltered(g: Extract<Genome, { kind: "wallet_copy_filtered" }>, agent: LiveAgent, ctx: TickContext): Signal {
  // Mental Bug #4 guard: refuse to copy if the source's win-rate in the chosen
  // category is below threshold OR if the source has too few trades in that
  // category to make win-rate trustworthy (overfitting).
  const stats = walletWinRateByCategory(g.params.wallet_address, g.params.copy_category, 30);
  if (!stats) return holdSignal();
  if (stats.trades_count < g.params.min_source_trades) return holdSignal();
  if (stats.win_rate < g.params.min_source_win_rate) return holdSignal();

  // Find recent fills the source made in this category within the delay
  // window. Copy the most recent one we don't already hold.
  const fills = recentFillsForWalletInCategory(g.params.wallet_address, g.params.copy_category, g.params.delay_min);
  for (const fill of fills) {
    if (agent.positions.some((p) => p.market_id === fill.token_id)) continue;
    // Skip if no current snapshot for the market (we'd execute at a stale price).
    const win = ctx.snapshots.get(fill.token_id);
    if (!win) continue;
    const sourceSize = fill.size_usd ?? 0;
    if (sourceSize <= 0) continue;
    const desired = sourceSize * g.params.size_pct_of_source;
    const size = Math.min(desired, g.params.max_size_usd, agent.cash_usd_current);
    if (size <= 0) continue;
    return {
      kind: "entry", venue: "sim-poly", market_id: fill.token_id, side: fill.side,
      size_usd: size,
      rationale: `copy ${g.params.wallet_address.slice(0, 8)}… in ${g.params.copy_category} (wr=${(stats.win_rate * 100).toFixed(0)}% over ${stats.trades_count} trades)`,
      time_stop_at: new Date(new Date(ctx.now).getTime() + 24 * 3_600_000).toISOString(),
    };
  }
  return holdSignal();
}

function decideCategorySpecialist(g: Extract<Genome, { kind: "category_specialist" }>, agent: LiveAgent, ctx: TickContext): Signal {
  // Filter poly markets to the chosen category. Inner strategy is either
  // fade-spike (against extended moves) or breakout (with strong moves). The
  // archetype is majorexploiter — laser focus on one category, ignore the rest.
  for (const [mid, win] of ctx.snapshots) {
    if (win.latest.venue !== "sim-poly") continue;
    if (win.latest.category !== g.params.category) continue;
    if (agent.positions.some((p) => p.market_id === mid)) continue;
    if (g.params.inner_strategy === "fade_spike") {
      const lookbackSnap = nthFromEnd(win.history, g.params.lookback_h * 60, ctx.now);
      const confirmSnap = nthFromEnd(win.history, g.params.confirm_quiet_h * 60, ctx.now);
      if (!lookbackSnap || !confirmSnap) continue;
      const ptsMove = (win.latest.price - lookbackSnap.price) * 100;
      const ptsQuiet = Math.abs((win.latest.price - confirmSnap.price) * 100);
      if (Math.abs(ptsMove) >= g.params.threshold_pts && ptsQuiet <= g.params.threshold_pts / 2) {
        const side: "BUY" | "SELL" = ptsMove > 0 ? "SELL" : "BUY";
        const target = side === "BUY"
          ? win.latest.price + g.params.exit_target_pts / 100
          : win.latest.price - g.params.exit_target_pts / 100;
        const stop = side === "BUY"
          ? win.latest.price - g.params.stop_pts / 100
          : win.latest.price + g.params.stop_pts / 100;
        return {
          kind: "entry", venue: "sim-poly", market_id: mid, side,
          size_usd: Math.min(g.params.entry_size_usd, agent.cash_usd_current),
          rationale: `category=${g.params.category} fade ${ptsMove.toFixed(1)}pt`,
          target_price: target, stop_price: stop,
          time_stop_at: new Date(new Date(ctx.now).getTime() + g.params.time_stop_h * 3_600_000).toISOString(),
        };
      }
    } else {
      // breakout
      const inWindow = win.history.filter((s) => minutesSince(s.captured_at, ctx.now) <= g.params.lookback_h * 60);
      if (inWindow.length < 4) continue;
      const recentMax = rollingMax(inWindow);
      if (win.latest.price > recentMax * g.params.breakout_mult) {
        const target = win.latest.price + g.params.exit_target_pts / 100;
        const stop = win.latest.price - g.params.stop_pts / 100;
        return {
          kind: "entry", venue: "sim-poly", market_id: mid, side: "BUY",
          size_usd: Math.min(g.params.entry_size_usd, agent.cash_usd_current),
          rationale: `category=${g.params.category} breakout above ${recentMax.toFixed(3)}×${g.params.breakout_mult}`,
          target_price: target, stop_price: stop,
          time_stop_at: new Date(new Date(ctx.now).getTime() + g.params.time_stop_h * 3_600_000).toISOString(),
        };
      }
    }
  }
  return holdSignal();
}

function decidePolyShortBinary(g: Extract<Genome, { kind: "poly_short_binary_directional" }>, agent: LiveAgent, ctx: TickContext): Signal {
  // Trade Polymarket's rolling 5-min crypto Up-or-Down binaries.
  //
  // Entry rules:
  //   - minutes_to_expiry must be in [pre_cutoff_min, max_window_min] (skip
  //     binaries that are already past the 2-min cutoff and skip ones too
  //     far out to be informative)
  //   - velocity over `vel_window_min` Coinbase 1-min candles must exceed
  //     vel_entry_pct in magnitude
  //   - YES price gate: don't pay through our edge (skip if YES already prices
  //     in the move). Symmetric gate for SELL/NO side.
  //   - size_usd capped by agent cash.
  // Time stop = the binary's expiry (the resolver will then settle PnL).
  const allowed = new Set(g.params.assets.split(",").map((s) => s.trim().toUpperCase()) as BinaryAsset[]);
  const nowMs = new Date(ctx.now).getTime();

  // Per-asset position counter — used to enforce max_positions_per_asset.
  // Looking up metadata for every open position is cheap (indexed PK) and
  // O(n_positions) where n is bounded by the agent's own cap.
  const cap = g.params.max_positions_per_asset ?? 1;
  const openByAsset = new Map<string, number>();
  for (const pos of agent.positions) {
    const m = getBinaryMeta(pos.market_id);
    if (!m) continue;
    openByAsset.set(m.asset, (openByAsset.get(m.asset) ?? 0) + 1);
  }

  // Pre-collect binary candidates with their fresh price & metadata.
  type Candidate = {
    token_id: string;
    mid: number;
    meta: ReturnType<typeof getBinaryMeta>;
    minToExpiry: number;
    feed: { exchange: "coinbase" | "okx"; instrument: string };
  };
  const candidates: Candidate[] = [];
  for (const [tokenId, win] of ctx.snapshots) {
    if (win.latest.venue !== "sim-poly") continue;
    if (!win.latest.category || !win.latest.category.endsWith("-binary")) continue;
    if (agent.positions.some((p) => p.market_id === tokenId)) continue;
    const meta = getBinaryMeta(tokenId);
    if (!meta || meta.settled) continue;
    if (!allowed.has(meta.asset as BinaryAsset)) continue;
    // Per-asset cap — refuse another bet on an asset we already hold N of.
    if ((openByAsset.get(meta.asset) ?? 0) >= cap) continue;
    const feed = assetToFeed(meta.asset as BinaryAsset);
    if (!feed) continue;
    const expMs = new Date(meta.expiry_iso).getTime();
    const minToExpiry = (expMs - nowMs) / 60_000;
    if (minToExpiry < g.params.pre_cutoff_min) continue;
    if (minToExpiry > g.params.max_window_min) continue;
    candidates.push({ token_id: tokenId, mid: win.latest.price, meta, minToExpiry, feed });
  }
  if (candidates.length === 0) return holdSignal();
  // Order by soonest-expiring first — those are the most actionable.
  candidates.sort((a, b) => a.minToExpiry - b.minToExpiry);

  const cutoffUnix = Math.floor(nowMs / 1000);
  const lookbackMin = Math.max(g.params.vel_window_min * 3 + 3, 10);
  for (const c of candidates) {
    const candles: Candle[] = c.feed.exchange === "coinbase"
      ? loadRecentCandles(c.feed.instrument, lookbackMin, { cutoffUnix })
      : loadRecentCandlesFromCoindesk("okx", c.feed.instrument, lookbackMin, { cutoffUnix });
    if (candles.length < g.params.vel_window_min + 1) continue;
    const v = velocity(candles, g.params.vel_window_min);
    if (!Number.isFinite(v)) continue;
    if (Math.abs(v) < g.params.vel_entry_pct) continue;

    const side: "BUY" | "SELL" = v > 0 ? "BUY" : "SELL";
    if (side === "BUY" && c.mid > g.params.max_yes_price_for_buy) continue;
    if (side === "SELL" && c.mid < g.params.min_yes_price_for_sell) continue;

    const size = Math.min(g.params.entry_size_usd, agent.cash_usd_current);
    if (size <= 0) continue;

    return {
      kind: "entry", venue: "sim-poly", market_id: c.token_id, side,
      size_usd: size,
      rationale: `5m-binary ${c.meta!.asset} ${side === "BUY" ? "UP" : "DOWN"} v=${(v * 100).toFixed(3)}% mid=${c.mid.toFixed(3)} ttl=${c.minToExpiry.toFixed(1)}m`,
      time_stop_at: c.meta!.expiry_iso,
    };
  }
  return holdSignal();
}

function decideRandomWalk(g: Extract<Genome, { kind: "random_walk_baseline" }>, agent: LiveAgent, ctx: TickContext, rng: () => number): Signal {
  if (rng() > g.params.trade_prob) return holdSignal();
  const ids = Array.from(ctx.snapshots.keys()).filter((mid) => !agent.positions.some((p) => p.market_id === mid));
  if (ids.length === 0) return holdSignal();
  const mid = ids[Math.floor(rng() * ids.length)];
  const win = ctx.snapshots.get(mid)!;
  const side = rng() < g.params.buy_bias_pct ? "BUY" : "SELL";
  return {
    kind: "entry", venue: win.latest.venue, market_id: mid, side,
    size_usd: Math.min(g.params.entry_size_usd, agent.cash_usd_current),
    rationale: "random baseline",
    time_stop_at: new Date(new Date(ctx.now).getTime() + 4 * 3_600_000).toISOString(),
  };
}

/** Master decide dispatcher. */
export function decide(agent: LiveAgent, ctx: TickContext, rng: () => number): Signal {
  // Always check exits first — that lets us close before opening a new position.
  for (const pos of agent.positions) {
    const win = ctx.snapshots.get(pos.market_id);
    if (!win) continue;
    const px = win.latest.price;
    // Target hit
    if (pos.target_price !== undefined && ((pos.side === "BUY" && px >= pos.target_price) || (pos.side === "SELL" && px <= pos.target_price))) {
      return { kind: "exit", venue: pos.venue, market_id: pos.market_id, rationale: `target ${pos.target_price.toFixed(4)} hit` };
    }
    // Stop hit
    if (pos.stop_price !== undefined && ((pos.side === "BUY" && px <= pos.stop_price) || (pos.side === "SELL" && px >= pos.stop_price))) {
      return { kind: "exit", venue: pos.venue, market_id: pos.market_id, rationale: `stop ${pos.stop_price.toFixed(4)} hit` };
    }
    // Time stop
    if (pos.time_stop_at && ctx.now >= pos.time_stop_at) {
      return { kind: "exit", venue: pos.venue, market_id: pos.market_id, rationale: "time stop" };
    }
  }
  // No exit fired → decide entry
  const g = agent.genome;
  switch (g.kind) {
    case "poly_fade_spike":     return decidePolyFadeSpike(g, agent, ctx);
    case "poly_breakout":       return decidePolyBreakout(g, agent, ctx);
    case "cb_breakout":         return decideCbBreakout(g, agent, ctx);
    case "cb_mean_reversion":   return decideCbMeanReversion(g, agent, ctx);
    case "cross_venue_arb":     return decideCrossVenueArb(g, agent, ctx);
    case "cb_momentum_burst":   return decideCbMomentumBurst(g, agent, ctx);
    case "random_walk_baseline": return decideRandomWalk(g, agent, ctx, rng);
    case "category_specialist":  return decideCategorySpecialist(g, agent, ctx);
    case "wallet_copy_filtered":  return decideWalletCopyFiltered(g, agent, ctx);
    case "polymarket_market_maker": return decidePolyMarketMaker(g, agent, ctx);
    case "llm_probability_oracle": return decideLlmProbabilityOracle(g, agent, ctx);
    case "poly_short_binary_directional": return decidePolyShortBinary(g, agent, ctx);
    case "multi_strategy":        return decideMultiStrategy(g, agent, ctx, rng);
  }
}

// ----------------------------------------------------------------------------
// Bookkeeping — apply a signal to an in-memory agent, mark-to-market.
// ----------------------------------------------------------------------------

export type ApplyResult = {
  trade?: Omit<PaperTradeRow, "id" | "tick_at" | "generation"> & { tick_at: string; generation: number };
  exitOf?: Position;        // when exiting, the closed position is returned for caller to link
  entryPos?: Position;      // when entering, the opened position — caller sets entry_trade_id after insert
};

export function applySignal(agent: LiveAgent, signal: Signal, ctx: TickContext, generation: number): ApplyResult {
  if (signal.kind === "hold") return {};
  const tickAt = ctx.now;
  if (signal.kind === "entry") {
    const win = ctx.snapshots.get(signal.market_id);
    if (!win) return {};
    const px = win.latest.price;
    const fee = (signal.size_usd * feeBps(signal.venue)) / 10_000;
    if (signal.size_usd + fee > agent.cash_usd_current) return {};
    agent.cash_usd_current -= signal.size_usd + fee;
    const newPos: Position = {
      venue: signal.venue,
      market_id: signal.market_id,
      side: signal.side,
      size_usd: signal.size_usd,
      entry_price: px,
      opened_at: tickAt,
      target_price: signal.target_price,
      stop_price: signal.stop_price,
      time_stop_at: signal.time_stop_at,
    };
    agent.positions.push(newPos);
    agent.entries_count += 1;
    const decisionJournalId = shadowGateEntry(agent.id, agent.genome.kind, signal.venue, signal.market_id, signal.side, signal.size_usd, px, tickAt);
    return {
      entryPos: newPos,   // caller sets newPos.entry_trade_id once the trade is inserted
      trade: {
        paper_agent_id: agent.id, venue: signal.venue, market_id: signal.market_id,
        side: signal.side, intent: "entry", price: px, size_usd: signal.size_usd, fee_usd: fee,
        realized_pnl_usd: null, linked_entry_id: null, signal_rationale: signal.rationale,
        tick_at: tickAt, generation, decision_journal_id: decisionJournalId,
      },
    };
  }
  // exit
  const posIdx = agent.positions.findIndex((p) => p.market_id === signal.market_id);
  if (posIdx === -1) return {};
  const pos = agent.positions[posIdx];
  const win = ctx.snapshots.get(signal.market_id);
  if (!win) return {};
  const px = win.latest.price;
  // PnL on Polymarket-style 0..1 markets: SELL-YES is executed by the live
  // router as BUY-NO at price (1 - yes_mid), so the sim must mirror that
  // bounded-loss math (max loss = stake). Pre-2026-05-26 we used the
  // unbounded short-CFD formula (entry - exit) / entry which produced losses
  // up to ~20× stake when shorting near-zero YES prices.
  //   BUY:  shareRet = (px - entry) / entry
  //   SELL: shareRet = (entry - px) / (1 - entry)   ← BUY-NO equivalent
  const shareRet = pos.side === "BUY"
    ? (px - pos.entry_price) / pos.entry_price
    : (pos.entry_price - px) / (1 - pos.entry_price);
  const grossPnl = pos.size_usd * shareRet;
  const fee = (pos.size_usd * feeBps(pos.venue)) / 10_000;
  const realized = grossPnl - fee;
  agent.cash_usd_current += pos.size_usd + realized; // return notional + pnl
  agent.realized_pnl_usd += realized;
  agent.trades_count += 1;
  if (realized > 0) agent.wins_count += 1;
  agent.positions.splice(posIdx, 1);
  return {
    trade: {
      paper_agent_id: agent.id, venue: pos.venue, market_id: pos.market_id,
      side: pos.side === "BUY" ? "SELL" : "BUY", // exit side flips
      intent: "exit", price: px, size_usd: pos.size_usd, fee_usd: fee,
      realized_pnl_usd: realized, linked_entry_id: pos.entry_trade_id ?? null,
      signal_rationale: signal.rationale, tick_at: tickAt, generation,
    },
    exitOf: pos,
  };
}

/** Recompute unrealized PnL across open positions using the latest snapshot.
 *  Equity = cash + locked principal + unrealized PnL. Counting principal
 *  matters when positions are open: an entry just locks capital, it doesn't
 *  destroy it. Bug-fix 2026-05-25. */
export function markToMarket(agent: LiveAgent, ctx: TickContext): void {
  let unr = 0;
  let openPrincipal = 0;
  for (const pos of agent.positions) {
    openPrincipal += pos.size_usd;
    const win = ctx.snapshots.get(pos.market_id);
    if (!win) continue;
    const px = win.latest.price;
    // Mirror applySignal's BUY-NO-equivalent SELL math (bounded loss).
    const shareRet = pos.side === "BUY"
      ? (px - pos.entry_price) / pos.entry_price
      : (pos.entry_price - px) / (1 - pos.entry_price);
    unr += pos.size_usd * shareRet;
  }
  agent.unrealized_pnl_usd = unr;
  const equity = agent.cash_usd_current + openPrincipal + unr;
  if (equity > agent.peak_equity_usd) agent.peak_equity_usd = equity;
  const dd = agent.peak_equity_usd - equity;
  if (dd > agent.max_drawdown_usd) agent.max_drawdown_usd = dd;
}
