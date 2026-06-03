/**
 * regime-robustness-defensive — independent verification of the "DEFENSIVE pattern is robust"
 * claim from scripts/regime-analysis.ts.
 *
 * The committed conclusion is: no per-regime cell survives Bonferroni, but the robust economic
 * signal is trend-following's DEFENSIVE behaviour (strategy POSITIVE while equal-weight
 * buy-and-hold is NEGATIVE, concentrated in low-vol / bear regimes). The worry to refute: that
 * the defensive count is an artifact of ONE specific regime tuning.
 *
 * This re-runs the conditional analysis while VARYING the regime definitions:
 *   trend SMA      ∈ {20, 50, 100, 150}
 *   vol (volN,lookback) ∈ {(10,50), (14,100), (20,150)}
 *   breadth SMA    ∈ {30, 50, 100}
 * = 4 × 3 × 3 = 36 definition sets. The STRATEGIES are identical to the baseline and do NOT
 * depend on the regime definition — only the regime LABELS change, so any change in the
 * defensive count is attributable purely to the regime definition.
 *
 * For each definition set we count, over the same scanned cell set as the baseline:
 *   defensive = cells with stratSharpeOos>0 & betaSharpeOos<0 & nOos>=60   (the claimed signature)
 *   leads     = cells beating beta OOS by >= 0.3 excess Sharpe & nOos>=60
 *   trendDef  = defensive cells whose strategy is an equal-weight TREND portfolio
 * Plus a CHANCE baseline: how many defensive cells you'd expect if the sign of (strat−beta) in
 * each regime were a coin flip given the marginal rate of negative-beta regimes.
 *
 * Run: cd HFT-work && npx tsx scripts/regime-robustness-defensive.ts
 */
import "./_env.ts";
import { listProducts, getCandles, closeTsdb } from "../src/lib/db/candle-store.ts";
import { buildPriceSeries } from "../src/lib/backtest/candle/xsection.ts";
import {
  relativeStrengthReturns, defaultRelStrengthVariants, equalWeightBuyHoldReturns, equalWeightTrendReturns,
} from "../src/lib/backtest/candle/cross-asset.ts";
import {
  volRegimeLabels, trendRegimeLabels, breadthRegimeLabels, combineLabels,
  regimeConditionalAlpha, candidateConditionalEdges, multipleTestingReport, type ConditionalAlpha,
} from "../src/lib/backtest/candle/regime.ts";

const FEE_BPS = 10;
const OOS_FRAC = 0.3;
const MIN_OOS = 60;
const MIN_EXCESS = 0.3;
const N_PERM = 200; // time-shuffle permutations per definition set for the null

// deterministic RNG (mulberry32) so the permutation null is reproducible.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(arr: readonly T[], rnd: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a as T[];
}

// ---- regime-definition grids to sweep --------------------------------------------------------
const TREND_SMAS = [20, 50, 100, 150];
const VOL_DEFS: Array<[number, number]> = [[10, 50], [14, 100], [20, 150]]; // (volN, lookback)
const BREADTH_SMAS = [30, 50, 100];
const MAX_REGIME_PARAM = Math.max(
  ...TREND_SMAS,
  ...VOL_DEFS.map(([vn, lb]) => vn + lb), // vol regime needs volN bars then lookback median ≈ volN+lookback warmup
  ...BREADTH_SMAS,
);

// ---- load warehouse --------------------------------------------------------------------------
const products = await listProducts("ONE_DAY");
const rows: Record<string, Array<{ start_unix: number; close: number }>> = {};
for (const c of products) rows[c] = await getCandles(c, "ONE_DAY");
const { coins, data, days } = buildPriceSeries(rows);

// ---- ONE common start index so every definition set shares the SAME bar grid -----------------
// Covers the strategy lookbacks (max rel-strength L, max trend SMA) AND the largest regime warmup,
// so the strategy/beta series are computed ONCE and reused; only labels differ between defs.
const relVariants = defaultRelStrengthVariants();
const stratMaxL = Math.max(...relVariants.map((v) => v.L), 100); // 100 = max trend strategy SMA
const startIndex = Math.max(stratMaxL, MAX_REGIME_PARAM);

const beta = equalWeightBuyHoldReturns(coins, data, days, startIndex);

