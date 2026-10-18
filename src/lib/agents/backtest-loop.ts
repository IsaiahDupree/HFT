/**
 * Backtest-on-propose loop. Wraps runBacktest() so every proposed
 * strategy_version is auto-scored against recent market_snapshots before
 * it's eligible for promotion.
 *
 * The score lands in:
 *   1. The proposed version's `backtest_summary` JSON gets `.score` set
 *      (median of the sweep when one ran, single-run otherwise)
 *   2. `performance_metrics(window='backtest')` upserted with the same run
 *   3. A `backtest` evolution_log event with the full sweep payload
 *
 * Score is consumed by stages/gate.ts:checkPromotionScore() — paper→live
 * and live_eligible→live transitions refuse when score is below
 * RISK_MIN_PROMOTION_SCORE (default -10).
 *
 * Parameter sweep: when `sweep` is set (or BACKTEST_SWEEP=1 in env), the
 * loop runs N backtests at perturbed parameter values and uses the MEDIAN
 * score as the gating signal. Defends against single-lucky-config
 * promotions — strategies that only work at one exact parameter value
 * don't pass.
 */
import { db } from "@/lib/db/client";
import { runBacktest, thresholdMeanReversion, loadSnapshotsForToken } from "@/lib/backtest/engine";
import type { BacktestResult, DecisionFn } from "@/lib/backtest/types";
import { insertEvolutionEvent } from "@/lib/db/queries";

export type ProposalToScore = {
  /** The newly-created strategy_versions row id. */
  versionId: number;
  /** Parent strategy id (for the perf-metrics upsert). */
  strategyId: number;
  /** Version number (for log strings). */
  version: number;
  /** The proposed spec (merged from parent + patch). Used to derive backtest params. */
  spec: Record<string, unknown>;
  /** Optional explicit token_id to backtest against. If absent, picks the highest-|zScore| token from the signals universe. */
  tokenId?: string;
  /** Optional list of (tokenId, |zScore|) so this loop can rank when no tokenId given. */
  signalsUniverse?: Array<{ tokenId: string; zScoreAbs: number }>;
  /**
   * Optional parameter sweep. When set, runs one backtest per delta with
   * the spec's value at `axis` multiplied by (1 + delta). The MEDIAN score
   * across runs becomes the persisted .score; promotion gates on it.
   *
   * Example: `{ axis: 'entry.threshold_pts', deltas: [-0.25, -0.1, 0, 0.1, 0.25] }`
   * scores the proposal at 75%/90%/100%/110%/125% of the suggested value.
   *
   * When BACKTEST_SWEEP=1 is in env and `sweep` is not provided, a default
   * sweep is auto-derived from the first numeric `entry.*` field in the spec.
   */
  sweep?: { axis: string; deltas: number[] };
};

export type SingleBacktestRun = {
  axis?: string;
  delta?: number;
  value?: number;
  result: BacktestResult;
};

export type SweepSummary = {
  axis: string;
  runs: SingleBacktestRun[];
  medianScore: number;
  minScore: number;
  maxScore: number;
  medianPnlUsd: number;
};

export type BacktestOnProposeResult = {
  versionId: number;
  tokenIdUsed: string | null;
  snapshotsScanned: number;
  /** For sweeps: the run whose score equals the median. For singles: the only run. Null when skipped. */
  result: BacktestResult | null;
  /** Set only when a sweep ran. */
  sweep?: SweepSummary;
  reason: string;          // "ok" | "no token id" | "no snapshots" | "decision fn unsupported"
};

const DEFAULT_SWEEP_DELTAS = [-0.25, -0.1, 0, 0.1, 0.25] as const;

/**
 * Run backtest on a freshly-proposed version. No-op (returns reason) when
 * we can't pick a token or there's not enough history yet.
 */
