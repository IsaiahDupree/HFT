/**
 * backtest-stable-mr — run the stablecoin-peg mean-reversion hypothesis through the full gauntlet on REAL
 * Binance hourly klines. The catalog says crypto is momentum (pairs-MR dies); stables are the structural
 * exception (pinned by redemption/arb → deviations revert). This is the honest test: no-lookahead backtest
 * across a threshold grid → walk-forward (IS pick / OOS measure) → PBO + Deflated-Sharpe (overfit battery) →
 * BLOCK-SHUFFLE control (MR is a timing edge, so shuffling bar order must HURT) → beta benchmark (hold the
 * stable ≈ 0) → cost realism. A number that survives all of it is an edge; anything that dies is noise.
 *
 *   npm run backtest:stable-mr [-- --days 540 --fee 2]
 */
import "./_env.ts";
import { proxiedFetch } from "../src/lib/data/proxy-fetch.ts";
import { mrReturns, holdReturns, type Bar, type MrParams } from "../src/lib/exec/stable-mr.ts";
import { sharpe, deflatedSharpe, pbo } from "../src/lib/backtest/candle/stats.ts";
import { lcgRng, blockShufflePermutation, applyPermutation, permutationTest } from "../src/lib/backtest/shuffle-control.ts";

const num = (n: string, d: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] != null ? Number(process.argv[i + 1]) : d; };
const DAYS = num("--days", 540), FEE = num("--fee", 2);                 // fee in bps per side (round-trip = 2×)
const PERIODS_PER_YR = 24 * 365;
const COINS = ["USDCUSDT", "DAIUSDT", "TUSDUSDT", "FDUSDUSDT", "USDPUSDT"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function klines(symbol: string, days: number): Promise<Bar[]> {
  const out: Bar[] = []; let endTime = Date.now(); const want = days * 24;
  while (out.length < want) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=1000&endTime=${endTime}`;
    const r = await proxiedFetch(url); if (!r.ok) break;
    const rows = (await r.json()) as unknown[][];
    if (!rows.length) break;
    const batch = rows.map((k) => ({ time: Number(k[0]), close: Number(k[4]) }));
    out.unshift(...batch);
    endTime = Number(rows[0][0]) - 1;
    if (rows.length < 1000) break;
    await sleep(120);
  }
  // dedup + sort
  const seen = new Set<number>();
  return out.filter((b) => Number.isFinite(b.close) && b.close > 0 && !seen.has(b.time) && seen.add(b.time)).sort((a, b) => a.time - b.time).slice(-want);
}

const ann = (rets: number[]) => sharpe(rets) * Math.sqrt(PERIODS_PER_YR);
const total = (rets: number[]) => rets.reduce((a, b) => a + b, 0);
const apr = (rets: number[]) => total(rets) / (rets.length / PERIODS_PER_YR);

// variant grid (entry / exit / maxHold in hours)
const VARIANTS: Array<{ label: string; p: MrParams }> = [];
for (const entry of [0.001, 0.002, 0.003, 0.005]) for (const maxHold of [48, 168]) VARIANTS.push({ label: `e${entry}/h${maxHold}`, p: { entry, exit: 0.0005, maxHold } });

console.log(`\nbacktest-stable-mr — stablecoin peg mean-reversion · ${COINS.length} coins · ${DAYS}d hourly · fee ${FEE}bps/side\n`);
const data = new Map<string, Bar[]>();
for (const c of COINS) { try { const b = await klines(c, DAYS); if (b.length > 200) { data.set(c, b); console.log(`  ${c}: ${b.length} hourly bars (${new Date(b[0].time).toISOString().slice(0, 10)} → ${new Date(b.at(-1)!.time).toISOString().slice(0, 10)})`); } } catch (e) { console.log(`  ${c}: fetch failed`); } }
if (!data.size) { console.log("\n  no data — proxy down?\n"); process.exit(0); }

// pooled net returns per variant = concatenation of every coin's per-bar net returns
function pooledNet(p: MrParams, fee: number): number[] { const out: number[] = []; for (const b of data.values()) out.push(...mrReturns(b, p, fee).net); return out; }
function pooledTrades(p: MrParams): number { let n = 0; for (const b of data.values()) n += mrReturns(b, p, FEE).nTrades; return n; }

// ---- per-variant stats ----
console.log(`\n  variant       trades  APR      Sharpe(ann)`);
const variantRets = VARIANTS.map((v) => ({ ...v, net: pooledNet(v.p, FEE) }));
for (const v of variantRets) console.log(`  ${v.label.padEnd(12)}  ${String(pooledTrades(v.p)).padStart(5)}  ${(apr(v.net) * 100).toFixed(2).padStart(6)}%  ${ann(v.net).toFixed(2).padStart(6)}`);

// ---- overfit battery: PBO + DSR across the grid (align variants to a common length) ----
const minLen = Math.min(...variantRets.map((v) => v.net.length));
const M: number[][] = []; for (let t = 0; t < minLen; t++) M.push(variantRets.map((v) => v.net[t]));
const sharpes = variantRets.map((v) => sharpe(v.net));
const best = variantRets[sharpes.indexOf(Math.max(...sharpes))];
const ds = deflatedSharpe(best.net.slice(0, minLen), sharpes);
const pboVal = pbo(M, 8);
console.log(`\n  === overfit battery ===`);
console.log(`  best variant: ${best.label} · APR ${(apr(best.net) * 100).toFixed(1)}% · Sharpe ${ann(best.net).toFixed(2)}`);
console.log(`  PBO ${pboVal.toFixed(2)} (want <0.30) · DSR ${ds.dsr.toFixed(2)} (want >0.95)`);

// ---- walk-forward: pick best on IS (first 70%), measure OOS ----
function slicePooled(p: MrParams, fromFrac: number, toFrac: number): number[] { const out: number[] = []; for (const b of data.values()) { const r = mrReturns(b, p, FEE).net; out.push(...r.slice(Math.floor(r.length * fromFrac), Math.floor(r.length * toFrac))); } return out; }
const isSharpes = VARIANTS.map((v) => sharpe(slicePooled(v.p, 0, 0.7)));
const wfBest = VARIANTS[isSharpes.indexOf(Math.max(...isSharpes))];
const oos = slicePooled(wfBest.p, 0.7, 1);
console.log(`\n  === walk-forward ===`);
console.log(`  IS-best ${wfBest.label} → OOS APR ${(apr(oos) * 100).toFixed(1)}% · OOS Sharpe ${ann(oos).toFixed(2)} (held? ${ann(oos) > 0 ? "yes" : "NO"})`);

// ---- block-shuffle control: MR needs real temporal structure; shuffling bar order must HURT ----
const rng = lcgRng(7);
const realSharpe = ann(best.net);
const nullSharpes: number[] = [];
for (let k = 0; k < 200; k++) {
  const pooled: number[] = [];
  for (const b of data.values()) { const perm = blockShufflePermutation(b.length, 24, rng); const shuffled = applyPermutation(b, perm).map((x, i) => ({ time: i, close: x.close })); pooled.push(...mrReturns(shuffled, best.p, FEE).net); }
  nullSharpes.push(ann(pooled));
}
const perm = permutationTest(realSharpe, nullSharpes, "greater");
console.log(`\n  === block-shuffle control (24h blocks, 200 perms) ===`);
console.log(`  real Sharpe ${realSharpe.toFixed(2)} vs shuffled null mean ${(nullSharpes.reduce((a, b) => a + b, 0) / nullSharpes.length).toFixed(2)} · p=${perm.pValue.toFixed(3)} (want <0.05 ⇒ real structure)`);

// ---- beta benchmark + cost realism ----
const betaRets: number[] = []; for (const b of data.values()) betaRets.push(...holdReturns(b));
console.log(`\n  === beta benchmark + cost realism ===`);
console.log(`  hold-the-stable beta APR ${(apr(betaRets) * 100).toFixed(2)}% (≈0 ⇒ MR is ~pure alpha)`);
for (const f of [1, 2, 5, 10]) { const r = pooledNet(best.p, f); console.log(`  fee ${String(f).padStart(2)}bps/side → APR ${(apr(r) * 100).toFixed(1).padStart(6)}% · Sharpe ${ann(r).toFixed(2)}`); }

// ---- one-voice verdict ----
const passOverfit = pboVal < 0.3 && ds.dsr > 0.95;
const passWF = ann(oos) > 0;
const passShuffle = perm.pValue < 0.05;
const passCost = apr(pooledNet(best.p, 5)) > 0;
const passes = [passOverfit, passWF, passShuffle, passCost].filter(Boolean).length;
console.log(`\n  === VERDICT ===`);
console.log(`  overfit ${passOverfit ? "✅" : "❌"} · walk-forward ${passWF ? "✅" : "❌"} · shuffle ${passShuffle ? "✅" : "❌"} · cost@5bps ${passCost ? "✅" : "❌"}`);
console.log(`  ${passes === 4 ? "✅ SURVIVES the gauntlet — a real structural MR edge. Paper-track next." : passes >= 2 ? `⚠️ PARTIAL (${passes}/4) — promising but not clean; ${!passShuffle ? "shuffle says no real temporal structure; " : ""}${!passCost ? "fee-dominated; " : ""}${!passOverfit ? "overfit; " : ""}${!passWF ? "OOS faded; " : ""}do not size.` : `❌ FAILS (${passes}/4) — not an edge.`}`);
console.log(`\n  TAIL RISK (not in the Sharpe): a stable that depegs and NEVER recovers (UST→0). Trade only collateralized stables; size for the terminal-collapse tail, not the Sharpe.\n`);