type Strat = { label: string; rets: number[]; isTrend: boolean };
const strategies: Strat[] = [
  ...relVariants.map((v) => ({ label: v.label, isTrend: false,
    rets: relativeStrengthReturns(v, coins, data, days, { feeBps: FEE_BPS, startIndex }) })),
  ...[20, 50, 100].map((n) => ({ label: `trend${n}`, isTrend: true,
    rets: equalWeightTrendReturns(coins, data, days, n, { feeBps: FEE_BPS, startIndex }) })),
];

const btc = days.map((d) => data["BTC-USD"]?.get(d) ?? NaN);
const sliceTo = (a: string[]) => a.slice(startIndex, days.length - 1); // align labels 1:1 to strat/beta

// sanity: all strat series + beta must have identical length
const lens = new Set([beta.length, ...strategies.map((s) => s.rets.length)]);
if (lens.size !== 1) throw new Error(`series length mismatch: ${[...lens].join(",")}`);
const seriesLen = beta.length;

// ---- per-definition-set evaluation -----------------------------------------------------------
type DefResult = {
  trendSma: number; volN: number; volLb: number; breadthSma: number;
  nCells: number; nHyp: number; leads: number; defensive: number; trendDef: number;
  survivors: number; critT: number; bestT: number; bestTcell: string;
  chanceDefensive: number; perm95: number; permPval: number;
  topDefensive: string[];
};

function evalDefinition(trendSma: number, volN: number, volLb: number, breadthSma: number): DefResult {
  const vol = sliceTo(volRegimeLabels(btc, volN, volLb));
  const trend = sliceTo(trendRegimeLabels(btc, trendSma));
  const breadth = sliceTo(breadthRegimeLabels(coins, data, days, breadthSma));
  const dims: Array<{ name: string; labels: string[] }> = [
    { name: "vol", labels: vol },
    { name: "trend", labels: trend },
    { name: "breadth", labels: breadth },
    { name: "trend×vol", labels: combineLabels(trend, vol) },
  ];

  const allCells: Array<ConditionalAlpha & { strat: string; dim: string; isTrend: boolean }> = [];
  for (const s of strategies) {
    for (const dim of dims) {
      for (const cell of regimeConditionalAlpha(s.rets, beta, dim.labels, { oosFrac: OOS_FRAC })) {
        allCells.push({ ...cell, strat: s.label, dim: dim.name, isTrend: s.isTrend });
      }
    }
  }

  const leads = candidateConditionalEdges(allCells, { minExcessOos: MIN_EXCESS, minOosBars: MIN_OOS });
  const report = multipleTestingReport(allCells, { alpha: 0.05, minOosBars: MIN_OOS });
  const tested = allCells.filter((c) => c.nOos >= MIN_OOS);
  const bestCell = tested.slice().sort((a, b) => b.tStatOos - a.tStatOos)[0];

  const defensiveCells = allCells
    .filter((c) => c.nOos >= MIN_OOS && c.betaSharpeOos < 0 && c.stratSharpeOos > 0)
    .sort((a, b) => (b.stratSharpeOos - b.betaSharpeOos) - (a.stratSharpeOos - a.betaSharpeOos));
  const trendDef = defensiveCells.filter((c) => c.isTrend).length;
  const observedDef = defensiveCells.length;

  // PERMUTATION NULL — destroy the regime→return link by shuffling each dim's labels IN TIME,
  // keeping the strat/beta series fixed. If the real defensive count sits well above the shuffled
  // distribution, the defensive concentration is genuine regime structure, not an arithmetic
  // by-product of (mostly-positive strategies) × (some negative-beta slices). This is the honest
  // "~chance level" for "how many defensive cells would a meaningless regime split produce?".
  const rnd = rng(0xC0FFEE ^ (trendSma * 131 + volN * 17 + volLb * 7 + breadthSma));
  const permCounts: number[] = [];
  for (let p = 0; p < N_PERM; p++) {
    let cnt = 0;
    for (const s of strategies) {
      for (const dim of dims) {
        const shuffled = shuffle(dim.labels, rnd);
        for (const cell of regimeConditionalAlpha(s.rets, beta, shuffled, { oosFrac: OOS_FRAC })) {
          if (cell.nOos >= MIN_OOS && cell.betaSharpeOos < 0 && cell.stratSharpeOos > 0) cnt++;
        }
      }
    }
    permCounts.push(cnt);
  }
  const permMean = permCounts.reduce((a, b) => a + b, 0) / permCounts.length;
  const permGe = permCounts.filter((c) => c >= observedDef).length;     // one-sided null tail
  const permPval = permGe / permCounts.length;                          // P(null >= observed)
  const sortedPerm = permCounts.slice().sort((a, b) => a - b);
  const perm95 = sortedPerm[Math.min(sortedPerm.length - 1, Math.floor(0.95 * sortedPerm.length))];

  return {
    trendSma, volN, volLb, breadthSma,
    nCells: allCells.length, nHyp: report.nHypotheses, leads: leads.length,
    defensive: observedDef, trendDef,
    survivors: report.survivors.length, critT: report.critT,
    bestT: bestCell?.tStatOos ?? NaN,
    bestTcell: bestCell ? `${bestCell.strat}·${bestCell.dim}:${bestCell.label}` : "—",
    chanceDefensive: permMean, perm95, permPval,
    topDefensive: defensiveCells.slice(0, 4).map(
      (c) => `${c.strat}·${c.dim}:${c.label}(s${c.stratSharpeOos.toFixed(2)}/b${c.betaSharpeOos.toFixed(2)})`),
  };
}

