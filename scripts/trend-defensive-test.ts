/**
 * trend-defensive-test — a PRE-REGISTERED, NO-SCAN test of ONE economic hypothesis:
 *
 *   "An equal-weight TREND portfolio is a beta-diversifier / crisis-alpha sleeve."
 *
 * The regime scan (scripts/regime-analysis.ts) found 0/195 individually-significant
 * per-regime alpha cells (best t≈2.2 << Bonferroni 3.47) but a recurring DEFENSIVE
 * pattern: the trend portfolio is positive while equal-weight buy-and-hold (beta) is
 * negative, concentrated in bear / low-vol. A scan is multiple-testing-contaminated.
 * This script instead states the single hypothesis up front and measures it OUT-OF-SAMPLE
 * with capture ratios — the standard test for a defensive / convex profile:
 *
 *   down-capture = mean(trend ret | beta<0) / mean(beta ret | beta<0)
 *   up-capture   = mean(trend ret | beta>0) / mean(beta ret | beta>0)
 *
 *   A defensive/crisis-alpha sleeve has down-capture MUCH lower than up-capture (convex
 *   participation), and ideally a POSITIVE mean return on down-beta days (down-capture < 0).
 *   A plain beta clone has down-capture ≈ up-capture ≈ 1.
 *
 * NO look-ahead: beta and trend are BOTH realized over the identical t→t+1 window from the
 * library functions; we only PARTITION the realized bars by the SAME-bar realized beta sign
 * (the textbook contemporaneous capture-ratio definition — symmetric, no peeking forward).
 * OOS = the last 30% of bars, the exact split regimeConditionalAlpha uses (so this is the
 * same out-of-sample window the scan reported, not a re-optimized one). No regime labels are
 * used anywhere. We also report the trend portfolio for SMA={20,50,100} and the relstr top-K
 * portfolios so the reader sees the profile is a property of trend-following, not one tuned N.
 *
 *   npx tsx scripts/trend-defensive-test.ts   (or: npm run test:trend-defensive)
 */
import "./_env.ts";
import { listProducts, getCandles, closeTsdb } from "../src/lib/db/candle-store.ts";
import { buildPriceSeries } from "../src/lib/backtest/candle/xsection.ts";
import {
  relativeStrengthReturns, defaultRelStrengthVariants,
  equalWeightBuyHoldReturns, equalWeightTrendReturns,
} from "../src/lib/backtest/candle/cross-asset.ts";
import { sharpe } from "../src/lib/backtest/candle/stats.ts";

const num = (name: string, def: number): number => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
};
const feeBps = num("--fee-bps", 10);
const oosFrac = num("--oos", 0.3);

// ---- helpers (no library code is modified; these are local report stats only) -------------
const mean = (a: number[]): number => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a: number[]): number => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const ann = (s: number): number => s * Math.sqrt(365);
const corr = (a: number[], b: number[]): number => {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; cov += da * db; va += da * da; vb += db * db; }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
};
/** Welch one-sample t of mean>0 and its per-bar Sharpe·√n (same t-stat convention as the scan). */
const tMeanGtZero = (a: number[]): number => (std(a) > 0 ? mean(a) / (std(a) / Math.sqrt(a.length)) : 0);
const pct = (x: number): string => `${(100 * x).toFixed(3)}%`;

// ---- load warehouse (REAL data; identical path to regime-analysis.ts) ---------------------
const products = await listProducts("ONE_DAY");
const rows: Record<string, Array<{ start_unix: number; close: number }>> = {};
for (const c of products) rows[c] = await getCandles(c, "ONE_DAY");
const { coins, data, days } = buildPriceSeries(rows);

// Same alignment as the scan: every series starts at maxL so beta/trend/relstr share a bar grid.
const relVariants = defaultRelStrengthVariants();
const maxL = Math.max(...relVariants.map((v) => v.L), 50); // 50 = the max regime SMA warmup in the scan
const beta = equalWeightBuyHoldReturns(coins, data, days, maxL);
const n = beta.length;
const split = Math.floor(n * (1 - oosFrac)); // OOS = last oosFrac, exactly like regimeConditionalAlpha
const oos = (a: number[]): number[] => a.slice(split);

const betaOos = oos(beta);
const downIdx: number[] = [];
const upIdx: number[] = [];
betaOos.forEach((r, i) => (r < 0 ? downIdx : r > 0 ? upIdx : null)?.push(i));

console.log(`\ntrend-defensive-test — PRE-REGISTERED, NO-SCAN beta-diversifier test`);
console.log(`  universe ${coins.length} coins · ${n} aligned bars · OOS=${oosFrac} → ${betaOos.length} OOS bars · ${feeBps}bps`);
console.log(`  OOS beta(equal-weight BH): ${downIdx.length} down-beta days, ${upIdx.length} up-beta days`);
console.log(`  OOS beta mean ret: down-days ${pct(mean(downIdx.map((i) => betaOos[i])))} · up-days ${pct(mean(upIdx.map((i) => betaOos[i])))} · all ${pct(mean(betaOos))}\n`);

