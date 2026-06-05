/**
 * _carry-staking-hedged-yield — STAKING-HEDGED YIELD CARRY (delta-neutral staking yield + funding).
 *
 * EDGE: Stake ETH/SOL → earn the protocol yield (ETH ≈3.2%/yr, SOL ≈7%/yr — stable constants).
 * That long spot exposure is delta-hedged by a SHORT perp, so the price risk cancels and what's
 * left is the STAKING YIELD as a near-cash, market-neutral return. BONUS: the short perp ALSO
 * settles funding — when funding is POSITIVE the short COLLECTS it (double income: staking + funding);
 * when funding is NEGATIVE the short PAYS it (drag on the staking yield). Funding on majors has been
 * structurally positive (perp longs pay), so the expectation is staking-yield PLUS a funding tailwind.
 *
 * MODEL (NO-LOOKAHEAD): the position (long staked spot + short perp) is decided from data ≤ day i and
 * realized over i→i+1. The delta-neutral DAILY return is:
 *     net[i] = stakingYieldPerDay  +  fundingCollectedByShort[i]  −  hedgeFeePerDay
 * where fundingCollectedByShort[i] = +dailyFunding[i] (short receives positive funding, pays negative);
 * dailyFunding[i] = sum of the 3 known 8-hourly funding intervals on day i (funding[i] known AT i).
 * The two PRICE legs (long spot, short perp) cancel to first order so no price series is needed — that
 * cancellation IS the hedge, and the residual basis/tracking error is the model's honest omission
 * (perp ≠ spot move identically; we note that as a caveat, not a P&L line).
 *
 * The hedge is a STATIC delta-neutral hold (no daily rebalance / no signal flips), so turnover is ~0
 * after entry. We therefore charge a small CONTINUOUS hedge-carry drag (`--hedge-bps-yr`, default 0 — the
 * short funding IS the perp cost/credit and is already in the cash flow) plus a one-time ENTRY cost
 * (`--entry-bps`, two legs) amortized only for reporting. Benchmark = CASH (zeros): a market-neutral
 * carry must beat doing nothing. Annualize Sharpe by √365.
 *
 * CONTROL: we also report the PLAIN funding carry (short-only funding, NO staking yield) over the same
 * window so we can answer "does staking yield ADD to plain funding carry?" — the task's explicit test.
 *
 *   npx tsx scripts/_carry-staking-hedged-yield.ts [--fee-bps 1] [--entry-bps 5] [--hedge-bps-yr 0]
 *     [--unbond-bps-yr 0] [--slashing-bps-yr 0] [--depeg-bps-yr 0] [--stress-bps-yr 20]
 */
import "./_env.ts";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { sharpe, deflatedSharpe, pbo } from "../src/lib/backtest/candle/stats.ts";
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";
import {
  stakingHedgedReturns as libStakingHedgedReturns,
  plainFundingReturns as libPlainFundingReturns,
  feeRobustness,
  totalRiskHaircutYr,
  type RiskHaircut,
} from "../src/lib/exec/staking-hedged.ts";

const DAY = 86_400;
const PERIODS_PER_YEAR = 365;
const arg = (n: string, def: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] != null ? Number(process.argv[i + 1]) : def; };
const feeBps = arg("--fee-bps", 1);          // per-leg cost when the hedge rebalances (~static here, so ~0 turnover)
const entryBps = arg("--entry-bps", 5);      // one-time round-trip entry cost (2 legs), reported amortized
const hedgeBpsYr = arg("--hedge-bps-yr", 0); // extra continuous hedge drag in bps/yr (0: funding already captures perp cost)

// The OMITTED-RISK haircut — explicit annual penalties for the tail risks the headline yield hides.
const risk: RiskHaircut = {
  unbondBpsYr: arg("--unbond-bps-yr", 0),     // unbond/exit-queue illiquidity (hedge can drift naked)
  slashingBpsYr: arg("--slashing-bps-yr", 0), // expected annual slashing loss
  depegBpsYr: arg("--depeg-bps-yr", 0),       // LST depeg mark-to-market drag
};
const stressBpsYr = arg("--stress-bps-yr", 20); // fee-robustness: survive this much EXTRA annual cost?

// Stable protocol staking yields (annual), per the edge spec.
const STAKING_YIELD_YR: Record<string, number> = { ETH: 0.032, SOL: 0.07 };
const COINS = ["ETH", "SOL"];

const dir = resolve(process.cwd(), "data", "funding");
const annualize = (perDaySharpe: number) => perDaySharpe * Math.sqrt(365);
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const mean = (a: number[]) => (a.length ? sum(a) / a.length : 0);

