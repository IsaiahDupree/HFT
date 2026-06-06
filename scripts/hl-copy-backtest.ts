/**
 * hl-copy-backtest — would following the VERIFIED smart-money cohort have paid, and is their flow PREDICTIVE
 * or REACTIVE? Ranks copyable wallets, keeps only the realized-profitable ones (verified by their own fills),
 * reconstructs each one's signed position over time per coin, sums to a cohort net position on the hourly
 * candle grid, and scores: (1) a NO-LOOKAHEAD copy-strategy (go the cohort's net direction) vs a shuffle
 * control, and (2) lead-lag — does cohort flow LEAD price (k>0, copyable) or LAG it (k<0, chasing).
 *
 *   npm run hl:copy-backtest [-- --top 40 --days 14 --coins BTC,ETH,SOL,HYPE]
 *
 * HONEST CAVEAT (printed): the cohort is selected on TODAY's profitability, so the copy-strategy P&L is
 * survivorship-biased UP. The lead-lag sign is the more trustworthy read (predictive vs reactive flow).
 */
import "./_env.ts";
import { parseLeaderboard, rankWallets, realizedStats, isVerifiedProfitable, DEFAULT_RANK, type Fill as SmFill } from "../src/lib/exec/smart-money.ts";
import { reconstructPositionSeries, cohortNetAt, copyStrategyReturns, pctReturns, leadLag, sharpe, hitRate, totalReturn, type Fill } from "../src/lib/exec/copy-backtest.ts";

const num = (n: string, d: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const arg = (n: string, d: string): string => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const TOP = num("--top", 40), DAYS = num("--days", 14);
const COINS = arg("--coins", "BTC,ETH,SOL,HYPE").split(",");
const INFO = "https://api.hyperliquid.xyz/info";
const LB = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
async function jget(url: string): Promise<any> { const r = await fetch(url, { signal: AbortSignal.timeout(30_000) }); if (!r.ok) throw new Error(`${url.slice(0, 50)} ${r.status}`); return r.json(); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function info(b: unknown, tries = 4): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(20_000) });
    if (r.ok) return r.json();
    if (r.status === 429 && i < tries - 1) { await sleep(1500 * (i + 1)); continue; } // backoff on rate limit
    throw new Error(`info ${r.status}`);
  }
}
function lcg(seed: number): () => number { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 0xffffffff; }; }
const shuffle = <T,>(a: T[], r: () => number): T[] => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };

console.log(`\nhl-copy-backtest — does following verified HL smart money pay? · top ${TOP} · ${DAYS}d hourly · coins ${COINS.join(",")}\n`);

// 1) rank → keep verified-profitable wallets, collect their fills
const rows = parseLeaderboard(await jget(LB));
const ranked = rankWallets(rows, DEFAULT_RANK).slice(0, TOP);
const verified: Array<{ addr: string; fills: Array<Fill & { closedPnl: number }> }> = [];
for (const w of ranked) {
  try {
    const raw = (await info({ type: "userFills", user: w.address })) as Array<Record<string, unknown>>;
    const fills = raw.map((f) => ({ coin: String(f.coin), dir: String(f.dir ?? ""), sz: Number(f.sz), px: Number(f.px), time: Number(f.time), closedPnl: Number(f.closedPnl ?? 0) }));
    if (isVerifiedProfitable(realizedStats(fills as unknown as SmFill[]))) verified.push({ addr: w.address, fills });
    await sleep(70);
  } catch { /* skip */ }
}
console.log(`  ${ranked.length} ranked → ${verified.length} verified-profitable wallets contribute to the cohort\n`);

// 2) per coin: cohort flow vs price
console.log(`  ${"coin".padEnd(6)} ${"wallets".padEnd(8)} ${"copyRet".padEnd(9)} ${"sharpe".padEnd(8)} ${"hit".padEnd(6)} ${"shuf-p".padEnd(8)} ${"lead-lag (k=-2..+2 corr)".padEnd(30)} read`);
const now = Date.now(), startMs = now - DAYS * 86_400_000;
await sleep(2000); // let the rate-limit window cool after the userFills burst before the candle calls
for (const coin of COINS) {
  try {
    await sleep(400);
    const candles = (await info({ type: "candleSnapshot", req: { coin, interval: "1h", startTime: startMs, endTime: now } })) as Array<{ t: number; c: string }>;
    if (candles.length < 24) { console.log(`  ${coin.padEnd(6)} (no candles)`); continue; }
    const grid = candles.map((c) => c.t), closes = candles.map((c) => Number(c.c));
    const series = verified.map((v) => reconstructPositionSeries(v.fills, coin)).filter((s) => s.length > 0);
    if (series.length < 2) { console.log(`  ${coin.padEnd(6)} ${String(series.length).padEnd(8)} — too few wallets traded ${coin}`); continue; }
    const cohortNet = grid.map((t) => cohortNetAt(series, t));
    const rets = pctReturns(closes);
    const strat = copyStrategyReturns(cohortNet, rets);
    const sh = sharpe(strat), tot = totalReturn(strat), hit = hitRate(strat);
    // shuffle control: break the time alignment of the signal, recompute Sharpe; p = P(shuffled ≥ real)
    const rnd = lcg(42); let ge = 0; const K = 200;
    for (let k = 0; k < K; k++) { const ss = sharpe(copyStrategyReturns(shuffle([...cohortNet], rnd), rets)); if (Math.abs(ss) >= Math.abs(sh)) ge++; }
    const p = ge / K;
    const ll = leadLag(cohortNet, rets, 2);
    const llStr = ll.map((x) => `${x.lag >= 0 ? "+" : ""}${x.lag}:${x.corr.toFixed(2)}`).join(" ");
    const leadCorr = ll.find((x) => x.lag === 1)!.corr, lagCorr = ll.find((x) => x.lag === -1)!.corr;
    const read = Math.abs(leadCorr) > Math.abs(lagCorr) + 0.03 ? (leadCorr > 0 ? "LEADS ✓" : "leads-fade") : Math.abs(lagCorr) > Math.abs(leadCorr) + 0.03 ? "LAGS (chases)" : "flat";
    console.log(`  ${coin.padEnd(6)} ${String(series.length).padEnd(8)} ${`${(tot * 100).toFixed(1)}%`.padEnd(9)} ${sh.toFixed(2).padEnd(8)} ${`${(hit * 100).toFixed(0)}%`.padEnd(6)} ${p.toFixed(3).padEnd(8)} ${llStr.padEnd(30)} ${read}`);
  } catch (e) { console.log(`  ${coin.padEnd(6)} err ${(e as Error).message.slice(0, 30)}`); }
}
console.log(`\n  ⚠ SURVIVORSHIP: the cohort is picked on TODAY's realized profit, so copyRet/sharpe are biased UP — do not`);
console.log(`    read them as deployable. The LEAD-LAG sign is the honest read: flow that LEADS price (k=+1 corr > k=−1)`);
console.log(`    is genuinely copyable; flow that LAGS means they CHASE and copying arrives too late. shuf-p<0.05 = the`);
console.log(`    timing carries real info vs a random reorder. Verify forward (paper) before trusting any of it.\n`);