// ---- run the full sweep ----------------------------------------------------------------------
console.log(`\nregime-robustness-defensive — does the DEFENSIVE pattern survive varying regime definitions?`);
console.log(`  universe ${coins.length} coins · ${seriesLen} aligned bars (startIndex=${startIndex}) · ${FEE_BPS}bps · OOS=${OOS_FRAC} · min-OOS=${MIN_OOS}`);
console.log(`  sweeping trendSMA${JSON.stringify(TREND_SMAS)} × vol${JSON.stringify(VOL_DEFS)} × breadthSMA${JSON.stringify(BREADTH_SMAS)} = ${TREND_SMAS.length * VOL_DEFS.length * BREADTH_SMAS.length} definition sets\n`);

const results: DefResult[] = [];
for (const trendSma of TREND_SMAS)
  for (const [volN, volLb] of VOL_DEFS)
    for (const breadthSma of BREADTH_SMAS)
      results.push(evalDefinition(trendSma, volN, volLb, breadthSma));

// per-definition table. nullMean/null95 = time-shuffle permutation null (meaningless regime split);
// p = P(null defensive count >= observed). A real pattern → observed >> null, p small.
console.log(`  ${"trend".padEnd(6)}${"vol".padEnd(10)}${"brd".padEnd(5)}${"leads".padEnd(6)}${"DEF".padEnd(5)}${"trDEF".padEnd(6)}${"surv".padEnd(5)}${"bestT".padEnd(7)}${"nullMean".padEnd(9)}${"null95".padEnd(8)}${"p".padEnd(7)}`);
for (const r of results) {
  console.log(
    `  ${String(r.trendSma).padEnd(6)}${`(${r.volN},${r.volLb})`.padEnd(10)}${String(r.breadthSma).padEnd(5)}` +
    `${String(r.leads).padEnd(6)}${String(r.defensive).padEnd(5)}${String(r.trendDef).padEnd(6)}` +
    `${String(r.survivors).padEnd(5)}${r.bestT.toFixed(2).padEnd(7)}${r.chanceDefensive.toFixed(1).padEnd(9)}${String(r.perm95).padEnd(8)}${r.permPval.toFixed(3).padEnd(7)}`,
  );
}

// ---- aggregate verdict -----------------------------------------------------------------------
const defCounts = results.map((r) => r.defensive).sort((a, b) => a - b);
const leadCounts = results.map((r) => r.leads).sort((a, b) => a - b);
const chanceCounts = results.map((r) => r.chanceDefensive);
const trendDefCounts = results.map((r) => r.trendDef);
const survTotal = results.reduce((s, r) => s + r.survivors, 0);
const median = (a: number[]) => a.length % 2 ? a[a.length >> 1] : (a[(a.length >> 1) - 1] + a[a.length >> 1]) / 2;
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;

const defMin = defCounts[0], defMax = defCounts[defCounts.length - 1], defMed = median(defCounts), defMean = mean(defCounts);
const nullMeanAgg = mean(chanceCounts);                                  // avg permutation-null defensive count
const fracPresent = results.filter((r) => r.defensive > 0).length / results.length;
const fracAboveNull = results.filter((r) => r.defensive > r.chanceDefensive).length / results.length;
const fracAboveNull95 = results.filter((r) => r.defensive > r.perm95).length / results.length;
const fracSig = results.filter((r) => r.permPval <= 0.05).length / results.length;
const trendDefMin = Math.min(...trendDefCounts), trendDefMax = Math.max(...trendDefCounts), trendDefMean = mean(trendDefCounts);
const defsWithTrendDef = results.filter((r) => r.trendDef > 0).length;
const medPval = median(results.map((r) => r.permPval).sort((a, b) => a - b));

