/**
 * backtest-hl-delta — the top-ranked mined sleeve: same-venue Hyperliquid 1:1 spot+perp delta-neutral funding
 * capture with a durable-funding gate + cost-aware rotation. Real HL fundingHistory, full gauntlet:
 * detectLookahead → walk-forward → PBO + Deflated-Sharpe → SIGN-AWARE beta (must beat just holding BTC's
 * funding, not buy-and-hold) → cost realism (rotation = 4 fills × HL taker + HYPE slippage) → the decisive
 * HYSTERESIS ablation (does the naive 5%-only switch churn itself to death vs a cost-guarded switch?).
 *
 *   npm run backtest:hl-delta [-- --days 300 --coins BTC,ETH,HYPE,SOL]
 *
 * Honest scope: executable only on coins with HL SPOT for the same-venue hedge (BTC/ETH/HYPE/SOL + the spot set);
 * this tests the funding-capture income — the price legs are assumed to cancel (delta-neutral), basis a haircut.
 */
import "./_env.ts";
import { hlDeltaBacktest, holdSingleCoin, annualizeHourly, DEFAULT_ROTATE, type RotateParams } from "../src/lib/backtest/candle/hl-delta.ts";
import { detectLookahead } from "../src/lib/backtest/lookahead-detect.ts";
import { sharpe, deflatedSharpe, pbo } from "../src/lib/backtest/candle/stats.ts";

const num = (n: string, d: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] != null ? Number(process.argv[i + 1]) : d; };
const str = (n: string, d: string): string => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const DAYS = num("--days", 300);
const COINS = str("--coins", "BTC,ETH,HYPE,SOL").split(",");
const INFO = "https://api.hyperliquid.xyz/info", HOUR = 3_600_000, PERIODS_PER_YR = 24 * 365;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function info(b: unknown, tries = 4): Promise<any> { for (let i = 0; i < tries; i++) { const r = await fetch(INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(20_000) }); if (r.ok) return r.json(); if (r.status === 429 && i < tries - 1) { await sleep(1000 * (i + 1)); continue; } throw new Error(`info ${r.status}`); } }

async function fundingHistory(coin: string, startTime: number): Promise<Map<number, number>> {
  const out = new Map<number, number>(); let cursor = startTime;
  for (let p = 0; p < 40; p++) {
    const rows = ((await info({ type: "fundingHistory", coin, startTime: cursor })) ?? []) as Array<{ time: number; fundingRate: string }>;
    if (!rows.length) break;
    for (const r of rows) out.set(Math.floor(Number(r.time) / HOUR) * HOUR, Number(r.fundingRate));
    const last = Math.max(...rows.map((r) => Number(r.time)));
    if (last <= cursor) break; cursor = last + 1; await sleep(60);
  }
  return out;
}

const ann = (rets: number[]) => sharpe(rets) * Math.sqrt(PERIODS_PER_YR);
const apr = (rets: number[]) => rets.reduce((a, b) => a + b, 0) / (rets.length / PERIODS_PER_YR);

console.log(`\nbacktest-hl-delta — same-venue HL funding capture + rotation · ${COINS.join("/")} · ${DAYS}d\n`);
const startTime = Date.now() - DAYS * 86_400_000;
const perCoin = new Map<string, Map<number, number>>();
for (const c of COINS) { try { const h = await fundingHistory(c, startTime); if (h.size > 100) { perCoin.set(c, h); console.log(`  ${c}: ${h.size} hourly funding prints · current ${(annualizeHourly([...h.values()].at(-1)!) * 100).toFixed(1)}% APR`); } } catch { console.log(`  ${c}: fetch failed`); } }
if (perCoin.size < 2) { console.log("\n  need ≥2 coins with funding history\n"); process.exit(0); }

