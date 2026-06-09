/**
 * hl-netbook-paper — the forward, after-cost test of NET-BOOK copying the position-copy candidates. You can't
 * mirror 500 fills/day, but you can mirror the candidate's net exposure per coin. Each run: (1) GRADE the prior
 * book — mark it to the new mids and subtract the cost of rebalancing into the candidate's current book; (2)
 * SNAPSHOT the fresh book + mids. Accrued daily it answers the only question that matters: does mirroring their
 * aggregate exposure PAY after the turnover cost of chasing it? No lookahead (prior book graded on later prices
 * only), real fee/slippage charged, persisted to local SQLite. Dry-run — never trades.
 *
 *   npm run hl:netbook-paper                 # grade prior + snapshot now (run daily)
 *   npm run hl:netbook-paper -- --show       # print the accrued after-cost track record
 *   npm run hl:netbook-paper -- --wallets 0xabc,0xdef --cost-bps 10
 */
import "./_env.ts";
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openWalletDb } from "../src/lib/exec/wallet-store.ts";
import { netBookWeights, priceReturns, gradeNetbookPeriod, netbookTrackRecord, type NetPosition, type NetbookPeriod } from "../src/lib/exec/netbook-copy.ts";

const show = process.argv.includes("--show");
const str = (n: string): string | undefined => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const COST_BPS = Number(str("--cost-bps") ?? 10);
const INFO = "https://api.hyperliquid.xyz/info";
const DB_PATH = process.env.NETBOOK_DB_PATH ?? (existsSync("/Volumes/My Passport") ? "/Volumes/My Passport/hft-data/hl-netbook-paper.db" : resolve(process.cwd(), "data", "hl-netbook-paper.db"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function info(b: unknown, tries = 4): Promise<any> { for (let i = 0; i < tries; i++) { const r = await fetch(INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(20_000) }); if (r.ok) return r.json(); if (r.status === 429 && i < tries - 1) { await sleep(1000 * (i + 1)); continue; } throw new Error(`info ${r.status}`); } }

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS netbook_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, iso TEXT, wallet TEXT, weights TEXT, mids TEXT);
CREATE TABLE IF NOT EXISTS netbook_evals (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, iso TEXT, wallet TEXT, prior_ts INTEGER, mtm REAL, cost REAL, net REAL, n_coins INTEGER);`);
const priorSnap = (wallet: string) => db.prepare("SELECT ts, weights, mids FROM netbook_snapshots WHERE wallet = ? ORDER BY ts DESC LIMIT 1").get(wallet) as { ts: number; weights: string; mids: string } | undefined;
const evalsFor = (wallet: string) => db.prepare("SELECT mtm, cost, net FROM netbook_evals WHERE wallet = ? ORDER BY ts ASC").all(wallet) as NetbookPeriod[];

// candidate set: position-copy + verified + clean, from the longitudinal store (or --wallets override)
const override = str("--wallets");
const candidates: string[] = override
  ? override.split(",").map((s) => s.trim().toLowerCase())
  : (() => { const ws = openWalletDb(); const c = ws.latest().filter((s) => s.copyMode === "position-copy" && s.verified && !s.flowDistorted).map((s) => s.address); ws.close(); return c; })();

if (show) {
  console.log(`\nhl-netbook-paper — after-cost track record · DB ${DB_PATH} · cost ${COST_BPS}bps\n`);
  const allW = (db.prepare("SELECT DISTINCT wallet FROM netbook_evals").all() as Array<{ wallet: string }>).map((r) => r.wallet);
  if (!allW.length) { console.log("  no graded periods yet — run without --show on consecutive days to accrue.\n"); db.close(); }
  else {
    const agg: NetbookPeriod[] = [];
    for (const w of allW) {
      const t = netbookTrackRecord(evalsFor(w));
      agg.push(...evalsFor(w));
      console.log(`  ${w.slice(0, 12)}…  n=${String(t.n).padStart(2)}  net ${(t.meanNet * 100).toFixed(3)}%/period  (mtm ${(t.meanMtm * 100).toFixed(3)}% − cost ${(t.meanCost * 100).toFixed(3)}%)  hit ${(t.hitRate * 100).toFixed(0)}%  cum ${(t.cumNet * 100).toFixed(2)}%  Sharpe ${t.sharpe.toFixed(2)}  ${t.netOfCostPays ? "✅ pays" : "⏳ not yet"}`);
    }
    const T = netbookTrackRecord(agg);
    console.log(`\n  AGGREGATE  n=${T.n}  net ${(T.meanNet * 100).toFixed(3)}%/period  hit ${(T.hitRate * 100).toFixed(0)}%  cum ${(T.cumNet * 100).toFixed(2)}%  Sharpe ${T.sharpe.toFixed(2)}  ${T.netOfCostPays ? "✅ net-of-cost edge confirmed" : "⏳ not yet (need ≥10 periods, cum>0, Sharpe≥1)"}\n`);
    db.close();
  }
} else {
  if (!candidates.length) { console.log("\nhl-netbook-paper — no position-copy candidates in wallets.db. Run `npm run hl:wallet-track` first, or pass --wallets.\n"); db.close(); }
  else {
    const now = Date.now(), iso = new Date(now).toISOString();
    const mids = (await info({ type: "allMids" })) as Record<string, string>;
    const px = (c: string): number => { const m = Number(mids[c]); return Number.isFinite(m) && m > 0 ? m : 0; };
    console.log(`\nhl-netbook-paper — ${candidates.length} position-copy candidates · cost ${COST_BPS}bps · ${iso}\n`);
    const insSnap = db.prepare("INSERT INTO netbook_snapshots (ts,iso,wallet,weights,mids) VALUES (?,?,?,?,?)");
    const insEval = db.prepare("INSERT INTO netbook_evals (ts,iso,wallet,prior_ts,mtm,cost,net,n_coins) VALUES (?,?,?,?,?,?,?,?)");
    let graded = 0;
    for (const wallet of candidates) {
      try {
        const st = await info({ type: "clearinghouseState", user: wallet });
        const book: NetPosition[] = ((st?.assetPositions ?? []) as Array<{ position: { coin: string; szi: string; positionValue?: string } }>)
          .map((a) => ({ coin: a.position.coin, notionalUsd: Number(a.position.szi) >= 0 ? Number(a.position.positionValue ?? 0) : -Number(a.position.positionValue ?? 0) }))
          .filter((p) => p.notionalUsd !== 0);
        const curWeights = netBookWeights(book);

        // GRADE prior book (no lookahead — prior weights, priced on TODAY's mids)
        const prior = priorSnap(wallet);
        if (prior) {
          const priorWeights = JSON.parse(prior.weights) as Record<string, number>;
          const priorMids = JSON.parse(prior.mids) as Record<string, number>;
          const curMids: Record<string, number> = {}; for (const c of Object.keys(priorMids)) curMids[c] = px(c);
          const rets = priceReturns(priorMids, curMids);
          const period = gradeNetbookPeriod(priorWeights, rets, curWeights, COST_BPS);
          insEval.run(now, iso, wallet, prior.ts, period.mtm, period.cost, period.net, Object.keys(priorWeights).length);
          graded++;
          console.log(`  ${wallet.slice(0, 12)}…  graded: mtm ${(period.mtm * 100).toFixed(3)}% − cost ${(period.cost * 100).toFixed(3)}% = net ${(period.net * 100).toFixed(3)}%`);
        } else {
          console.log(`  ${wallet.slice(0, 12)}…  first snapshot (nothing to grade yet)`);
        }

        // SNAPSHOT current book + the mids for its coins
        const bookMids: Record<string, number> = {}; for (const c of Object.keys(curWeights)) bookMids[c] = px(c);
        insSnap.run(now, iso, wallet, JSON.stringify(curWeights), JSON.stringify(bookMids));
        await sleep(40);
      } catch { /* skip */ }
    }
    console.log(`\n  snapshotted ${candidates.length} books · graded ${graded} periods · DB ${DB_PATH}`);
    console.log(`  run daily; check progress with: npm run hl:netbook-paper -- --show\n`);
    db.close();
  }
}