export function backtestProposedSpec(p: ProposalToScore): BacktestOnProposeResult {
  const tokenId = p.tokenId ?? pickTopTokenId(p.signalsUniverse);
  if (!tokenId) {
    return { versionId: p.versionId, tokenIdUsed: null, snapshotsScanned: 0, result: null, reason: "no token id" };
  }

  const snapshots = loadSnapshotsForToken(tokenId, 1000);
  if (snapshots.length < 30) {
    return { versionId: p.versionId, tokenIdUsed: tokenId, snapshotsScanned: snapshots.length, result: null, reason: "no snapshots" };
  }

  // Resolve sweep: explicit > env default > none
  const sweepConfig = p.sweep ?? maybeDefaultSweep(p.spec);

  if (sweepConfig) {
    const runs = runSweep(snapshots, p.spec, sweepConfig);
    if (runs.length === 0) {
      // Sweep resolution failed; fall back to single run
      const decide = decisionFnForSpec(p.spec);
      if (!decide) {
        return { versionId: p.versionId, tokenIdUsed: tokenId, snapshotsScanned: snapshots.length, result: null, reason: "decision fn unsupported" };
      }
      const result = runBacktest(snapshots, decide, { fillModel: "walk_book" });
      persistScore(p, tokenId, snapshots.length, result, null);
      return { versionId: p.versionId, tokenIdUsed: tokenId, snapshotsScanned: snapshots.length, result, reason: "ok" };
    }
    const scores = runs.map((r) => r.result.score);
    const pnls = runs.map((r) => r.result.pnlUsd);
    const medianScore = median(scores);
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);
    const medianPnlUsd = median(pnls);
    // Pick the run closest to median score for the persisted "representative" result
    const sortedByDistance = [...runs].sort(
      (a, b) => Math.abs(a.result.score - medianScore) - Math.abs(b.result.score - medianScore),
    );
    const representativeResult = sortedByDistance[0].result;
    const sweepSummary: SweepSummary = {
      axis: sweepConfig.axis,
      runs,
      medianScore,
      minScore,
      maxScore,
      medianPnlUsd,
    };
    persistScore(p, tokenId, snapshots.length, representativeResult, sweepSummary);
    return { versionId: p.versionId, tokenIdUsed: tokenId, snapshotsScanned: snapshots.length, result: representativeResult, sweep: sweepSummary, reason: "ok" };
  }

  // Single-run path (no sweep)
  const decide = decisionFnForSpec(p.spec);
  if (!decide) {
    return { versionId: p.versionId, tokenIdUsed: tokenId, snapshotsScanned: snapshots.length, result: null, reason: "decision fn unsupported" };
  }
  const result = runBacktest(snapshots, decide, { fillModel: "walk_book" });
  persistScore(p, tokenId, snapshots.length, result, null);
  return { versionId: p.versionId, tokenIdUsed: tokenId, snapshotsScanned: snapshots.length, result, reason: "ok" };
}

function pickTopTokenId(universe?: Array<{ tokenId: string; zScoreAbs: number }>): string | null {
  if (!universe || universe.length === 0) return null;
  const top = [...universe].sort((a, b) => b.zScoreAbs - a.zScoreAbs)[0];
  return top.tokenId;
}

/** When BACKTEST_SWEEP=1 is set, pick the first numeric `entry.*` field as the sweep axis. */
function maybeDefaultSweep(spec: Record<string, unknown>): { axis: string; deltas: number[] } | null {
  if (process.env.BACKTEST_SWEEP !== "1") return null;
  const entry = spec.entry as Record<string, unknown> | undefined;
  if (!entry) return null;
  for (const [k, v] of Object.entries(entry)) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      return { axis: `entry.${k}`, deltas: [...DEFAULT_SWEEP_DELTAS] };
    }
  }
  return null;
}

function runSweep(
  snapshots: ReturnType<typeof loadSnapshotsForToken>,
  spec: Record<string, unknown>,
  sweep: { axis: string; deltas: number[] },
): SingleBacktestRun[] {
  const runs: SingleBacktestRun[] = [];
  for (const delta of sweep.deltas) {
    const perturbed = perturbSpec(spec, sweep.axis, delta);
    if (!perturbed) continue;
    const decide = decisionFnForSpec(perturbed.spec);
    if (!decide) continue;
    const result = runBacktest(snapshots, decide, { fillModel: "walk_book" });
    runs.push({ axis: sweep.axis, delta, value: perturbed.value, result });
  }
  return runs;
}

/**
 * Return a new spec object with the value at `axis` (e.g. "entry.threshold_pts")
 * multiplied by (1 + delta). Returns null when the axis doesn't resolve to a
 * positive number.
 */
