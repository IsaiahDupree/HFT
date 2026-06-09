/**
 * hl-copy-sim — "start with $X, mirror the verified position-copy basket, what happens to the account?"
 * BACKTEST: reconstructs each candidate's net book day-by-day from their real fills + HL daily candles, blends
 * them into one basket book, and runs the bankroll sim (copy fraction, rebalance costs, drawdown, optional stop).
 * FORWARD: replays the after-cost periods already graded by hl:netbook-paper through the SAME engine.
 *
 * READ IT HONESTLY: the backtest is survivorship-biased by construction (we chose these wallets because they
 * won) — it is descriptive, not predictive. The forward curve is the only one that proves anything, and it's
 * only as long as the paper-track has run. Dry-run; no orders.
 *
 *   npm run hl:copy-sim -- --start 10000 [--days 30 --copy-fraction 0.5 --cost-bps 10 --dd-stop 0.25]
 *   npm run hl:copy-sim -- --forward --start 10000
 */
import "./_env.ts";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openWalletDb } from "../src/lib/exec/wallet-store.ts";
import { reconstructPositionSeries, positionAt, type Fill as BtFill } from "../src/lib/exec/copy-backtest.ts";
import { netBookWeights, priceReturns, type NetPosition } from "../src/lib/exec/netbook-copy.ts";
import { simulateCopy, equityFromReturns, equalWeightLongReturn, sparkline, type SimPeriod } from "../src/lib/exec/copy-sim.ts";

const has = (f: string) => process.argv.includes(f);
const num = (n: string, d: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] != null ? Number(process.argv[i + 1]) : d; };
const str = (n: string): string | undefined => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const START = num("--start", 10_000), DAYS = num("--days", 30), FRACTION = num("--copy-fraction", 0.5), COST_BPS = num("--cost-bps", 10);
const DD_STOP = has("--dd-stop") ? num("--dd-stop", 0.25) : undefined;
const FORWARD = has("--forward");
const INFO = "https://api.hyperliquid.xyz/info";
const DAY = 86_400_000, NOW = Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function info(b: unknown, tries = 4): Promise<any> { for (let i = 0; i < tries; i++) { const r = await fetch(INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(20_000) }); if (r.ok) return r.json(); if (r.status === 429 && i < tries - 1) { await sleep(1000 * (i + 1)); continue; } throw new Error(`info ${r.status}`); } }

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

// candidate set: verified position-copy from the longitudinal store, or --wallets override
const override = str("--wallets");
const candidates: string[] = override
  ? override.split(",").map((s) => s.trim().toLowerCase())
  : (() => { const ws = openWalletDb(); const c = ws.latest().filter((s) => s.copyMode === "position-copy" && s.verified && !s.flowDistorted).map((s) => s.address); ws.close(); return c; })();

function report(title: string, caveat: string, r: ReturnType<typeof simulateCopy> | { startUsd: number; finalUsd: number; totalReturn: number; nPeriods: number; equityCurve: number[]; sharpe: number; maxDrawdown: number; hitRate: number; grossReturn?: number; costDrag?: number; stoppedOut?: boolean }) {
  console.log(`\n  ${title}`);
  console.log(`  ${caveat}`);
  console.log(`    ${sparkline(r.equityCurve)}`);
  console.log(`    start ${usd(r.startUsd)} → final ${usd(r.finalUsd)}   (${r.totalReturn >= 0 ? "+" : ""}${pct(r.totalReturn)} over ${r.nPeriods} periods)`);
  console.log(`    Sharpe/period ${r.sharpe.toFixed(2)} · max drawdown ${pct(r.maxDrawdown)} · hit-rate ${pct(r.hitRate)}${r.stoppedOut ? " · ⛔ STOPPED OUT" : ""}`);
  if ("grossReturn" in r && r.grossReturn != null) console.log(`    gross ${pct(r.grossReturn)} − cost drag ${pct(r.costDrag ?? 0)} = net (copy-fraction ${FRACTION}, ${COST_BPS}bps)`);
}

