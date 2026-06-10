/**
 * hl-walk-forward — does the position-copy basket's in-sample alpha survive across REGIMES, or did short just
 * work last month? Reconstructs the basket's net book day-by-day over a long window, builds the copy-vs-beta
 * return streams, slices them into rolling windows, tags each window up/down/flat by the benchmark's own move,
 * and reports alpha SEPARATELY per regime. Verdict: regime-independent edge / directional bet / no edge.
 *
 * Honesty boundary: this varies TIME, not basket MEMBERSHIP (it's today's verified set). It cannot remove the
 * survivorship in WHO is in the basket — only test whether that fixed basket generalizes across regimes. That
 * caveat is printed with the result, not buried.
 *
 *   npm run hl:walk-forward -- [--days 90 --window 14 --step 7 --copy-fraction 0.5 --cost-bps 10]
 */
import "./_env.ts";
import { openWalletDb } from "../src/lib/exec/wallet-store.ts";
import { reconstructPositionSeries, positionAt, type Fill as BtFill } from "../src/lib/exec/copy-backtest.ts";
import { netBookWeights, priceReturns, bookMtmReturn, rebalanceCost, type NetPosition } from "../src/lib/exec/netbook-copy.ts";
import { equalWeightLongReturn } from "../src/lib/exec/copy-sim.ts";
import { walkForwardAnalysis, type RegimeLabel } from "../src/lib/exec/walk-forward-copy.ts";

const num = (n: string, d: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] != null ? Number(process.argv[i + 1]) : d; };
const str = (n: string): string | undefined => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const DAYS = num("--days", 90), WINDOW = num("--window", 14), STEP = num("--step", 7), FRACTION = num("--copy-fraction", 0.5), COST_BPS = num("--cost-bps", 10), FLAT = num("--flat-band", 0.02);
const INFO = "https://api.hyperliquid.xyz/info", DAY = 86_400_000, NOW = Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function info(b: unknown, tries = 4): Promise<any> { for (let i = 0; i < tries; i++) { const r = await fetch(INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(20_000) }); if (r.ok) return r.json(); if (r.status === 429 && i < tries - 1) { await sleep(1000 * (i + 1)); continue; } throw new Error(`info ${r.status}`); } }
const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
const REG: Record<RegimeLabel, string> = { up: "📈 up  ", down: "📉 down", flat: "➖ flat" };

const override = str("--wallets");
const candidates: string[] = override
  ? override.split(",").map((s) => s.trim().toLowerCase())
  : (() => { const ws = openWalletDb(); const c = ws.latest().filter((s) => s.copyMode === "position-copy" && s.verified && !s.flowDistorted).map((s) => s.address); ws.close(); return c; })();

