/**
 * Portfolio snapshot worker (Phase 7).
 *
 * Runs once per UTC day (or on-demand via this script). Two jobs:
 *
 *   1. Snapshot today's daily_pnl_usd from every live + paper capsule into
 *      `capsule_pnl_daily` BEFORE the next-day auto-reset zeroes it. UPSERT
 *      on (capsule_id, pnl_date) so re-running on the same day is idempotent.
 *
 *   2. Compute pair correlations across live capsules using the recent
 *      history in `capsule_pnl_daily` and write one row per pair into
 *      `capsule_correlations` with verdict + low_confidence flag.
 *
 * Recommended cron: 23:55 UTC daily (just before the daily-reset boundary
 * so we capture each capsule's full day before it gets zeroed by the next
 * order's gate check). Manual invocation also fine.
 *
 *   npx tsx scripts/worker-portfolio-snapshot.ts
 *   npx tsx scripts/worker-portfolio-snapshot.ts --window-days 60
 *   npx tsx scripts/worker-portfolio-snapshot.ts --dry-run
 *
 * No live-trading side effects. Purely observational data layer for the
 * cluster kill switches (Phase 8) + global risk governor (Phase 9).
 */
import "./_env.ts";
import { db as openDb } from "../src/lib/db/client.ts";
import {
  computePairStats,
  DEFAULT_THRESHOLDS,
  type DailyPnlPoint,
  type VerdictThresholds,
} from "../src/lib/portfolio/correlation.ts";

type Args = { windowDays: number; dryRun: boolean; minSamples: number };

function parseArgs(argv: string[]): Args {
  const args: Args = { windowDays: 30, dryRun: false, minSamples: DEFAULT_THRESHOLDS.minConfidentSamples };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--window-days") args.windowDays = Number(argv[++i]);
    else if (a === "--min-samples") args.minSamples = Number(argv[++i]);
  }
  return args;
}

