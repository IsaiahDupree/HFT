/**
 * hl-copy-paper — the SURVIVORSHIP-FREE forward test of the HL smart-money consensus. Each run: (1) GRADE the
 * prior snapshot — fetch current prices, compute how the prior verified consensus actually played out (no
 * lookahead — the prior signal used only prior data); (2) record a FRESH consensus snapshot. Accumulated daily
 * it builds a genuine out-of-sample track record answering "is the verified HL consensus predictive?" — the
 * honest complement to the (biased) copy-backtest. Persists to LOCAL SQLite on the My Passport drive. Dry-run.
 *
 *   npm run hl:copy-paper            # grade prior + snapshot now
 *   npm run hl:copy-paper -- --show  # print the accumulated track record, no new snapshot
 */
import "./_env.ts";
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseLeaderboard, rankWallets, realizedStats, isVerifiedProfitable, fillStyleProfile, positionConsensus, DEFAULT_RANK, type WalletPosition, type Fill } from "../src/lib/exec/smart-money.ts";
import { evaluateForward, trackRecord, type Snapshot } from "../src/lib/exec/copy-paper.ts";

const show = process.argv.includes("--show");
const TOP = (() => { const i = process.argv.indexOf("--top"); return i >= 0 ? Number(process.argv[i + 1]) : 30; })();
const INFO = "https://api.hyperliquid.xyz/info";
const LB = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const DB_PATH = process.env.COPY_DB_PATH ?? (existsSync("/Volumes/My Passport") ? "/Volumes/My Passport/hft-data/hl-copy-paper.db" : resolve(process.cwd(), "data", "hl-copy-paper.db"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function jget(url: string): Promise<any> { const r = await fetch(url, { signal: AbortSignal.timeout(30_000) }); if (!r.ok) throw new Error(`${url.slice(0, 40)} ${r.status}`); return r.json(); }
async function info(b: unknown, tries = 4): Promise<any> { for (let i = 0; i < tries; i++) { const r = await fetch(INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(20_000) }); if (r.ok) return r.json(); if (r.status === 429 && i < tries - 1) { await sleep(1200 * (i + 1)); continue; } throw new Error(`info ${r.status}`); } }

// ---- DB ----
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS copy_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, iso TEXT, entries TEXT);
CREATE TABLE IF NOT EXISTS copy_evals (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, iso TEXT, prior_ts INTEGER, horizon_h REAL, n_eval INTEGER, portfolio_ret REAL, hit_rate REAL, detail TEXT);`);
const lastSnapshot = (): Snapshot | null => { const r = db.prepare("SELECT ts, iso, entries FROM copy_snapshots ORDER BY ts DESC LIMIT 1").get() as { ts: number; iso: string; entries: string } | undefined; return r ? { ts: r.ts, iso: r.iso, entries: JSON.parse(r.entries) } : null; };
const allEvals = () => db.prepare("SELECT n_eval as nEval, portfolio_ret as portfolioRet, hit_rate as hitRate FROM copy_evals ORDER BY ts ASC").all() as Array<{ nEval: number; portfolioRet: number; hitRate: number }>;

if (show) {
  const t = trackRecord(allEvals());
  const snaps = (db.prepare("SELECT COUNT(*) n FROM copy_snapshots").get() as { n: number }).n;
  console.log(`\nhl-copy-paper — DB ${DB_PATH}\n  ${snaps} snapshots · ${t.n} graded periods · mean ${(t.meanRet * 100).toFixed(2)}%/period · hit ${(t.hitRate * 100).toFixed(0)}% · cumulative ${(t.cumRet * 100).toFixed(1)}%`);
  for (const e of db.prepare("SELECT iso, horizon_h, n_eval, portfolio_ret, hit_rate FROM copy_evals ORDER BY ts DESC LIMIT 10").all() as any[]) console.log(`    ${e.iso}  ${e.horizon_h.toFixed(0)}h  n=${e.n_eval}  ret ${(e.portfolio_ret * 100).toFixed(2)}%  hit ${(e.hit_rate * 100).toFixed(0)}%`);
  console.log("");
  db.close();
} else {
  const now = Date.now(), iso = new Date().toISOString();
  const mids = (await info({ type: "allMids" })) as Record<string, string>;
  const price = (c: string): number | undefined => { const m = Number(mids[c]); return Number.isFinite(m) && m > 0 ? m : undefined; };

  // 1) GRADE the prior snapshot against current prices (no lookahead)
  const prior = lastSnapshot();
  if (prior) {
    const ev = evaluateForward(prior, price, now);
    db.prepare("INSERT INTO copy_evals (ts, iso, prior_ts, horizon_h, n_eval, portfolio_ret, hit_rate, detail) VALUES (?,?,?,?,?,?,?,?)")
      .run(now, iso, prior.ts, ev.horizonHours, ev.nEval, ev.portfolioRet, ev.hitRate, JSON.stringify(ev.perCoin));
    console.log(`\nhl-copy-paper — graded prior snapshot (${ev.horizonHours.toFixed(0)}h ago): n=${ev.nEval} · portfolio ${(ev.portfolioRet * 100).toFixed(2)}% · hit ${(ev.hitRate * 100).toFixed(0)}%`);
    for (const c of ev.perCoin) console.log(`    ${c.coin.padEnd(8)} ${(c.dir > 0 ? "L" : "S")} priceRet ${(c.priceRet * 100).toFixed(2)}% → copyRet ${(c.copyRet * 100).toFixed(2)}% ${c.correct ? "✓" : "✗"}`);
  } else console.log(`\nhl-copy-paper — first run, no prior snapshot to grade. DB ${DB_PATH}`);

  // 2) compute + record a FRESH verified-consensus snapshot
  const ranked = rankWallets(parseLeaderboard(await jget(LB)), DEFAULT_RANK).slice(0, TOP);
  const positions: WalletPosition[] = [];
  for (const w of ranked) {
    try {
      const st = await info({ type: "clearinghouseState", user: w.address });
      const acct = Number(st?.marginSummary?.accountValue ?? 0);
      const aps = (st?.assetPositions ?? []) as Array<{ position: { coin: string; szi: string; positionValue?: string; entryPx?: string } }>;
      const fills = ((await info({ type: "userFills", user: w.address })) as Array<Record<string, unknown>>).map((f) => ({ coin: String(f.coin), dir: String(f.dir ?? ""), sz: Number(f.sz), px: Number(f.px), closedPnl: Number(f.closedPnl ?? 0), time: Number(f.time) } as Fill));
      const verified = isVerifiedProfitable(realizedStats(fills)) && !fillStyleProfile(fills).classification.includes("scalper");
      if (!verified) continue;
      for (const a of aps) positions.push({ wallet: w.address, coin: a.position.coin, szi: Number(a.position.szi), notionalUsd: Number(a.position.positionValue ?? Math.abs(Number(a.position.szi)) * Number(a.position.entryPx ?? 0)), accountValue: acct });
      await sleep(70);
    } catch { /* skip */ }
  }
  const consensus = positionConsensus(positions).filter((c) => c.longWallets + c.shortWallets >= 2 && Math.abs(c.netNotional) > 0);
  const entries: Snapshot["entries"] = consensus.map((c) => ({ coin: c.coin, netNotional: c.netNotional, price: price(c.coin) ?? 0 })).filter((e) => e.price > 0);
  db.prepare("INSERT INTO copy_snapshots (ts, iso, entries) VALUES (?,?,?)").run(now, iso, JSON.stringify(entries));
  console.log(`\n  recorded snapshot: ${entries.length} consensus coins from verified-copyable cohort`);
  for (const e of entries) console.log(`    ${e.coin.padEnd(8)} ${(e.netNotional > 0 ? "LONG " : "SHORT")} net $${(Math.abs(e.netNotional) / 1000).toFixed(0)}k @ $${e.price}`);
  const t = trackRecord(allEvals());
  console.log(`\n  TRACK RECORD: ${t.n} graded periods · mean ${(t.meanRet * 100).toFixed(2)}%/period · hit ${(t.hitRate * 100).toFixed(0)}% · cumulative ${(t.cumRet * 100).toFixed(1)}%`);
  console.log(`  (run daily; the survivorship-free read accumulates. cumulative > 0 + hit > 55% over many periods = a real signal.)\n`);
  db.close();
}