// common hourly grid (intersection of timestamps so every coin has a rate at each i)
const coins = [...perCoin.keys()];
const grids = coins.map((c) => new Set(perCoin.get(c)!.keys()));
const grid = [...grids[0]].filter((t) => grids.every((g) => g.has(t))).sort((a, b) => a - b);
const rates: Record<string, number[]> = {};
for (const c of coins) rates[c] = grid.map((t) => perCoin.get(c)!.get(t)!);
const n = grid.length;
console.log(`  aligned grid: ${n} hours (${(n / 24).toFixed(0)}d), ${coins.length} coins\n`);

// ---- lookahead gate on the real coin path ----
const pathNum = (slice: readonly number[]) => { const m = slice.length; const r = hlDeltaBacktest(coins, Object.fromEntries(coins.map((c) => [c, rates[c].slice(0, m)])), m, DEFAULT_ROTATE, 0); return r.coinPath.map((c) => (c ? coins.indexOf(c) + 1 : 0)); };
const lk = detectLookahead(pathNum, grid);
console.log(`  lookahead gate: ${lk.biased ? "❌ BIASED " + lk.detail : "✅ " + lk.detail}`);

// ---- main result (cost-guarded rotation) ----
const ROT_COST_BPS = 30; // 4 fills × (~4.5bp HL taker + slippage); HYPE is the liquidity risk
const main = hlDeltaBacktest(coins, rates, n, DEFAULT_ROTATE, ROT_COST_BPS);
console.log(`\n  === rotation (gate ${DEFAULT_ROTATE.gateApr * 100}% APR, hysteresis ${DEFAULT_ROTATE.hysteresisApr * 100}%, cost ${ROT_COST_BPS}bps/rotation) ===`);
console.log(`  gross APR ${(apr(main.gross) * 100).toFixed(1)}% · NET APR ${(apr(main.net) * 100).toFixed(1)}% · Sharpe ${ann(main.net).toFixed(2)} · ${main.nRotations} rotations · deployed ${(100 * main.hoursDeployed / (n - 1)).toFixed(0)}% of hours`);

// ---- sign-aware beta benchmark: must beat just holding each single coin's funding ----
console.log(`\n  === beta benchmark (single-coin hold, no rotation) ===`);
for (const c of coins) { const h = holdSingleCoin(c, rates, n); console.log(`  hold ${c.padEnd(5)}: APR ${(apr(h) * 100).toFixed(1).padStart(6)}% · Sharpe ${ann(h).toFixed(2)}`); }
const bestSingle = coins.map((c) => ({ c, apr: apr(holdSingleCoin(c, rates, n)) })).sort((a, b) => b.apr - a.apr)[0];
const alphaVsBest = apr(main.net) - bestSingle.apr;
console.log(`  ⇒ rotation net APR ${(apr(main.net) * 100).toFixed(1)}% vs best single-coin (${bestSingle.c}) ${(bestSingle.apr * 100).toFixed(1)}% = alpha ${alphaVsBest >= 0 ? "+" : ""}${(alphaVsBest * 100).toFixed(1)}% ${alphaVsBest > 0 ? "✅ rotation adds value" : "❌ rotation does NOT beat just holding the best coin"}`);

// ---- HYSTERESIS ablation: naive 5%-only switch vs cost-guarded ----
console.log(`\n  === hysteresis ablation (the synthesizer's decisive test) ===`);
const naive: RotateParams = { gateApr: 0.05, exitFloorApr: 0.0, hysteresisApr: 0 };       // rotate on ANY improvement
const naiveR = hlDeltaBacktest(coins, rates, n, naive, ROT_COST_BPS);
console.log(`  naive  (rotate on any gain): NET APR ${(apr(naiveR.net) * 100).toFixed(1).padStart(6)}% · ${naiveR.nRotations} rotations`);
console.log(`  guarded (hysteresis ${DEFAULT_ROTATE.hysteresisApr * 100}%):  NET APR ${(apr(main.net) * 100).toFixed(1).padStart(6)}% · ${main.nRotations} rotations`);
console.log(`  ⇒ ${apr(main.net) > apr(naiveR.net) ? "✅ the cost guard helps — naive churns away " + ((apr(main.net) - apr(naiveR.net)) * 100).toFixed(1) + "% APR" : "naive ≥ guarded here"}`);