type CapsuleRow = {
  id: string;
  name: string;
  status: string;
  capital_available_usd: number;
  open_position_cost_usd: number;
  daily_pnl_usd: number;
  trades_today: number;
  strategy_family: string | null;
  allowed_assets_json: string | null;
};

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseAllowedAssets(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function snapshotDailyPnl(db: ReturnType<typeof openDb>, args: Args): { snapshotted: number; date: string } {
  const date = todayUtc();
  const capsules = db
    .prepare(
      `SELECT id, name, status, capital_available_usd, open_position_cost_usd,
              daily_pnl_usd, trades_today,
              strategy_family, allowed_assets_json
         FROM capsules
        WHERE status IN ('live', 'paper')`,
    )
    .all() as CapsuleRow[];

  if (capsules.length === 0) return { snapshotted: 0, date };

  const upsert = db.prepare(
    `INSERT INTO capsule_pnl_daily
       (capsule_id, pnl_date, daily_pnl_usd, trades_count, ending_equity_usd)
     VALUES (@capsule_id, @pnl_date, @daily_pnl_usd, @trades_count, @ending_equity_usd)
     ON CONFLICT(capsule_id, pnl_date) DO UPDATE SET
       daily_pnl_usd = excluded.daily_pnl_usd,
       trades_count  = excluded.trades_count,
       ending_equity_usd = excluded.ending_equity_usd`,
  );

  let snapshotted = 0;
  for (const c of capsules) {
    const endingEquity =
      (Number.isFinite(c.capital_available_usd) ? c.capital_available_usd : 0) +
      (Number.isFinite(c.open_position_cost_usd) ? c.open_position_cost_usd : 0);
    if (args.dryRun) {
      console.log(`  ~ ${c.id.slice(0, 8)} ${c.name.slice(0, 30)}  date=${date}  pnl=$${c.daily_pnl_usd.toFixed(2)}  trades=${c.trades_today}  equity=$${endingEquity.toFixed(2)}`);
    } else {
      upsert.run({
        capsule_id: c.id,
        pnl_date: date,
        daily_pnl_usd: c.daily_pnl_usd,
        trades_count: c.trades_today,
        ending_equity_usd: endingEquity,
      });
      snapshotted++;
    }
  }
  return { snapshotted, date };
}

type SeriesRow = { capsule_id: string; pnl_date: string; daily_pnl_usd: number };

function computeAndStoreCorrelations(db: ReturnType<typeof openDb>, args: Args): { pairs: number; verdicts: Record<string, number> } {
  const date = todayUtc();

  // Load all live + paper capsules with their diversity metadata.
  const capsules = db
    .prepare(
      `SELECT id, name, strategy_family, allowed_assets_json
         FROM capsules
        WHERE status IN ('live', 'paper')`,
    )
    .all() as { id: string; name: string; strategy_family: string | null; allowed_assets_json: string | null }[];

  // Pull recent daily-PnL series for each capsule in the window.
  const rows = db
    .prepare(
      `SELECT capsule_id, pnl_date, daily_pnl_usd
         FROM capsule_pnl_daily
        WHERE pnl_date >= date('now', '-' || ? || ' days')
        ORDER BY pnl_date ASC`,
    )
    .all(args.windowDays) as SeriesRow[];

  const seriesByCapsule = new Map<string, DailyPnlPoint[]>();
  for (const r of rows) {
    const list = seriesByCapsule.get(r.capsule_id) ?? [];
    list.push({ date: r.pnl_date, pnl: r.daily_pnl_usd });
    seriesByCapsule.set(r.capsule_id, list);
  }

  const insert = db.prepare(
    `INSERT INTO capsule_correlations
       (snapshot_date, capsule_a, capsule_b, pnl_corr, asset_overlap,
        strategy_family_match, loss_overlap, drawdown_overlap,
        sample_days, verdict, low_confidence)
     VALUES
       (@snapshot_date, @capsule_a, @capsule_b, @pnl_corr, @asset_overlap,
        @strategy_family_match, @loss_overlap, @drawdown_overlap,
        @sample_days, @verdict, @low_confidence)`,
  );

  const thresholds: VerdictThresholds = { ...DEFAULT_THRESHOLDS, minConfidentSamples: args.minSamples };
  const verdicts: Record<string, number> = { diversified: 0, correlated_safe: 0, too_similar: 0 };
  let pairs = 0;

  for (let i = 0; i < capsules.length; i++) {
    for (let j = i + 1; j < capsules.length; j++) {
      const A = capsules[i]!;
      const B = capsules[j]!;
      const seriesA = seriesByCapsule.get(A.id) ?? [];
      const seriesB = seriesByCapsule.get(B.id) ?? [];
      const report = computePairStats(
        {
          capsule_a: A.id,
          capsule_b: B.id,
          seriesA,
          seriesB,
          allowedAssetsA: parseAllowedAssets(A.allowed_assets_json),
          allowedAssetsB: parseAllowedAssets(B.allowed_assets_json),
          strategyFamilyA: A.strategy_family,
          strategyFamilyB: B.strategy_family,
        },
        thresholds,
      );
      verdicts[report.verdict] = (verdicts[report.verdict] ?? 0) + 1;
      if (args.dryRun) {
        console.log(`  ~ ${A.id.slice(0, 8)}/${B.id.slice(0, 8)}  pnl_corr=${report.pnl_corr === null ? "n/a" : report.pnl_corr.toFixed(3)}  asset=${report.asset_overlap.toFixed(2)}  fam_match=${report.strategy_family_match}  loss_overlap=${report.loss_overlap.toFixed(2)}  n=${report.sample_days}  → ${report.verdict}${report.low_confidence ? " (low-confidence)" : ""}`);
      } else {
        insert.run({
          snapshot_date: date,
          capsule_a: A.id,
          capsule_b: B.id,
          pnl_corr: report.pnl_corr,
          asset_overlap: report.asset_overlap,
          strategy_family_match: report.strategy_family_match,
          loss_overlap: report.loss_overlap,
          drawdown_overlap: report.drawdown_overlap,
          sample_days: report.sample_days,
          verdict: report.verdict,
          low_confidence: report.low_confidence ? 1 : 0,
        });
        pairs++;
      }
    }
  }

  return { pairs, verdicts };
}

function main() {
  const args = parseArgs(process.argv);
  const db = openDb();

  console.log("[portfolio-snapshot] step 1/2 — snapshotting daily PnL...");
  const snap = snapshotDailyPnl(db, args);
  console.log(`  ${args.dryRun ? "(dry-run) " : ""}wrote ${snap.snapshotted} row(s) into capsule_pnl_daily for ${snap.date}.`);

  console.log("");
  console.log(`[portfolio-snapshot] step 2/2 — computing pair correlations (window=${args.windowDays}d)...`);
  const stats = computeAndStoreCorrelations(db, args);
  console.log(`  ${args.dryRun ? "(dry-run) " : ""}wrote ${stats.pairs} pair row(s) into capsule_correlations.`);
  console.log(`  verdicts: diversified=${stats.verdicts.diversified}  correlated_safe=${stats.verdicts.correlated_safe}  too_similar=${stats.verdicts.too_similar}`);

  if (args.dryRun) console.log("\n  (dry-run — no DB writes)");
}

main();
