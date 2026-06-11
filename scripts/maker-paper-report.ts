/**
 * maker-paper-report — judge the G2 forward track. Reads binary-maker-paper.db
 * and prints, per session and in aggregate:
 *   - paper PnL (marked to market) + fills + rebates,
 *   - the model A/B: Brier score of p_fair_base vs p_fair_enh against the
 *     APPROXIMATE realized outcome (last recorded spot vs strike at expiry).
 *
 * Honesty notes:
 *   - the outcome is approximated from our last pre-expiry spot snapshot, not the
 *     official resolution oracle; knife-edge sessions (|last spot − strike| within
 *     5bps) are EXCLUDED from the A/B rather than guessed.
 *   - paper PnL stays an optimistic upper bound (front-of-queue fills) — the gate
 *     judgment must subtract that haircut; see the audit doc.
 *
 *   npx tsx scripts/maker-paper-report.ts            # all sessions
 *   npx tsx scripts/maker-paper-report.ts -- --days 7
 */
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const flag = (n: string, d = ""): string => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const DAYS = Number(flag("--days", "0"));

const DB_PATH =
  process.env.BINARY_MAKER_DB_PATH ??
  (existsSync("/Volumes/My Passport")
    ? "/Volumes/My Passport/hft-data/binary-maker-paper.db"
    : resolve(process.cwd(), "data", "binary-maker-paper.db"));
const db = new Database(DB_PATH, { readonly: true });

type SessionRow = {
  session: string; started_iso: string; ended_iso: string | null;
  symbol: string; strike: number; expiry_iso: string; summary: string | null;
};
const since = DAYS > 0 ? Date.now() - DAYS * 86_400_000 : 0;
const sessions = db.prepare("SELECT * FROM bm_sessions ORDER BY started_iso").all() as SessionRow[];

const KNIFE_EDGE_BPS = 5;
let totPnlMkt = 0, totFills = 0, totRebates = 0, nSessions = 0;
// The market mid is scored as a THIRD forecaster — the make-or-break benchmark:
// a maker whose fair value doesn't beat the mid has no edge over the market.
const brier = { base: [] as number[], enh: [] as number[], mkt: [] as number[] };
let knifeEdgeSkipped = 0;

console.log(`maker-paper-report — ${DB_PATH}${DAYS ? ` (last ${DAYS}d)` : ""}\n`);
for (const s of sessions) {
  if (since && Date.parse(s.started_iso) < since) continue;
  const sum = s.summary ? JSON.parse(s.summary) : null;
  const snaps = db.prepare(
    "SELECT ts, spot, p_fair_base, p_fair_enh, mkt_bid, mkt_ask FROM bm_snaps WHERE session = ? ORDER BY ts",
  ).all(s.session) as {
    ts: number; spot: number; p_fair_base: number | null; p_fair_enh: number | null;
    mkt_bid: number | null; mkt_ask: number | null;
  }[];
  if (!snaps.length) continue;
  nSessions++;

  const expiryMs = Date.parse(s.expiry_iso);
  const last = snaps.at(-1)!;
  const expired = Number.isFinite(expiryMs) && Date.now() > expiryMs;
  const lastNearExpiry = expired && expiryMs - last.ts < 10 * 60_000;

  let outcomeStr = "open";
  if (lastNearExpiry) {
    const edgeBps = Math.abs((last.spot - s.strike) / s.strike) * 10_000;
    if (edgeBps < KNIFE_EDGE_BPS) {
      outcomeStr = "knife-edge (excluded)";
      knifeEdgeSkipped++;
    } else {
      const y = last.spot > s.strike ? 1 : 0;
      outcomeStr = y ? "ABOVE" : "below";
      for (const sn of snaps) {
        // score the mid ONLY on ticks where both models scored, so the three
        // Brier columns are computed over the identical tick set
        if (!Number.isFinite(sn.p_fair_base as number) || !Number.isFinite(sn.p_fair_enh as number)) continue;
        const mid = Number.isFinite(sn.mkt_bid as number) && Number.isFinite(sn.mkt_ask as number)
          ? ((sn.mkt_bid as number) + (sn.mkt_ask as number)) / 2 : NaN;
        if (!Number.isFinite(mid)) continue;
        brier.base.push(((sn.p_fair_base as number) - y) ** 2);
        brier.enh.push(((sn.p_fair_enh as number) - y) ** 2);
        brier.mkt.push((mid - y) ** 2);
      }
    }
  } else if (expired) {
    outcomeStr = "expired (stale tail — excluded)";
  }

  const pnlMkt = sum?.pnlMarkUsd ?? null;
  if (typeof pnlMkt === "number") totPnlMkt += pnlMkt;
  totFills += sum?.fills ?? 0;
  totRebates += sum?.rebatesUsd ?? 0;
  console.log(
    `  ${s.session}  snaps ${snaps.length}  fills ${sum?.fills ?? "?"}  ` +
    `pnl(mkt) ${typeof pnlMkt === "number" ? `$${pnlMkt.toFixed(2)}` : "?"}  outcome ${outcomeStr}`,
  );
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
console.log(`\n── aggregate (${nSessions} sessions) ──`);
console.log(`  paper PnL (marked to market, OPTIMISTIC): $${totPnlMkt.toFixed(2)}  fills ${totFills}  rebates $${totRebates.toFixed(2)}`);
console.log(`  model A/B/market (Brier, lower better, ${brier.base.length} scored ticks, ${knifeEdgeSkipped} knife-edge sessions excluded):`);
console.log(`    baseline ${mean(brier.base).toFixed(4)}   enhanced ${mean(brier.enh).toFixed(4)}   MARKET MID ${mean(brier.mkt).toFixed(4)}`);
if (brier.base.length >= 500) {
  const bestModel = Math.min(mean(brier.base), mean(brier.enh));
  const better = mean(brier.enh) < mean(brier.base) ? "ENHANCED" : "BASELINE";
  console.log(`    → ${better} is winning the model A/B (ticks are autocorrelated — judge across many sessions, not one).`);
  if (mean(brier.mkt) < bestModel) {
    console.log(`    → ⚠ the MARKET MID beats both models — the fair value has NO edge over the market as scored. A maker quoting off a worse fair than the mid is supplying edge, not capturing it.`);
  } else {
    console.log(`    → our best model beats the market mid — the fair value carries real information beyond the book.`);
  }
} else {
  console.log(`    → too few scored ticks to call; let the daemon run.`);
}
db.close();
