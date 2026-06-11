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
import { signMatchedReturn } from "../src/lib/exec/copy-sim.ts";
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
type Cand = { address: string; directionality: string };
const candObjs: Cand[] = override
  ? override.split(",").map((s) => ({ address: s.trim().toLowerCase(), directionality: "override" }))
  : (() => { const ws = openWalletDb(); const c = ws.latest().filter((s) => s.copyMode === "position-copy" && s.verified && !s.flowDistorted).map((s) => ({ address: s.address, directionality: s.directionality || "two-sided" })); ws.close(); return c; })();
const candidates = candObjs.map((c) => c.address);

if (!candidates.length) { console.log("\nhl-walk-forward — no verified position-copy candidates. Run `npm run hl:wallet-track` first.\n"); }
else {
  console.log(`\nhl-walk-forward — ${candidates.length} verified position-copy wallets · ${DAYS}d · ${WINDOW}d windows step ${STEP}d\n  benchmark: SIGN-MATCHED equal-weight (fixed the sign-stripped artifact) · standing positions seeded from a 180d fill warmup\n`);
  const startTime = Math.floor(NOW - DAYS * DAY);
  const fillStart = Math.floor(NOW - (DAYS + 180) * DAY); // WARMUP: fetch fills well before the window so pre-window holds aren't reborn as phantom shorts
  const grid: number[] = []; for (let t = startTime; t <= NOW; t += DAY) grid.push(t);

  // reconstruct position series per (wallet, coin) — from the WARMUP-extended fill history
  const series = new Map<string, Map<string, ReturnType<typeof reconstructPositionSeries>>>();
  const coins = new Set<string>();
  for (const w of candidates) {
    try {
      const fillsRaw: BtFill[] = []; let cursor = fillStart;
      for (let p = 0; p < 16; p++) {
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

  // EXOGENOUS regime series: daily BTC return per period — decouples the regime label from the (sign-aware) benchmark
  const btcCloses = closes.get("BTC");
  const regimeReturns: number[] = [];
  for (let i = 0; i < grid.length - 1; i++) { const a = btcCloses?.[i] ?? 0, b = btcCloses?.[i + 1] ?? 0; regimeReturns.push(a > 0 && b > 0 ? (b - a) / a : 0); }

  // build the copy-vs-(sign-matched)-beta streams for ANY wallet subset, reusing the shared reconstruction
  function buildReturns(subset: readonly string[]): { copy: number[]; bench: number[] } {
    const sub = new Set(subset);
    const bw: Array<Record<string, number>> = grid.map((t, gi) => {
      const acc: Record<string, number> = {}; let nW = 0;
      for (const [w, perCoin] of series) {
        if (!sub.has(w)) continue;
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
    const copy: number[] = [], bench: number[] = [];
    for (let i = 0; i < grid.length - 1; i++) {
      const prevPx: Record<string, number> = {}, curPx: Record<string, number> = {};
      for (const c of Object.keys(bw[i])) { const a = closes.get(c)?.[i] ?? 0, b = closes.get(c)?.[i + 1] ?? 0; if (a > 0 && b > 0) { prevPx[c] = a; curPx[c] = b; } }
      const rets = priceReturns(prevPx, curPx);
      copy.push((bookMtmReturn(bw[i], rets) - rebalanceCost(bw[i], bw[i + 1], COST_BPS)) * FRACTION);
      bench.push(signMatchedReturn(bw[i], rets) * FRACTION);
    }
    return { copy, bench };
  }
  const WF = { windowSize: WINDOW, step: STEP, flatBand: FLAT, regimeReturns };
  const run = (subset: readonly string[]) => { const { copy, bench } = buildReturns(subset); return walkForwardAnalysis(copy, bench, WF); };
  const VERDICT: Record<string, string> = {
    "regime-independent edge": "✅ REGIME-INDEPENDENT EDGE",
    "regime-dependent (directional bet)": "⚠️ directional bet",
    "no edge": "❌ no edge",
    "insufficient": "⏳ insufficient",
  };

  // ---- 1) AGGREGATE (detailed) ----
  const r = run(candidates);
  console.log(`  === AGGREGATE (${candidates.length} wallets) · regime tagged by BTC ===`);
  console.log(`  window  regime    copy      beta      ALPHA`);
  for (const w of r.windows) console.log(`    #${String(w.index).padStart(2)}   ${REG[w.regime]}  ${pct(w.copyReturn).padStart(7)}  ${pct(w.benchReturn).padStart(7)}  ${pct(w.alpha).padStart(7)}`);
  for (const reg of ["up", "down", "flat"] as RegimeLabel[]) { const a = r.byRegime[reg]; if (a.n) console.log(`    ${REG[reg]}  n=${a.n}  mean alpha ${pct(a.meanAlpha)}  win ${(a.winRate * 100).toFixed(0)}%`); }
  console.log(`  ${r.nWindows} windows (eff N ${r.effectiveN.toFixed(1)}) · mean alpha ${pct(r.meanAlpha)} · t ${r.tStat.toFixed(2)} · ${VERDICT[r.verdict]}`);

  // ---- 2) SUB-BASKETS by directionality (disaggregation — the aggregate may net away sub-edge) ----
  const buckets = new Map<string, string[]>();
  for (const c of candObjs) { const arr = buckets.get(c.directionality) ?? []; arr.push(c.address); buckets.set(c.directionality, arr); }
  console.log(`\n  === SUB-BASKETS by directionality ===`);
  console.log(`  bucket            n   eff-N  meanAlpha  t-stat  verdict`);
  const bucketRows = [...buckets.entries()].map(([k, addrs]) => ({ k, addrs, r: run(addrs) }));
  for (const b of bucketRows.sort((a, z) => z.r.tStat - a.r.tStat)) console.log(`  ${b.k.padEnd(16)}  ${String(b.addrs.length).padStart(2)}  ${b.r.effectiveN.toFixed(1).padStart(5)}  ${pct(b.r.meanAlpha).padStart(8)}  ${b.r.tStat.toFixed(2).padStart(6)}  ${VERDICT[b.r.verdict]}`);

  // ---- 3) PER-WALLET scan (does any single wallet carry edge the basket cancels?) ----
  const perWallet = candidates.map((w) => ({ w, r: run([w]) })).sort((a, z) => z.r.tStat - a.r.tStat);
  console.log(`\n  === PER-WALLET (top 8 by t-stat) ===`);
  console.log(`  wallet        eff-N  meanAlpha  t-stat  verdict`);
  for (const p of perWallet.slice(0, 8)) console.log(`  ${p.w.slice(0, 12)}  ${p.r.effectiveN.toFixed(1).padStart(5)}  ${pct(p.r.meanAlpha).padStart(8)}  ${p.r.tStat.toFixed(2).padStart(6)}  ${VERDICT[p.r.verdict]}`);

  // ---- WINNERS: any sub-group with a real, significant, regime-independent edge ----
  const winners = [
    ...bucketRows.filter((b) => b.r.verdict === "regime-independent edge").map((b) => `bucket ${b.k} (n=${b.addrs.length}, alpha ${pct(b.r.meanAlpha)}, t ${b.r.tStat.toFixed(2)})`),
    ...perWallet.filter((p) => p.r.verdict === "regime-independent edge").map((p) => `wallet ${p.w.slice(0, 12)} (alpha ${pct(p.r.meanAlpha)}, t ${p.r.tStat.toFixed(2)})`),
  ];
  console.log(`\n  ${winners.length ? "🎯 CANDIDATES with regime-independent edge → promote to forward paper-track:\n    " + winners.join("\n    ") : "❌ NO sub-basket or wallet shows a significant regime-independent edge. Disaggregation did not rescue a hidden edge."}`);
  console.log(`\n  FIXED: sign-aware benchmark · seeded standing positions · overlap power-gate · BTC-tagged regimes · disaggregated.`);
  console.log(`  STILL OPEN: membership-as-of (needs more longitudinal history; store is days old, not 90d).\n`);
}