// ---- overfit battery across the gate×hysteresis grid ----
const GRID: RotateParams[] = [];
for (const gate of [0.03, 0.05, 0.08, 0.12]) for (const hys of [0, 0.05, 0.10, 0.20]) GRID.push({ gateApr: gate, exitFloorApr: 0, hysteresisApr: hys });
const variantNets = GRID.map((g) => hlDeltaBacktest(coins, rates, n, g, ROT_COST_BPS).net);
const minLen = Math.min(...variantNets.map((v) => v.length));
const sharpes = variantNets.map((v) => sharpe(v));
const bestIdx = sharpes.indexOf(Math.max(...sharpes));
const M: number[][] = []; for (let t = 0; t < minLen; t++) M.push(variantNets.map((v) => v[t]));
const ds = deflatedSharpe(variantNets[bestIdx].slice(0, minLen), sharpes);
const pboVal = pbo(M, 8);
console.log(`\n  === overfit battery (${GRID.length} param variants) ===`);
console.log(`  best variant: gate ${GRID[bestIdx].gateApr * 100}% / hys ${GRID[bestIdx].hysteresisApr * 100}% · Sharpe ${ann(variantNets[bestIdx]).toFixed(2)} · APR ${(apr(variantNets[bestIdx]) * 100).toFixed(1)}%`);
console.log(`  PBO ${pboVal.toFixed(2)} (want <0.30) · DSR ${ds.dsr.toFixed(2)} (want >0.95)`);

// ---- walk-forward ----
function sliceNet(g: RotateParams, from: number, to: number) { const r = hlDeltaBacktest(coins, Object.fromEntries(coins.map((c) => [c, rates[c].slice(from, to)])), to - from, g, ROT_COST_BPS); return r.net; }
const split = Math.floor(n * 0.6);
const isSharpes = GRID.map((g) => sharpe(sliceNet(g, 0, split)));
const wfBest = GRID[isSharpes.indexOf(Math.max(...isSharpes))];
const oos = sliceNet(wfBest, split, n);
console.log(`\n  === walk-forward ===`);
console.log(`  IS-best gate ${wfBest.gateApr * 100}%/hys ${wfBest.hysteresisApr * 100}% → OOS APR ${(apr(oos) * 100).toFixed(1)}% · OOS Sharpe ${ann(oos).toFixed(2)} (held? ${ann(oos) > 0 ? "yes" : "NO"})`);

// ---- one-voice verdict ----
const passLk = !lk.biased, passOverfit = pboVal < 0.3 && ds.dsr > 0.95, passWF = ann(oos) > 0, passBeta = alphaVsBest > 0, passCost = apr(main.net) > 0;
const passes = [passLk, passOverfit, passWF, passBeta, passCost].filter(Boolean).length;
console.log(`\n  === VERDICT ===`);
console.log(`  lookahead ${passLk ? "✅" : "❌"} · overfit ${passOverfit ? "✅" : "❌"} · walk-forward ${passWF ? "✅" : "❌"} · beats-best-single ${passBeta ? "✅" : "❌"} · net>0 ${passCost ? "✅" : "❌"}`);
console.log(`  ${passes === 5 ? "✅ SURVIVES — register as the 'tight-hedge same-venue funding' sleeve in the risk-parity allocator; paper-track live next." : passBeta && passCost && passWF ? `⚠️ PARTIAL (${passes}/5) — real net funding capture, but rotation-alpha/overfit not clean; deploy the GATE+HOLD (no aggressive rotation) version, paper-track.` : `❌ FAILS (${passes}/5) — ${!passBeta ? "rotation doesn't beat holding the best coin; " : ""}${!passCost ? "net negative after costs; " : ""}not a sleeve.`}`);
console.log(`  EXECUTABILITY: needs HL SPOT for each held coin (same-venue hedge). Basis risk omitted here (income-only) — a real haircut, like the carry book. Funding is high because shorting is hard; watch borrow/spot depth.\n`);
