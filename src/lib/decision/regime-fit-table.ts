/**
 * Meta-layer BUILD 6 — the LEARNED regime→strategy fit table.
 *
 * The regime gate currently scores a proposal against a strategy's HAND-CODED
 * `strategyRegimes` preference (regime.ts regimeFitScore: match 1.0 / mismatch 0.4 /
 * unknown 0.7 / news_shock-avoid 0.0). BUILD 6 replaces that static score with an
 * EMPIRICAL one — the Beta lower-credible-bound win-rate of the (strategy_kind ×
 * regime) cell from the live ledger — but ONLY for a dense, parity-clean cell.
 * Everything else falls back to the static score, so the table is a strict, safe
 * augmentation, never a regression.
 *
 * DESIGN (replace-when-confident, per the build-6 design workflow):
 *   - estimator: reuse build-3 `betaLowerBound` (NO new statistic). The LCB (not the
 *     raw win-rate) auto-penalizes thin cells — a 6/10 cell scores ~0.31, not 0.6.
 *   - serve a cell's LCB ONLY when cell.n >= minTrades (default 30) AND the
 *     strategy_kind is in the genome-kind vocabulary (parity guard). Else null →
 *     caller keeps the static regimeFitScore.
 *   - news_shock hard-reject + thin-cell + missing-table all stay on the static rail.
 *
 * PARITY (the load-bearing correctness issue): decision_journal.strategy_kind holds
 * TWO vocabularies — sim.ts writes genome.kind ("poly_fade_spike", …) while
 * live-capsule.ts writes signal.venue ("sim-poly"/"sim-coinbase"). We train on the
 * genome-kind vocabulary ONLY: the builder DROPS venue rows, and `lookupLearnedFit`
 * refuses any strategy_kind ∉ SUB_GENOME_KINDS. So the learned path is parity-clean
 * for sim agents; live-capsule lookups always fall back (its venue keys never match)
 * until live-capsule v2 reads genome.kind from the bound paper_agent. Contained, not
 * coerced — we never alias venue→kind.
 *
 * LEAKAGE NOTE: the regime gate score is also a meta-labeler training feature
 * (calibration-loader → meta-label). A LEARNED regime score is a smoothed win-rate,
 * so feeding it to the meta-labeler would be target leakage. buildRegimeResult
 * therefore records the STATIC score in details.regime_fit_static whenever it
 * overrides, and the meta-label feature extractor (calibration.metaFeatureScoreForGate)
 * trains on THAT, not the learned score.
 *
 * Pure lookup + fail-safe fs load. No new estimator. Env-gated, default OFF.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { betaLowerBound } from "@/lib/meta/strategy-allocator";
import { SUB_GENOME_KINDS } from "@/lib/arena/genome";
import type { Regime } from "./regime";
import type { LabeledDecision } from "./calibration";

export const REGIME_FIT_PATH = "data/regime-fit-table.json";
export const DEFAULT_MIN_TRADES = 30;
/** LCB params: 2.5th-percentile bound (z=1.96) over a Beta(2,2) prior. */
const PRIOR = { z: 1.96, priorAlpha: 2, priorBeta: 2 } as const;

const SUB_KIND_SET = new Set<string>(SUB_GENOME_KINDS);

export type RegimeFitCell = { n: number; wins: number; lcb: number };

export type RegimeFitTable = {
  builtAt: string;
  /** Minimum cell trades to serve its learned LCB — baked in so serve honors build. */
  minTrades: number;
  priorAlpha: number;
  priorBeta: number;
  z: number;
  /** key = `${SubGenomeKind}|${Regime}` */
  cells: Record<string, RegimeFitCell>;
  /** venue / out-of-vocab / no-regime rows dropped at build time (audit). */
  dropped: number;
};

/**
 * Pure aggregation: (strategy_kind × regime) → {n, wins, LCB}. DROPS any row whose
 * strategy_kind ∉ SUB_GENOME_KINDS (the venue-vocabulary rows) so the table is built
 * on ONE vocabulary. Reuses build-3 `betaLowerBound` — no new estimator.
 */
export function buildRegimeFitTableFromRows(
  rows: readonly LabeledDecision[],
  opts: { minTrades?: number } = {},
): RegimeFitTable {
  const minTrades = opts.minTrades ?? DEFAULT_MIN_TRADES;
  const agg = new Map<string, { n: number; wins: number }>();
  let dropped = 0;
  for (const r of rows) {
    const kind = r.strategy_kind;
    const regime = r.regime;
    if (!kind || !regime || !SUB_KIND_SET.has(kind)) { dropped++; continue; } // wrong vocab / unlabeled
    const key = `${kind}|${regime}`;
    const e = agg.get(key) ?? { n: 0, wins: 0 };
    e.n++;
    if (r.won) e.wins++;
    agg.set(key, e);
  }
  const cells: Record<string, RegimeFitCell> = {};
  for (const [key, e] of agg) {
    cells[key] = { n: e.n, wins: e.wins, lcb: betaLowerBound(e.wins, e.n - e.wins, PRIOR) };
  }
  return { builtAt: new Date().toISOString(), minTrades, z: PRIOR.z, priorAlpha: PRIOR.priorAlpha, priorBeta: PRIOR.priorBeta, cells, dropped };
}

/**
 * Serve-time lookup. Returns {score, n} ONLY when the strategy_kind is in the
 * genome-kind vocabulary (parity guard), the cell exists, and cell.n >= minTrades.
 * Returns null otherwise → caller falls back to the static regimeFitScore.
 * Pure, hot-path-safe, never throws.
 */
export function lookupLearnedFit(
  table: RegimeFitTable,
  strategyKind: string,
  regime: Regime,
): { score: number; n: number } | null {
  if (regime === "unknown") return null;                       // unclassifiable → static rail (documented invariant)
  if (!SUB_KIND_SET.has(strategyKind)) return null;            // venue vocab → fall back
  const cell = table.cells[`${strategyKind}|${regime}`];
  if (!cell || cell.n < table.minTrades) return null;          // thin / missing → fall back
  return { score: cell.lcb, n: cell.n };
}

export function saveRegimeFitTable(table: RegimeFitTable, path = REGIME_FIT_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(table, null, 2));
}

/** Fail-safe load: missing/corrupt/wrong-shape → undefined (NEVER throws) → static behaviour. */
export function loadRegimeFitTable(path = REGIME_FIT_PATH): RegimeFitTable | undefined {
  const p = resolve(process.cwd(), path);
  if (!existsSync(p)) return undefined;
  try {
    const t = JSON.parse(readFileSync(p, "utf8")) as RegimeFitTable;
    if (!t || typeof t !== "object" || typeof t.minTrades !== "number" || !t.cells || typeof t.cells !== "object") return undefined;
    return t;
  } catch {
    return undefined;
  }
}

// Env-gated, load-once accessor for the serve paths (sim shadow-gate + live-capsule).
// OFF unless ARENA_REGIME_FIT_TABLE=1 AND a non-empty artifact exists. Tri-state cache
// mirrors live-capsule's metaLabelSizing(): undefined=unloaded, null=disabled, value=active.
let _active: RegimeFitTable | null | undefined;
export function activeRegimeFitTable(): RegimeFitTable | undefined {
  if (process.env.ARENA_REGIME_FIT_TABLE !== "1") return undefined;
  if (_active === undefined) {
    const t = loadRegimeFitTable();
    _active = t && Object.keys(t.cells).length > 0 ? t : null;
  }
  return _active ?? undefined;
}