if (FORWARD) {
  const DB_PATH = process.env.NETBOOK_DB_PATH ?? (existsSync("/Volumes/My Passport") ? "/Volumes/My Passport/hft-data/hl-netbook-paper.db" : resolve(process.cwd(), "data", "hl-netbook-paper.db"));
  console.log(`\nhl-copy-sim — FORWARD replay of hl:netbook-paper · ${DB_PATH}`);
  const db = new Database(DB_PATH);
  // one period per run = average net across the basket at that timestamp
  const rows = db.prepare("SELECT ts, AVG(net) as net FROM netbook_evals GROUP BY ts ORDER BY ts ASC").all() as Array<{ ts: number; net: number }>;
  db.close();
  if (rows.length < 1) { console.log("\n  no graded forward periods yet — run `npm run hl:netbook-paper` daily to accrue, then re-check.\n"); }
  else {
    const nets = rows.map((r) => r.net * FRACTION);
    const e = equityFromReturns(nets, START, DD_STOP);
    report(`FORWARD — ${rows.length} graded period(s), the only predictive curve`, "✅ out-of-sample: each period was graded after the prior snapshot (no lookahead).",
      { startUsd: START, finalUsd: e.finalUsd, totalReturn: e.finalUsd / START - 1, nPeriods: nets.length, equityCurve: e.equityCurve, sharpe: e.sharpe, maxDrawdown: e.maxDrawdown, hitRate: e.hitRate, stoppedOut: e.stoppedOut });
    if (rows.length < 10) console.log(`\n  ⏳ only ${rows.length} period(s) — far too few to trust. Needs ≥10 daily runs before this curve means anything.`);
  }
  console.log("");
} else {
  if (!candidates.length) { console.log("\nhl-copy-sim — no verified position-copy candidates in wallets.db. Run `npm run hl:wallet-track` first, or pass --wallets.\n"); }
  else {
    console.log(`\nhl-copy-sim — BACKTEST: $${START.toLocaleString()} mirroring ${candidates.length} verified position-copy wallets over ${DAYS}d\n`);
    const startTime = Math.floor(NOW - DAYS * DAY);
    // daily grid
    const grid: number[] = []; for (let t = startTime; t <= NOW; t += DAY) grid.push(t);

    // fetch fills per candidate → position series per (wallet,coin); collect coins
    const series = new Map<string, Map<string, ReturnType<typeof reconstructPositionSeries>>>();
    const coins = new Set<string>();
    for (const w of candidates) {
      try {
        const fillsRaw: BtFill[] = [];
        let cursor = startTime;
        for (let p = 0; p < 6; p++) {
          const batch = ((await info({ type: "userFillsByTime", user: w, startTime: cursor })) ?? []) as Array<Record<string, unknown>>;
          if (!batch.length) break;
          for (const f of batch) fillsRaw.push({ coin: String(f.coin), dir: String(f.dir ?? ""), sz: Number(f.sz), px: Number(f.px), time: Number(f.time) });
          const last = Math.max(...batch.map((b) => Number(b.time)));
          if (batch.length < 2000 || last <= cursor) break; cursor = last + 1; await sleep(40);
        }
        const perCoin = new Map<string, ReturnType<typeof reconstructPositionSeries>>();
        for (const c of new Set(fillsRaw.map((f) => f.coin))) { perCoin.set(c, reconstructPositionSeries(fillsRaw, c)); coins.add(c); }
        series.set(w, perCoin);
        await sleep(40);
      } catch { /* skip */ }
    }

    // daily candles per coin → close price at each grid day
    const closes = new Map<string, number[]>(); // coin -> price aligned to grid
    for (const c of coins) {
      try {
        const candles = ((await info({ type: "candleSnapshot", req: { coin: c, interval: "1d", startTime, endTime: NOW } })) ?? []) as Array<{ t: number; c: string }>;
        const sorted = candles.map((k) => ({ t: Number(k.t), c: Number(k.c) })).sort((a, b) => a.t - b.t);
        const priceAt = (t: number): number => { let px = 0; for (const k of sorted) { if (k.t <= t) px = k.c; else break; } return px; };
        closes.set(c, grid.map(priceAt));
        await sleep(30);
      } catch { /* skip */ }
    }

    // basket net-book weights at each grid point = mean of candidates' normalized books
    const basketWeights: Array<Record<string, number>> = grid.map((t, gi) => {
      const acc: Record<string, number> = {};
      let nW = 0;
      for (const [w, perCoin] of series) {
        const book: NetPosition[] = [];
        for (const [c, s] of perCoin) { const px = closes.get(c)?.[gi] ?? 0; if (px > 0) book.push({ coin: c, notionalUsd: positionAt(s, t) * px }); }
        const wts = netBookWeights(book);
        if (Object.keys(wts).length) { nW++; for (const c of Object.keys(wts)) acc[c] = (acc[c] ?? 0) + wts[c]; }
      }
      if (nW) for (const c of Object.keys(acc)) acc[c] /= nW;
      // renormalize so Σ|w| = 1 (copy-fraction then controls gross exposure)
      const gross = Object.values(acc).reduce((a, b) => a + Math.abs(b), 0);
      if (gross > 0) for (const c of Object.keys(acc)) acc[c] /= gross;
      return acc;
    });

    // periods: hold weights[i] across the i→i+1 price move, then rebalance to weights[i+1]
    const periods: SimPeriod[] = [];
    for (let i = 0; i < grid.length - 1; i++) {
      const prevPx: Record<string, number> = {}, curPx: Record<string, number> = {};
      for (const c of Object.keys(basketWeights[i])) { const a = closes.get(c)?.[i] ?? 0, b = closes.get(c)?.[i + 1] ?? 0; if (a > 0 && b > 0) { prevPx[c] = a; curPx[c] = b; } }
      periods.push({ weights: basketWeights[i], rets: priceReturns(prevPx, curPx), nextWeights: basketWeights[i + 1] });
    }

    const r = simulateCopy(periods, { startUsd: START, copyFraction: FRACTION, costBps: COST_BPS, maxDrawdownStop: DD_STOP });
    report(`BACKTEST — ${candidates.length} wallets, ${periods.length} daily periods`, "⚠️ SURVIVORSHIP-BIASED & in-sample: these wallets were chosen BECAUSE they won. Descriptive, NOT predictive.", r);

    // BETA GATE: does copying beat just holding the same coins equal-weight long? Same exposure (copyFraction), no shorts.
    const benchNets = periods.map((p) => equalWeightLongReturn(p.rets) * FRACTION);
    const b = equityFromReturns(benchNets, START);
    const alpha = r.totalReturn - (b.finalUsd / START - 1);
    console.log(`\n  BETA BASELINE — passively hold the same coins, equal-weight long (the fair benchmark)`);
    console.log(`    ${sparkline(b.equityCurve)}`);
    console.log(`    start ${usd(START)} → final ${usd(b.finalUsd)}   (${b.finalUsd >= START ? "+" : ""}${pct(b.finalUsd / START - 1)})`);
    console.log(`    ⇒ ALPHA of copying vs passive-long = ${alpha >= 0 ? "+" : ""}${pct(alpha)}  ${alpha > 0 ? "✅ copy adds value over beta" : "❌ NO edge over just holding the coins — it's beta, not skill"}`);
    console.log(`\n  → the honest test is forward: run \`npm run hl:netbook-paper\` daily, then \`npm run hl:copy-sim -- --forward\`.\n`);
  }
}
