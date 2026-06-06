/**
 * hl-copy-backtest — would following the VERIFIED smart-money cohort have paid, and is their flow PREDICTIVE
 * or REACTIVE? Rebuilt after an adversarial audit found the first version was a false-negative machine. Fixes:
 *   • DE-TRUNCATION: paginate userFillsByTime over the window (the old single userFills call capped at ~2000,
 *     corrupting the position reconstruction for active wallets).
 *   • ENTRY-IMPULSE signal: the headline test is now the per-bar NEW-OPEN impulse (do they ENTER before moves?),
 *     not the stale standing net — and the impulse is immune to pre-window truncation. Standing-net kept as a
 *     secondary read, flagged.
 *   • SAMPLE-SIZE GATE: a coin needs ≥ minWallets contributing or it reports insufficient_data (no 2-wallet noise).
 *   • PERSISTED: writes a results line to the My Passport drive (no more transient-only verdicts).
 *
 *   npm run hl:copy-backtest [-- --top 60 --days 14 --coins BTC,ETH,SOL,HYPE --min-wallets 8]
 */
import "./_env.ts";
import { parseLeaderboard, rankWallets, realizedStats, isVerifiedProfitable, DEFAULT_RANK, type Fill as SmFill } from "../src/lib/exec/smart-money.ts";
import { reconstructPositionSeries, cohortNetAt, copyStrategyReturns, pctReturns, leadLag, crossCorr, entryImpulseSeries, sharpe, hitRate, totalReturn, type Fill } from "../src/lib/exec/copy-backtest.ts";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const num = (n: string, d: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const arg = (n: string, d: string): string => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const TOP = num("--top", 60), DAYS = num("--days", 14), MINW = num("--min-wallets", 8);
const COINS = arg("--coins", "BTC,ETH,SOL,HYPE").split(",");
const INFO = "https://api.hyperliquid.xyz/info", LB = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const OUT = process.env.COPY_DB_PATH ? resolve(dirname(process.env.COPY_DB_PATH), "hl-copy-backtest-results.jsonl") : existsSync("/Volumes/My Passport") ? "/Volumes/My Passport/hft-data/hl-copy-backtest-results.jsonl" : resolve(process.cwd(), "data", "hl-copy-backtest-results.jsonl");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function jget(url: string): Promise<any> { const r = await fetch(url, { signal: AbortSignal.timeout(30_000) }); if (!r.ok) throw new Error(`${url.slice(0, 40)} ${r.status}`); return r.json(); }
async function info(b: unknown, tries = 5): Promise<any> { for (let i = 0; i < tries; i++) { const r = await fetch(INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(20_000) }); if (r.ok) return r.json(); if (r.status === 429 && i < tries - 1) { await sleep(1500 * (i + 1)); continue; } throw new Error(`info ${r.status}`); } }
function lcg(seed: number): () => number { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 0xffffffff; }; }
const shuf = <T,>(a: T[], r: () => number): T[] => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };
const shufP = (sig: number[], rets: number[], real: number, K = 200): number => { const r = lcg(7); let ge = 0; for (let k = 0; k < K; k++) if (Math.abs(sharpe(copyStrategyReturns(shuf([...sig], r), rets))) >= Math.abs(real)) ge++; return ge / K; };

// DE-TRUNCATION: paginate userFillsByTime forward over the window until a short page (no 2000-cap loss).
async function windowFills(addr: string, startMs: number): Promise<Fill[]> {
  const all: Fill[] = []; let cursor = startMs;
  for (let page = 0; page < 8; page++) {
    const raw = (await info({ type: "userFillsByTime", user: addr, startTime: cursor })) as Array<Record<string, unknown>>;
    if (!raw?.length) break;
    for (const f of raw) all.push({ coin: String(f.coin), dir: String(f.dir ?? ""), sz: Number(f.sz), px: Number(f.px), time: Number(f.time), closedPnl: Number(f.closedPnl ?? 0) } as Fill & { closedPnl: number });
    if (raw.length < 2000) break;                                  // last page
    cursor = Number(raw[raw.length - 1].time) + 1;
    await sleep(120);
  }
  return all;
}