console.log(`\n  ── AGGREGATE OVER ${results.length} DEFINITION SETS ──`);
console.log(`  defensive count: min ${defMin} · median ${defMed} · mean ${defMean.toFixed(1)} · max ${defMax}; present (>0) in ${(fracPresent * 100).toFixed(0)}% of defs`);
console.log(`  permutation null (time-shuffled labels, ${N_PERM} perms/def): mean defensive ${nullMeanAgg.toFixed(1)}`);
console.log(`  observed > null-mean in ${(fracAboveNull * 100).toFixed(0)}% of defs; observed > null-95th-pct in ${(fracAboveNull95 * 100).toFixed(0)}% of defs`);
console.log(`  permutation p<=0.05 (observed defensive not explained by chance) in ${(fracSig * 100).toFixed(0)}% of defs; median p=${medPval.toFixed(3)}`);
console.log(`  trend-portfolio defensive cells: min ${trendDefMin} · mean ${trendDefMean.toFixed(1)} · max ${trendDefMax}; >0 in ${defsWithTrendDef}/${results.length} defs`);
console.log(`  leads (>=0.3 excess Sharpe): min ${leadCounts[0]} · median ${median(leadCounts)} · max ${leadCounts[leadCounts.length - 1]}`);
console.log(`  Bonferroni survivors across ALL defs: ${survTotal} (best single-cell t over all defs = ${Math.max(...results.map((r) => r.bestT)).toFixed(2)}, crit≈${results[0].critT.toFixed(2)})`);

// concentration check: across defs, are defensive cells concentrated in low-vol / bear regimes?
const lowVolBearHits = results.map((r) => r.topDefensive.filter((s) => /LOW_VOL|BEAR/.test(s)).length);
const totalTopDef = results.reduce((s, r) => s + r.topDefensive.length, 0);
const totalLowVolBear = lowVolBearHits.reduce((s, x) => s + x, 0);

console.log(`\n  concentration: ${totalLowVolBear}/${totalTopDef} top-defensive cells (top-4 per def) sit in a LOW_VOL or BEAR regime (${(100 * totalLowVolBear / totalTopDef).toFixed(0)}%).`);

// ---- verdict ---------------------------------------------------------------------------------
// The claim: the DEFENSIVE pattern PERSISTS across regime definitions (not a single-tuning
// artifact), concentrated in low-vol/bear. Two things must be true:
//   (a) PERSISTENCE: defensive cells appear (and are trend-led + low-vol/bear concentrated) under
//       essentially every definition — not just one tuning.
//   (b) NON-TRIVIALITY: the count exceeds what a meaningless (time-shuffled) regime split yields,
//       so it reflects real regime structure rather than arithmetic.
const persistence = fracPresent >= 0.95 && defsWithTrendDef >= results.length && defMed >= 5
  && (totalLowVolBear / totalTopDef) >= 0.8;
const nonTrivial = fracAboveNull95 >= 0.8 && medPval <= 0.05; // observed beats the shuffled null
let verdict: "HOLDS" | "FAILS" | "MIXED";
if (persistence && nonTrivial) verdict = "HOLDS";
else if (!persistence) verdict = "FAILS";
else verdict = "MIXED"; // persists across tunings but not separable from a chance split

console.log(`\n  VERDICT: ${verdict}`);
console.log(`    persistence(present>=95%, trendDef all defs, med>=5, lowvol/bear>=80%)=${persistence}`);
console.log(`    nonTrivial(observed > null-95 in >=80% defs, median perm-p<=0.05)=${nonTrivial}`);
console.log(`    ${verdict === "HOLDS"
  ? "The defensive pattern PERSISTS across every regime definition AND beats a time-shuffled null — robust, not a tuning artifact."
  : verdict === "MIXED"
  ? "The defensive pattern PERSISTS across every regime definition (NOT a single-tuning artifact) but its count is NOT separable from a time-shuffled regime split — consistent with the committed claim that it is a robust DESCRIPTIVE property, not a tradeable per-regime edge."
  : "The defensive pattern does NOT persist — it is sensitive to the specific regime tuning."}\n`);

await closeTsdb();