type Profile = {
  label: string;
  corr: number;            // corr(strat, beta) over OOS
  downCap: number;         // mean(strat|beta<0) / mean(beta|beta<0)
  upCap: number;           // mean(strat|beta>0) / mean(beta|beta>0)
  meanDown: number;        // mean strat ret on down-beta days (POSITIVE = crisis-alpha)
  meanUp: number;          // mean strat ret on up-beta days
  meanAll: number;         // unconditional mean strat ret
  tDownGt0: number;        // t-stat that meanDown > 0
  stratShOos: number; betaShOos: number;
};

function profile(label: string, stratFull: number[]): Profile {
  const s = oos(stratFull);
  const sDown = downIdx.map((i) => s[i]);
  const sUp = upIdx.map((i) => s[i]);
  const bDown = downIdx.map((i) => betaOos[i]);
  const bUp = upIdx.map((i) => betaOos[i]);
  const meanDown = mean(sDown), meanUp = mean(sUp);
  return {
    label,
    corr: corr(s, betaOos),
    downCap: mean(bDown) !== 0 ? meanDown / mean(bDown) : NaN,
    upCap: mean(bUp) !== 0 ? meanUp / mean(bUp) : NaN,
    meanDown, meanUp, meanAll: mean(s),
    tDownGt0: tMeanGtZero(sDown),
    stratShOos: ann(sharpe(s)), betaShOos: ann(sharpe(betaOos)),
  };
}

// (a)(b)(c) TREND portfolios — the pre-registered subject. (d) relstr top-K for breadth.
const subjects: Array<{ label: string; rets: number[] }> = [
  ...[20, 50, 100].map((sma) => ({
    label: `trend${sma}`,
    rets: equalWeightTrendReturns(coins, data, days, sma, { feeBps, startIndex: maxL }),
  })),
  ...relVariants
    .filter((v) => v.topK <= 2 && (v.L === 20 || v.L === 30)) // a representative relstr slice
    .map((v) => ({ label: v.label, rets: relativeStrengthReturns(v, coins, data, days, { feeBps, startIndex: maxL }) })),
];

const profiles = subjects.map((x) => profile(x.label, x.rets));

const fmt = (x: number, d = 2): string => (Number.isFinite(x) ? x.toFixed(d) : "  n/a");
console.log(`  ${"portfolio".padEnd(12)} ${"corr".padEnd(6)} ${"downCap".padEnd(8)} ${"upCap".padEnd(7)} ${"meanDown".padEnd(10)} ${"meanUp".padEnd(9)} ${"meanAll".padEnd(9)} ${"tDown>0".padEnd(8)} ${"stratSh".padEnd(8)} betaSh`);
for (const p of profiles) {
  console.log(
    `  ${p.label.padEnd(12)} ${fmt(p.corr).padEnd(6)} ${fmt(p.downCap).padEnd(8)} ${fmt(p.upCap).padEnd(7)} ` +
    `${pct(p.meanDown).padEnd(10)} ${pct(p.meanUp).padEnd(9)} ${pct(p.meanAll).padEnd(9)} ${fmt(p.tDownGt0).padEnd(8)} ${fmt(p.stratShOos).padEnd(8)} ${fmt(p.betaShOos)}`,
  );
}

// ---- VERDICT (pre-registered decision rule) ----------------------------------------------
// Defensive/crisis-alpha = down-capture MEANINGFULLY < up-capture (convex participation),
// and/or a POSITIVE mean return on down-beta days. Beta clone = capture ratios ≈ equal (~1).
// We judge the TREND family (the registered subject); relstr is reported for context.
const trendProfiles = profiles.filter((p) => p.label.startsWith("trend"));
const convexGap = (p: Profile): number => p.upCap - p.downCap;          // positive = convex/defensive
const avgConvex = mean(trendProfiles.map(convexGap));
const avgDownCap = mean(trendProfiles.map((p) => p.downCap));
const avgUpCap = mean(trendProfiles.map((p) => p.upCap));
const anyPositiveDown = trendProfiles.some((p) => p.meanDown > 0);
const allConvex = trendProfiles.every((p) => convexGap(p) > 0.15); // up-capture clearly exceeds down

console.log(`\n  TREND family (registered subject): avg down-capture ${fmt(avgDownCap)} · avg up-capture ${fmt(avgUpCap)} · avg convexity gap ${fmt(avgConvex)}`);
console.log(`  any trend portfolio with POSITIVE mean return on down-beta days? ${anyPositiveDown ? "YES" : "no"}`);
console.log(`  down-capture clearly below up-capture (gap > 0.15) for ALL trend N? ${allConvex ? "YES" : "no"}`);

const defensive = allConvex || anyPositiveDown;
if (defensive) {
  console.log(`\n  ✓ DEFENSIVE/CONVEX PROFILE CONFIRMED OOS: trend participates much less in down-beta than up-beta`);
  console.log(`    (and/or earns positive return when beta is down). This is the crisis-alpha signature, NOT a beta clone.`);
} else {
  console.log(`\n  ✗ NO defensive convexity: trend's down-capture ≈ up-capture — it just tracks beta. Claim REFUTED.`);
}
console.log("");

await closeTsdb();