console.log(`\nhl-copy-backtest (rebuilt) — entry-impulse + de-truncated · top ${TOP} · ${DAYS}d hourly · ≥${MINW} wallets/coin · coins ${COINS.join(",")}\n`);
const now = Date.now(), startMs = now - DAYS * 86_400_000;
const ranked = rankWallets(parseLeaderboard(await jget(LB)), DEFAULT_RANK).slice(0, TOP);
const verified: Array<{ addr: string; fills: Fill[] }> = [];
let truncatedHits = 0;
for (const w of ranked) {
  try {
    const fills = await windowFills(w.address, startMs);
    if (fills.length >= 2000 * 8) truncatedHits++;
    if (isVerifiedProfitable(realizedStats(fills as unknown as SmFill[]))) verified.push({ addr: w.address, fills });
    await sleep(60);
  } catch { /* skip */ }
}
console.log(`  ${ranked.length} ranked → ${verified.length} verified-profitable wallets (de-truncated, paginated fills)\n`);
const allFills = verified.flatMap((v) => v.fills);

console.log(`  ${"coin".padEnd(6)} ${"wal".padEnd(4)} ${"ENTRY-IMPULSE (the real test)".padEnd(40)} ${"standing-net (2ndary)".padEnd(22)} verdict`);
await sleep(1500);
const persisted: any[] = [];
for (const coin of COINS) {
  try {
    await sleep(400);
    const candles = (await info({ type: "candleSnapshot", req: { coin, interval: "1h", startTime: startMs, endTime: now } })) as Array<{ t: number; c: string }>;
    if (candles.length < 24) { console.log(`  ${coin.padEnd(6)} (no candles)`); continue; }
    const grid = candles.map((c) => c.t), rets = pctReturns(candles.map((c) => Number(c.c)));
    const series = verified.map((v) => reconstructPositionSeries(v.fills, coin)).filter((s) => s.length > 0);
    const nW = series.length;
    // ENTRY-IMPULSE (headline): per-bar new-open flow → does it lead price?
    const imp = entryImpulseSeries(allFills, coin, grid);
    const sImp = copyStrategyReturns(imp, rets), shI = sharpe(sImp), pI = shufP(imp, rets, shI), ccI = crossCorr(imp, rets, 2);
    const leadI = ccI.find((x) => x.lag === 1)!.corr, lagI = ccI.find((x) => x.lag === -1)!.corr;
    // STANDING-NET (secondary, flagged): stale holdings
    const cohortNet = grid.map((t) => cohortNetAt(series, t));
    const sStd = copyStrategyReturns(cohortNet, rets), shS = sharpe(sStd);
    const llS = leadLag(cohortNet, rets, 2), leadS = llS.find((x) => x.lag === 1)!.corr;
    const impreal = nW >= MINW;
    const edge = impreal && pI < 0.05 && leadI > 0.08 && leadI > Math.abs(lagI);
    const verdict = !impreal ? "insufficient_data" : edge ? "🟢 ENTRY EDGE — investigate" : (leadI < lagI - 0.03 ? "lags/chases" : "no edge (beta)");
    const impStr = `tot ${(totalReturn(sImp) * 100).toFixed(0)}% sh ${shI.toFixed(2)} p ${pI.toFixed(2)} lead+1 ${leadI.toFixed(2)} lag-1 ${lagI.toFixed(2)}`;
    const stdStr = `sh ${shS.toFixed(2)} lead+1 ${leadS.toFixed(2)}`;
    console.log(`  ${coin.padEnd(6)} ${String(nW).padEnd(4)} ${impStr.padEnd(40)} ${stdStr.padEnd(22)} ${verdict}`);
    persisted.push({ coin, nWallets: nW, impulse: { total: totalReturn(sImp), sharpe: shI, shufP: pI, lead1: leadI, lag1: lagI }, standingSharpe: shS, verdict });
  } catch (e) { console.log(`  ${coin.padEnd(6)} err ${(e as Error).message.slice(0, 30)}`); }
}
try { mkdirSync(dirname(OUT), { recursive: true }); appendFileSync(OUT, JSON.stringify({ ts: now, iso: new Date().toISOString(), days: DAYS, top: TOP, nVerified: verified.length, coins: persisted }) + "\n"); console.log(`\n  persisted → ${OUT}`); } catch (e) { console.log(`  (persist failed: ${(e as Error).message})`); }
console.log(`\n  ENTRY-IMPULSE is the honest test (immune to truncation, tests new-open timing). EDGE = ≥${MINW} wallets AND`);
console.log(`  shuffle-p<0.05 AND lead(+1) corr > 0.08 and > |lag(−1)|. Survivorship still biases the raw return UP —`);
console.log(`  the lead-lag SIGN + shuffle-p are the trustworthy reads. Confirm forward (hl:copy-paper) before trusting.\n`);