function perturbSpec(spec: Record<string, unknown>, axis: string, delta: number): { spec: Record<string, unknown>; value: number } | null {
  const parts = axis.split(".");
  if (parts.length < 2) return null;
  // Clone shallow to avoid mutating caller's spec
  const cloned: Record<string, unknown> = { ...spec };
  let cursor: Record<string, unknown> = cloned;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    const next = cursor[k];
    if (typeof next !== "object" || next == null) return null;
    cursor[k] = { ...(next as Record<string, unknown>) };
    cursor = cursor[k] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  const original = cursor[leaf];
  if (typeof original !== "number" || !Number.isFinite(original) || original <= 0) return null;
  const newValue = Math.max(1e-9, original * (1 + delta));
  cursor[leaf] = newValue;
  return { spec: cloned, value: newValue };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Map a strategy spec → DecisionFn. Today only the threshold-mean-reversion
 * shape is supported (entry.threshold_pts + entry.vol_multiple_min → buyBelow/sellAbove
 * heuristics). Strategies with more exotic specs return null and skip the
 * backtest gracefully.
 *
 * To add a strategy family: add a `kind` discriminator in the spec and a new
 * branch here.
 */
function decisionFnForSpec(spec: Record<string, unknown>): DecisionFn | null {
  const entry = (spec.entry as Record<string, unknown>) ?? {};
  const exit = (spec.exit as Record<string, unknown>) ?? {};

  const thresholdPts = Number(entry.threshold_pts ?? 0);
  if (Number.isFinite(thresholdPts) && thresholdPts > 0) {
    const buyBelow = Math.max(0.05, 0.5 - thresholdPts / 200);
    const sellAbove = Math.min(0.95, 0.5 + (Number(exit.profit_pts ?? thresholdPts) / 200));
    return thresholdMeanReversion({ buyBelow, sellAbove, sizeShares: 10 });
  }

  const volGate = Number(entry.vol_multiple_min ?? 0);
  if (Number.isFinite(volGate) && volGate > 0) {
    const buyBelow = Math.max(0.05, 0.4 - volGate / 100);
    return thresholdMeanReversion({ buyBelow, sellAbove: 0.55, sizeShares: 10 });
  }

  return null;
}

function persistScore(
  p: ProposalToScore,
  tokenId: string,
  snapshotsScanned: number,
  result: BacktestResult,
  sweep: SweepSummary | null,
): void {
  const handle = db();

  // The persisted score is the median across the sweep when one ran;
  // otherwise the single-run score. The single field is what
  // checkPromotionScore() reads, so a sweep'd strategy needs robustness
  // (not luck) to clear the gate.
  const scoreForGate = sweep ? sweep.medianScore : result.score;

  const row = handle
    .prepare("SELECT backtest_summary FROM strategy_versions WHERE id = ?")
    .get(p.versionId) as { backtest_summary: string | null } | undefined;
  let summary: Record<string, unknown> = {};
  if (row?.backtest_summary) {
    try { summary = JSON.parse(row.backtest_summary) as Record<string, unknown>; } catch { /* keep empty */ }
  }
  summary.score = scoreForGate;
  summary.scoredAt = new Date().toISOString();
  summary.tokenId = tokenId;
  summary.snapshotsScanned = snapshotsScanned;
  summary.pnlPct = result.pnlPct;
  summary.maxDrawdownPct = result.maxDrawdownPct;
  summary.tradesCount = result.tradesCount;
  if (sweep) summary.sweep = sweep;
  handle
    .prepare("UPDATE strategy_versions SET backtest_summary = ? WHERE id = ?")
    .run(JSON.stringify(summary), p.versionId);

  handle
    .prepare(
      `INSERT INTO performance_metrics
         (strategy_version_id, window, trades_count, win_rate, total_pnl_usd, sharpe, max_drawdown_usd)
       VALUES (?, 'backtest', ?, ?, ?, NULL, ?)
       ON CONFLICT(strategy_version_id, window)
       DO UPDATE SET trades_count=excluded.trades_count,
                     win_rate=excluded.win_rate,
                     total_pnl_usd=excluded.total_pnl_usd,
                     max_drawdown_usd=excluded.max_drawdown_usd,
                     computed_at=datetime('now')`,
    )
    .run(p.versionId, result.tradesCount, result.winRate, result.pnlUsd, result.maxDrawdownUsd);

  const sweepLabel = sweep
    ? ` median=${sweep.medianScore.toFixed(1)} [${sweep.minScore.toFixed(1)}..${sweep.maxScore.toFixed(1)}] n=${sweep.runs.length}`
    : "";
  insertEvolutionEvent({
    strategy_id: p.strategyId,
    to_version_id: p.versionId,
    event_type: "backtest",
    summary: `backtest v${p.version}: score=${scoreForGate.toFixed(1)}${sweepLabel} pnl=$${result.pnlUsd.toFixed(2)} dd=${(result.maxDrawdownPct * 100).toFixed(1)}% trades=${result.tradesCount}`,
    payload_json: JSON.stringify({ tokenId, snapshotsScanned, result, sweep, gatedBy: sweep ? "backtest-on-propose:sweep" : "backtest-on-propose" }),
  });
}
