/**
 * Live per-agent diagnostic — mirrors the calculations in sim.ts:decide() but
 * returns the *numeric reading + threshold* instead of a Signal, so the UI can
 * show what each agent is waiting for when the market is too quiet to fire.
 *
 * Pure read; safe for SSR. Per-strategy logic intentionally duplicates a small
 * piece of sim.ts so the diagnostic stays accurate even if the dispatcher
 * grows. Keep this file in sync when adding new genome kinds.
 */
import { acceleration, loadRecentCandles, velocity } from "./momentum";
import { recentFillsForWalletInCategory, walletWinRateByCategory } from "@/lib/wallet/category-stats";
import { peekOracleCache } from "./llm-oracle";
import { checkBudget } from "./llm-oracle-budget";
import { oracleEnabled } from "./oracle-warmer";
import type { LiveAgent, Snapshot, TickContext } from "./types";

export type DiagStatus = "in-position" | "would-enter" | "watching" | "no-data";

export type AgentDiagnostic = {
  status: DiagStatus;
  /** Short label for the column (~30 chars). */
  label: string;
  /** Optional detail for tooltip / future drawer. */
  detail?: string;
};

function minutesSince(iso: string, now: string): number {
  return (new Date(now).getTime() - new Date(iso).getTime()) / 60_000;
}
function meanStd(snaps: Snapshot[]): { mean: number; sd: number } {
  if (snaps.length === 0) return { mean: 0, sd: 0 };
  const mean = snaps.reduce((a, s) => a + s.price, 0) / snaps.length;
  if (snaps.length < 2) return { mean, sd: 0 };
  const variance = snaps.reduce((a, s) => a + (s.price - mean) ** 2, 0) / (snaps.length - 1);
  return { mean, sd: Math.sqrt(variance) };
}
function nthFromEnd(history: Snapshot[], minutesAgo: number, now: string): Snapshot | undefined {
  const cutoffMs = new Date(now).getTime() - minutesAgo * 60_000;
  for (let i = history.length - 1; i >= 0; i--) {
    if (new Date(history[i].captured_at).getTime() <= cutoffMs) return history[i];
  }
  return history[0];
}

