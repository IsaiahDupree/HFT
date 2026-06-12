/**
 * pair-maker-report — judge the merge-maker forward track (pm_* tables).
 * Aggregates from GROUND TRUTH (pm_fills / pm_snaps) so crashed sessions count
 * (RAILS-REVIEW finding 12), with summary JSON shown alongside when present.
 * The Lane-A go/no-go metrics: pair-completion rate, locked margin vs unpaired
 * residue, and where fills happen in τ.
 *
 *   npx tsx scripts/pair-maker-report.ts            # all sessions
 *   npx tsx scripts/pair-maker-report.ts -- --days 3
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

const since = DAYS > 0 ? Date.now() - DAYS * 86_400_000 : 0;
const sessions = db.prepare("SELECT * FROM pm_sessions ORDER BY started_iso").all() as any[];

let nSessions = 0, nCrashed = 0, totFills = 0, totShares = 0, totMerged = 0;
let totLocked = 0, totRebates = 0, totPnl = 0;
const tauBuckets = { "<60s": 0, "60-180s": 0, ">180s": 0 } as Record<string, number>;

console.log(`pair-maker-report — ${DB_PATH}${DAYS ? ` (last ${DAYS}d)` : ""}\n`);
for (const s of sessions) {
  if (since && Date.parse(s.started_iso) < since) continue;
  const sum = s.summary ? JSON.parse(s.summary) : null;
  const last = db.prepare(
    "SELECT merged, locked_margin, rebates, pnl_mkt, inv_yes, inv_no FROM pm_snaps WHERE session=? ORDER BY ts DESC LIMIT 1",
  ).get(s.session) as any;
  const fills = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(shares),0) sh FROM pm_fills WHERE session=?").get(s.session) as any;
  if (!last && !fills?.n) continue;
  nSessions++;
  if (!sum) nCrashed++;
  totFills += fills?.n ?? 0;
  totShares += fills?.sh ?? 0;
  totMerged += last?.merged ?? 0;
  totLocked += last?.locked_margin ?? 0;
  totRebates += last?.rebates ?? 0;
  totPnl += last?.pnl_mkt ?? 0;
  for (const r of db.prepare("SELECT tau_sec FROM pm_fills WHERE session=?").all(s.session) as any[]) {
    tauBuckets[r.tau_sec < 60 ? "<60s" : r.tau_sec <= 180 ? "60-180s" : ">180s"]++;
  }
  const pc = fills?.sh > 0 ? ((2 * (last?.merged ?? 0)) / fills.sh) * 100 : null;
  console.log(
    `  ${s.session}${sum ? "" : "  [NO SUMMARY — crashed/killed]"}  fills ${fills?.n ?? 0}  merged ${last?.merged ?? 0}` +
    `  pair% ${pc === null ? "—" : pc.toFixed(0)}  locked $${(last?.locked_margin ?? 0).toFixed(2)}  pnl $${(last?.pnl_mkt ?? 0).toFixed(2)}  resid y${last?.inv_yes ?? 0}/n${last?.inv_no ?? 0}`,
  );
}

console.log(`\n── aggregate (${nSessions} sessions, ${nCrashed} without summary — counted from ground truth) ──`);
console.log(`  fills ${totFills} (${totShares} shares) · merged sets ${totMerged} · pair completion ${totShares > 0 ? ((2 * totMerged / totShares) * 100).toFixed(1) : "—"}%`);
console.log(`  locked margin $${totLocked.toFixed(2)} · rebates $${totRebates.toFixed(2)} · pnl(mkt, last-snap) $${totPnl.toFixed(2)}`);
console.log(`  fill τ distribution: ${Object.entries(tauBuckets).map(([k, v]) => `${k}: ${v}`).join(" · ")}`);
console.log(`  go/no-go: structural income (locked+rebates) must dominate the unpaired residue across weeks — and survive the queue-fill haircut (G3).`);
db.close();