if (!candidates.length) { console.log("\nhl-walk-forward — no verified position-copy candidates. Run `npm run hl:wallet-track` first.\n"); }
else {
  console.log(`\nhl-walk-forward — ${candidates.length} verified position-copy wallets · ${DAYS}d · ${WINDOW}d windows step ${STEP}d\n`);
  const startTime = Math.floor(NOW - DAYS * DAY);
  const grid: number[] = []; for (let t = startTime; t <= NOW; t += DAY) grid.push(t);

  // reconstruct position series per (wallet, coin)
  const series = new Map<string, Map<string, ReturnType<typeof reconstructPositionSeries>>>();
  const coins = new Set<string>();
  for (const w of candidates) {
    try {
      const fillsRaw: BtFill[] = []; let cursor = startTime;
      for (let p = 0; p < 10; p++) {
        const batch = ((await info({ type: "userFillsByTime", user: w, startTime: cursor })) ?? []) as Array<Record<string, unknown>>;
        if (!batch.length) break;
        for (const f of batch) fillsRaw.push({ coin: String(f.coin), dir: String(f.dir ?? ""), sz: Number(f.sz), px: Number(f.px), time: Number(f.time) });
        const last = Math.max(...batch.map((b) => Number(b.time)));
        if (batch.length < 2000 || last <= cursor) break; cursor = last + 1; await sleep(40);
      }
      const perCoin = new Map<string, ReturnType<typeof reconstructPositionSeries>>();
      for (const c of new Set(fillsRaw.map((f) => f.coin))) { perCoin.set(c, reconstructPositionSeries(fillsRaw, c)); coins.add(c); }
      series.set(w, perCoin); await sleep(40);
    } catch { /* skip */ }
  }

  // daily candle closes per coin, aligned to grid
  const closes = new Map<string, number[]>();
  for (const c of coins) {
    try {
      const candles = ((await info({ type: "candleSnapshot", req: { coin: c, interval: "1d", startTime, endTime: NOW } })) ?? []) as Array<{ t: number; c: string }>;
      const sorted = candles.map((k) => ({ t: Number(k.t), c: Number(k.c) })).sort((a, b) => a.t - b.t);
      const priceAt = (t: number): number => { let px = 0; for (const k of sorted) { if (k.t <= t) px = k.c; else break; } return px; };
      closes.set(c, grid.map(priceAt)); await sleep(30);
    } catch { /* skip */ }
  }

  // basket net-book weights per grid day
  const basketWeights: Array<Record<string, number>> = grid.map((t, gi) => {
    const acc: Record<string, number> = {}; let nW = 0;
    for (const [, perCoin] of series) {
      const book: NetPosition[] = [];
      for (const [c, s] of perCoin) { const px = closes.get(c)?.[gi] ?? 0; if (px > 0) book.push({ coin: c, notionalUsd: positionAt(s, t) * px }); }
      const wts = netBookWeights(book);
      if (Object.keys(wts).length) { nW++; for (const c of Object.keys(wts)) acc[c] = (acc[c] ?? 0) + wts[c]; }
    }
    if (nW) for (const c of Object.keys(acc)) acc[c] /= nW;
    const gross = Object.values(acc).reduce((a, b) => a + Math.abs(b), 0);
    if (gross > 0) for (const c of Object.keys(acc)) acc[c] /= gross;
    return acc;
  });

  // copy-vs-beta per-period return streams
  const copyReturns: number[] = [], benchReturns: number[] = [];
  for (let i = 0; i < grid.length - 1; i++) {
    const prevPx: Record<string, number> = {}, curPx: Record<string, number> = {};
    for (const c of Object.keys(basketWeights[i])) { const a = closes.get(c)?.[i] ?? 0, b = closes.get(c)?.[i + 1] ?? 0; if (a > 0 && b > 0) { prevPx[c] = a; curPx[c] = b; } }
    const rets = priceReturns(prevPx, curPx);
    const mtm = bookMtmReturn(basketWeights[i], rets);
    const cost = rebalanceCost(basketWeights[i], basketWeights[i + 1], COST_BPS);
    copyReturns.push((mtm - cost) * FRACTION);
    benchReturns.push(equalWeightLongReturn(rets) * FRACTION);
  }

  const r = walkForwardAnalysis(copyReturns, benchReturns, { windowSize: WINDOW, step: STEP, flatBand: FLAT });
  console.log(`  window  regime    copy      beta      ALPHA`);
  for (const w of r.windows) console.log(`    #${String(w.index).padStart(2)}   ${REG[w.regime]}  ${pct(w.copyReturn).padStart(7)}  ${pct(w.benchReturn).padStart(7)}  ${pct(w.alpha).padStart(7)}`);
  console.log(`\n  alpha by regime:`);
  for (const reg of ["up", "down", "flat"] as RegimeLabel[]) { const a = r.byRegime[reg]; if (a.n) console.log(`    ${REG[reg]}  n=${a.n}  mean alpha ${pct(a.meanAlpha)}  win-rate ${(a.winRate * 100).toFixed(0)}%`); }
  console.log(`\n  ${r.nWindows} windows · mean alpha ${pct(r.meanAlpha)} · consistency ${(r.alphaConsistency * 100).toFixed(0)}% positive · DSR ${r.dsr.toFixed(2)}`);
  console.log(`  alpha in UP regimes ${pct(r.alphaUp)} · alpha in DOWN regimes ${pct(r.alphaDown)}`);
  const VERDICT: Record<string, string> = {
    "regime-independent edge": "✅ REGIME-INDEPENDENT EDGE — alpha survives up AND down. Worth forward-confirming.",
    "regime-dependent (directional bet)": "⚠️ DIRECTIONAL BET — wins in down, loses in up. It's a short, not skill.",
    "no edge": "❌ NO EDGE — does not beat passively holding the coins.",
    "insufficient": "⏳ INSUFFICIENT — too few windows to judge (need a longer history).",
  };
  console.log(`\n  VERDICT: ${VERDICT[r.verdict]}`);
  if (!r.byRegime.up.n || !r.byRegime.down.n) console.log(`  ⚠️ coverage: only ${r.byRegime.up.n} up / ${r.byRegime.down.n} down windows — alpha untested in a missing regime.`);
  console.log(`  ⚠️ MEMBERSHIP survivorship NOT removed: basket = TODAY's verified set, walked over past time. True membership walk-forward needs historical verified status (longitudinal store is ~1 day old).\n`);
}