export function diagnoseAgent(agent: LiveAgent, ctx: TickContext): AgentDiagnostic {
  if (agent.positions.length > 0) {
    return { status: "in-position", label: `${agent.positions.length} open` };
  }
  const g = agent.genome;
  if (g.kind === "multi_strategy") {
    // Aggregate sub-diagnostics. Surface the "best" sub (would-enter beats
    // watching beats no-data). Status reflects the best.
    const subDiags = g.params.subs.map((sub) => {
      const subAgent = { ...agent, genome: sub } as LiveAgent;
      return { kind: sub.kind, diag: diagnoseAgent(subAgent, ctx) };
    });
    const priority: Record<DiagStatus, number> = { "would-enter": 3, "watching": 2, "in-position": 4, "no-data": 1 };
    subDiags.sort((a, b) => (priority[b.diag.status] ?? 0) - (priority[a.diag.status] ?? 0));
    const best = subDiags[0];
    const summary = subDiags.map((s) => s.kind.split("_").map((p) => p.slice(0, 3)).join("-")).join("+");
    return {
      status: best.diag.status,
      label: `multi[${summary}] · best=${best.kind.replace("_", " ").slice(0, 14)}: ${best.diag.label.slice(0, 32)}`,
    };
  }
  switch (g.kind) {
    case "cb_momentum_burst": {
      const p = g.params;
      const win = ctx.snapshots.get(p.product_id);
      if (!win) return { status: "no-data", label: `no ${p.product_id} snaps` };
      const cutoffUnix = Math.floor(new Date(ctx.now).getTime() / 1000);
      const lookbackMin = Math.max(p.vel_window_min * 2 + 5, 30);
      const candles = loadRecentCandles(p.product_id, lookbackMin, { cutoffUnix });
      if (candles.length < p.vel_window_min + 2) {
        return { status: "no-data", label: `${candles.length}/${p.vel_window_min + 2} candles` };
      }
      const v = velocity(candles, p.vel_window_min);
      const a = acceleration(candles, p.vel_window_min);
      const vPct = (v * 100).toFixed(3);
      const aPct = (a * 100).toFixed(3);
      const thrV = (p.vel_entry_pct * 100).toFixed(2);
      const thrA = (p.accel_min * 100).toFixed(3);
      const longFires = v >= p.vel_entry_pct && a >= p.accel_min;
      const shortFires = p.direction_bias === "long_short" && v <= -p.vel_entry_pct && a <= -p.accel_min;
      const fires = longFires || shortFires;
      return {
        status: fires ? "would-enter" : "watching",
        label: `v=${vPct}% / ≥${thrV}% · a=${aPct}% / ≥${thrA}%`,
        detail: `bias=${p.direction_bias}`,
      };
    }
    case "cb_mean_reversion": {
      const p = g.params;
      const win = ctx.snapshots.get(p.product_id);
      if (!win) return { status: "no-data", label: `no ${p.product_id} snaps` };
      const cutoffMs = new Date(ctx.now).getTime() - p.lookback_min * 60_000;
      const inWindow = win.history.filter((s) => new Date(s.captured_at).getTime() >= cutoffMs);
      if (inWindow.length < 12) return { status: "no-data", label: `${inWindow.length}/12 snaps` };
      const { mean, sd } = meanStd(inWindow);
      if (sd <= 0) return { status: "no-data", label: "σ=0" };
      const z = (win.latest.price - mean) / sd;
      const fires = z <= -p.z_entry;
      return {
        status: fires ? "would-enter" : "watching",
        label: `z=${z.toFixed(2)} / ≤${(-p.z_entry).toFixed(2)}`,
        detail: `μ=${mean.toFixed(2)} σ=${sd.toFixed(2)} window=${p.lookback_min}min`,
      };
    }
    case "poly_fade_spike": {
      const p = g.params;
      let best: { mid: string; pts: number; quietPts: number } | null = null;
      for (const [mid, win] of ctx.snapshots) {
        if (win.latest.venue !== "sim-poly") continue;
        const lookbackSnap = nthFromEnd(win.history, p.lookback_h * 60, ctx.now);
        const confirmSnap = nthFromEnd(win.history, p.confirm_quiet_h * 60, ctx.now);
        if (!lookbackSnap || !confirmSnap) continue;
        const pts = (win.latest.price - lookbackSnap.price) * 100;
        const quietPts = Math.abs((win.latest.price - confirmSnap.price) * 100);
        if (!best || Math.abs(pts) > Math.abs(best.pts)) best = { mid, pts, quietPts };
      }
      if (!best) return { status: "no-data", label: "no poly markets" };
      const fires = Math.abs(best.pts) >= p.threshold_pts && best.quietPts <= p.threshold_pts / 2;
      return {
        status: fires ? "would-enter" : "watching",
        label: `move=${best.pts.toFixed(1)}pt / ≥${p.threshold_pts.toFixed(1)}pt`,
        detail: `quiet=${best.quietPts.toFixed(1)}pt vs ≤${(p.threshold_pts / 2).toFixed(1)}pt`,
      };
    }
    case "poly_breakout": {
      const p = g.params;
      let best: { ratio: number } | null = null;
      for (const [, win] of ctx.snapshots) {
        if (win.latest.venue !== "sim-poly") continue;
        const inWindow = win.history.filter((s) => minutesSince(s.captured_at, ctx.now) <= p.lookback_h * 60);
        if (inWindow.length < 4) continue;
        const max = Math.max(...inWindow.map((s) => s.price));
        if (max <= 0) continue;
        const ratio = win.latest.price / max;
        if (!best || ratio > best.ratio) best = { ratio };
      }
      if (!best) return { status: "no-data", label: "thin poly history" };
      const fires = best.ratio > p.breakout_mult;
      return {
        status: fires ? "would-enter" : "watching",
        label: `top=${best.ratio.toFixed(3)}× / >${p.breakout_mult.toFixed(2)}×`,
      };
    }
    case "cb_breakout": {
      const p = g.params;
      const win = ctx.snapshots.get(p.product_id);
      if (!win) return { status: "no-data", label: `no ${p.product_id} snaps` };
      const inWindow = win.history.filter((s) => minutesSince(s.captured_at, ctx.now) <= p.lookback_min);
      if (inWindow.length < 4) return { status: "no-data", label: `${inWindow.length}/4 snaps` };
      const max = Math.max(...inWindow.map((s) => s.price));
      const ratio = max > 0 ? win.latest.price / max : 0;
      const fires = ratio > p.breakout_mult;
      return {
        status: fires ? "would-enter" : "watching",
        label: `ratio=${ratio.toFixed(4)} / >${p.breakout_mult.toFixed(3)}`,
      };
    }
    case "cross_venue_arb": {
      const p = g.params;
      const polyProb = ctx.polyImpliedProb?.get(p.poly_condition_id);
      const bsProb = ctx.bsImpliedProb?.get(p.poly_condition_id);
      if (polyProb === undefined || bsProb === undefined) {
        return { status: "no-data", label: "bs/poly prob missing" };
      }
      const spread = (polyProb - bsProb) * 100;
      const fires = Math.abs(spread) >= p.edge_pts;
      return {
        status: fires ? "would-enter" : "watching",
        label: `spread=${spread.toFixed(1)}pt / ≥${p.edge_pts.toFixed(0)}pt`,
        detail: `poly=${(polyProb * 100).toFixed(1)}% bs=${(bsProb * 100).toFixed(1)}%`,
      };
    }
    case "random_walk_baseline": {
      const p = g.params;
      return {
        status: "watching",
        label: `trade_prob=${(p.trade_prob * 100).toFixed(1)}% per tick`,
      };
    }
    case "wallet_copy_filtered": {
      const p = g.params;
      const stats = walletWinRateByCategory(p.wallet_address, p.copy_category, 30);
      if (!stats) {
        return { status: "no-data", label: `no fills · ${p.wallet_address.slice(0, 8)}…/${p.copy_category}` };
      }
      if (stats.trades_count < p.min_source_trades) {
        return { status: "no-data", label: `only ${stats.trades_count}/${p.min_source_trades} src trades` };
      }
      if (stats.win_rate < p.min_source_win_rate) {
        return { status: "watching", label: `wr=${(stats.win_rate * 100).toFixed(0)}% < ${(p.min_source_win_rate * 100).toFixed(0)}% gate` };
      }
      const fills = recentFillsForWalletInCategory(p.wallet_address, p.copy_category, p.delay_min);
      if (fills.length === 0) {
        return { status: "watching", label: `wr=${(stats.win_rate * 100).toFixed(0)}% · no fills in last ${p.delay_min}min` };
      }
      return {
        status: "would-enter",
        label: `wr=${(stats.win_rate * 100).toFixed(0)}% · ${fills.length} fresh fills`,
        detail: `latest: ${fills[0].side} ${fills[0].token_id.slice(0, 8)}… @ ${fills[0].price?.toFixed(3)}`,
      };
    }
    case "polymarket_market_maker": {
      const p = g.params;
      let mid: string | null = null;
      if (p.token_id !== "any" && ctx.snapshots.has(p.token_id)) {
        mid = p.token_id;
      } else {
        for (const [tokenId, win] of ctx.snapshots) {
          if (win.latest.venue !== "sim-poly") continue;
          if (win.latest.price <= 0.05 || win.latest.price >= 0.95) continue;
          mid = tokenId;
          break;
        }
      }
      if (!mid) return { status: "no-data", label: "no liquid poly mkts" };
      const win = ctx.snapshots.get(mid)!;
      const side = agent.entries_count % 2 === 0 ? "BUY" : "SELL";
      return {
        status: "would-enter",
        label: `MM ${side}@${win.latest.price.toFixed(3)} · spread=${p.spread_pts}pt`,
        detail: `target=${(p.token_id === "any" ? "any-liquid" : p.token_id.slice(0, 12))}`,
      };
    }
    case "llm_probability_oracle": {
      const p = g.params;
      if (!oracleEnabled()) {
        return { status: "no-data", label: "oracle disabled (ARENA_LLM_ORACLE_ENABLED!=1)" };
      }
      const budget = checkBudget();
      // Look for any cached entry that matches our category filter.
      let cached: { mid: string; prob: number; conf: string } | null = null;
      for (const [mid, win] of ctx.snapshots) {
        if (win.latest.venue !== "sim-poly") continue;
        if (p.category_filter && win.latest.category !== p.category_filter) continue;
        const c = peekOracleCache(mid, p.prompt_version);
        if (c) { cached = { mid, prob: c.probability, conf: c.confidence }; break; }
      }
      const cat = p.category_filter ?? "any";
      const budgetStr = `$${budget.spent_usd.toFixed(2)}/$${budget.cap_usd.toFixed(2)}`;
      if (!cached) {
        return { status: "watching", label: `oracle/${cat} · awaiting warm · budget ${budgetStr}` };
      }
      return {
        status: cached.conf === "low" ? "watching" : "would-enter",
        label: `oracle/${cat} · p=${cached.prob.toFixed(2)} (${cached.conf}) · budget ${budgetStr}`,
        detail: `cached for ${cached.mid.slice(0, 12)}…`,
      };
    }
    case "category_specialist": {
      const p = g.params;
      // Count candidates in the chosen category.
      let candidates = 0;
      let bestMove = 0;
      for (const [, win] of ctx.snapshots) {
        if (win.latest.venue !== "sim-poly") continue;
        if (win.latest.category !== p.category) continue;
        candidates += 1;
        if (p.inner_strategy === "fade_spike") {
          const lookbackSnap = nthFromEnd(win.history, p.lookback_h * 60, ctx.now);
          if (!lookbackSnap) continue;
          const move = Math.abs((win.latest.price - lookbackSnap.price) * 100);
          if (move > bestMove) bestMove = move;
        }
      }
      if (candidates === 0) {
        return { status: "no-data", label: `no ${p.category} markets in ctx` };
      }
      const inner = p.inner_strategy === "fade_spike" ? "fs" : "bo";
      const fires = p.inner_strategy === "fade_spike" && bestMove >= p.threshold_pts;
      return {
        status: fires ? "would-enter" : "watching",
        label: `${p.category}/${inner} · ${candidates} mkts · best=${bestMove.toFixed(1)}pt / ≥${p.threshold_pts.toFixed(1)}pt`,
      };
    }
    case "poly_short_binary_directional": {
      const p = g.params;
      const assets = new Set(p.assets.split(",").map((s) => s.trim().toUpperCase()));
      let inWindow = 0;
      let totalBinaries = 0;
      const nowMs = new Date(ctx.now).getTime();
      for (const [, win] of ctx.snapshots) {
        if (win.latest.venue !== "sim-poly") continue;
        if (!win.latest.category || !win.latest.category.endsWith("-binary")) continue;
        totalBinaries += 1;
      }
      // Cheap heuristic — count binaries in `pre_cutoff_min..max_window_min` for any allowed asset.
      // We avoid a per-tick DB sweep here; the strategy decide() does the precise check.
      const label = `assets=${[...assets].join("/")} · ${totalBinaries} binaries in ctx · vel≥${(p.vel_entry_pct * 100).toFixed(3)}%`;
      return { status: totalBinaries > 0 ? "watching" : "no-data", label };
    }
  }
}

/** Batched diagnostic for many agents — single ctx, no extra DB unless the
 *  strategy itself needs candles (which already caches in better-sqlite3). */
export function diagnoseAgents(agents: LiveAgent[], ctx: TickContext): Map<number, AgentDiagnostic> {
  const out = new Map<number, AgentDiagnostic>();
  for (const a of agents) out.set(a.id, diagnoseAgent(a, ctx));
  return out;
}