type FundingRow = { time: number; rate: number };
function loadFunding(coin: string): FundingRow[] {
  const p = resolve(dir, `${coin}.binance.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n")
    .map((l) => JSON.parse(l) as FundingRow).sort((a, b) => a.time - b.time);
}

/** Bucket 8-hourly funding into per-UTC-day sums. Returns days[] (unix midnight) + dailyRate[] aligned. */
function dailyFunding(funding: FundingRow[]): { days: number[]; rate: number[] } {
  const byDay = new Map<number, number>();
  for (const f of funding) {
    const d = Math.floor(f.time / DAY) * DAY;
    byDay.set(d, (byDay.get(d) ?? 0) + f.rate);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  return { days, rate: days.map((d) => byDay.get(d)!) };
}

/** Delta-neutral STAKING-HEDGED daily returns, NO-LOOKAHEAD (lib does the arithmetic + risk haircut). */
function stakingHedgedReturns(coin: string, dailyRate: number[]): number[] {
  return libStakingHedgedReturns(dailyRate, {
    stakeApy: STAKING_YIELD_YR[coin] ?? 0,
    hedgeBpsYr, entryBps, periodsPerYear: PERIODS_PER_YEAR, risk,
  });
}

/** CONTROL: plain funding carry — short-only, NO staking yield, NO staking-specific haircut. */
function plainFundingReturns(dailyRate: number[]): number[] {
  return libPlainFundingReturns(dailyRate, { hedgeBpsYr, entryBps, periodsPerYear: PERIODS_PER_YEAR });
}

const haircutPct = totalRiskHaircutYr(risk) * 100;
console.log(`\n=== STAKING-HEDGED YIELD CARRY (delta-neutral) ===`);
console.log(`fees: entry ${entryBps}bps round-trip, hedge drag ${hedgeBpsYr}bps/yr, rebalance ${feeBps}bps (static hold ⇒ ~0 turnover)`);
console.log(`omitted-risk haircut: ${haircutPct.toFixed(2)}%/yr (unbond ${risk.unbondBpsYr}bps, slashing ${risk.slashingBpsYr}bps, depeg ${risk.depegBpsYr}bps)`);
console.log(`staking yields: ${COINS.map((c) => `${c} ${(STAKING_YIELD_YR[c] * 100).toFixed(1)}%/yr`).join(", ")}\n`);

type CoinResult = { coin: string; days: number[]; rate: number[]; staked: number[]; plain: number[]; fundingApr: number; nDays: number };
const results: CoinResult[] = [];

for (const coin of COINS) {
  const funding = loadFunding(coin);
  if (!funding.length) { console.log(`  ${coin}: NO funding data`); continue; }
  const { days, rate } = dailyFunding(funding);
  if (days.length < 60) { console.log(`  ${coin}: only ${days.length} days — too thin`); continue; }
  const staked = stakingHedgedReturns(coin, rate);
  const plain = plainFundingReturns(rate);
  const fundingApr = mean(rate) * 365; // mean daily funding annualized
  results.push({ coin, days, rate, staked, plain, fundingApr, nDays: days.length });

  const sStaked = sum(staked), sPlain = sum(plain);
  const shStaked = annualize(sharpe(staked)), shPlain = annualize(sharpe(plain));
  console.log(`  ${coin}: ${days.length} days | funding APR ${(fundingApr * 100).toFixed(2)}% | staking ${(STAKING_YIELD_YR[coin] * 100).toFixed(1)}%`);
  console.log(`     STAKED-HEDGED: cum ${(sStaked * 100).toFixed(2)}%  → APR ${(sStaked / days.length * 365 * 100).toFixed(2)}%  ann.Sharpe ${shStaked.toFixed(2)}`);
  console.log(`     PLAIN FUNDING: cum ${(sPlain * 100).toFixed(2)}%  → APR ${(sPlain / days.length * 365 * 100).toFixed(2)}%  ann.Sharpe ${shPlain.toFixed(2)}`);
  console.log(`     ADD FROM STAKING: +${((sStaked - sPlain) / days.length * 365 * 100).toFixed(2)}% APR  (Sharpe ${shStaked.toFixed(2)} vs ${shPlain.toFixed(2)})\n`);
}

if (!results.length) { console.log("\n  no coin had usable funding data\n"); process.exit(0); }

// Equal-weight portfolio across coins on the common day grid (held both legs per coin).
const allDays = [...new Set(results.flatMap((r) => r.days))].sort((a, b) => a - b);
const idxByCoin = results.map((r) => new Map(r.days.map((d, i) => [d, i])));
function portfolio(pick: (r: CoinResult, i: number) => number): number[] {
  return allDays.map((d) => {
    let s = 0, c = 0;
    results.forEach((r, ci) => { const i = idxByCoin[ci].get(d); if (i != null) { s += pick(r, i); c++; } });
    return c ? s / c : 0;
  });
}
const pStaked = portfolio((r, i) => r.staked[i]);
const pPlain = portfolio((r, i) => r.plain[i]);
const bench = allDays.map(() => 0); // CASH

// ---- GAUNTLET ----
const cum = (a: number[]) => sum(a);
const aprOf = (a: number[]) => (a.length ? cum(a) / a.length * 365 : 0);
const shStaked = annualize(sharpe(pStaked));
const shPlain = annualize(sharpe(pPlain));

// PBO + DSR: the "configs" are the staking-hedged carry vs the plain-funding control across the
// fee/yield assumptions we report — a small honest trial set (per-coin staked, per-coin plain, portfolio).
// Align every config onto the portfolio day-grid for the PBO matrix.
const configs: Array<{ label: string; ret: number[] }> = [];
for (const r of results) {
  configs.push({ label: `${r.coin}-staked`, ret: allDays.map((d) => { const i = idxByCoin[results.indexOf(r)].get(d); return i != null ? r.staked[i] : 0; }) });
  configs.push({ label: `${r.coin}-plain`, ret: allDays.map((d) => { const i = idxByCoin[results.indexOf(r)].get(d); return i != null ? r.plain[i] : 0; }) });
}
configs.push({ label: "portfolio-staked", ret: pStaked });
configs.push({ label: "portfolio-plain", ret: pPlain });

const M: number[][] = allDays.map((_, t) => configs.map((c) => c.ret[t]));
const pboVal = pbo(M, 8);
const trialSharpes = configs.map((c) => sharpe(c.ret));
const { dsr, sr, sr0 } = deflatedSharpe(pStaked, trialSharpes);

console.log(`=== PORTFOLIO (equal-weight ETH+SOL, delta-neutral staking-hedged) ===`);
console.log(`  days ${allDays.length}`);
console.log(`  STAKED-HEDGED: cum ${(cum(pStaked) * 100).toFixed(2)}%  → APR ${(aprOf(pStaked) * 100).toFixed(2)}%  ann.Sharpe ${shStaked.toFixed(2)}`);
console.log(`  PLAIN FUNDING: cum ${(cum(pPlain) * 100).toFixed(2)}%  → APR ${(aprOf(pPlain) * 100).toFixed(2)}%  ann.Sharpe ${shPlain.toFixed(2)}`);
console.log(`  STAKING ADDS:  +${((aprOf(pStaked) - aprOf(pPlain)) * 100).toFixed(2)}% APR, Sharpe ${shStaked.toFixed(2)} vs ${shPlain.toFixed(2)}`);
console.log(`  BEATS PLAIN FUNDING CARRY? ${shStaked > shPlain ? "YES" : "NO"} (Sharpe) / ${aprOf(pStaked) > aprOf(pPlain) ? "YES" : "NO"} (APR)`);

// FEE-ROBUSTNESS: does each coin's staking-hedged carry still clear 0% APR after `stressBpsYr` extra cost?
const robustness = results.map((r) => ({
  coin: r.coin,
  fr: feeRobustness(r.rate, { stakeApy: STAKING_YIELD_YR[r.coin] ?? 0, hedgeBpsYr, entryBps, periodsPerYear: PERIODS_PER_YEAR, risk }, stressBpsYr, 0),
}));
const allSurvive = robustness.every((x) => x.fr.survives);
console.log(`  FEE-ROBUST (+${stressBpsYr}bps/yr stress, floor 0% APR): ${robustness.map((x) => `${x.coin} ${x.fr.survives ? "✓" : "✗"} (${x.fr.stressAprNet >= 0 ? "+" : ""}${(x.fr.stressAprNet * 100).toFixed(2)}%)`).join(", ")} → ${allSurvive ? "ALL SURVIVE" : "SOME FAIL"}`);
console.log(`\n  GAUNTLET:  ann.Sharpe ${shStaked.toFixed(2)} | PBO ${pboVal.toFixed(2)} | DSR ${dsr.toFixed(3)} (SR ${sr.toFixed(3)} vs SR0 ${sr0.toFixed(3)})\n`);

// ---- ADVISOR (benchmark = CASH) ----
const memo = adviseTrade({
  label: "staking-hedged-yield-carry",
  strategyReturns: pStaked,
  benchmarkReturns: bench,
  pbo: pboVal,
  dsr,
  oosFrac: 0.4,
  betaAttractive: false,       // cash benchmark has no beta to own
  search: { hypothesesScanned: configs.length, bonferroniSurvivors: shStaked > 0 && pboVal < 0.3 ? 1 : 0 },
});
console.log(renderTradeMemo(memo));

// ---- machine-readable summary line for the harness ----
console.log(`\nRESULT_JSON ${JSON.stringify({
  annSharpe: Number(shStaked.toFixed(3)),
  annReturnPct: Number((aprOf(pStaked) * 100).toFixed(3)),
  plainFundingSharpe: Number(shPlain.toFixed(3)),
  plainFundingAprPct: Number((aprOf(pPlain) * 100).toFixed(3)),
  beatsPlainFunding: shStaked > shPlain,
  pbo: Number(pboVal.toFixed(3)),
  dsr: Number(dsr.toFixed(3)),
  days: allDays.length,
  riskHaircutPct: Number(haircutPct.toFixed(3)),
  stressBpsYr,
  feeRobustAllSurvive: allSurvive,
  recommendation: memo.recommendation,
  conviction: memo.conviction,
})}`);
