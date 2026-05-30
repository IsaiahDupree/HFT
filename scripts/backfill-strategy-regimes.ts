/**
 * Backfill `regimes` declarations into existing strategy_versions.spec_json
 * rows (Phase 5 of gated-decision-system PRD).
 *
 * Walks every strategy_version, infers the appropriate regime list from the
 * strategy slug, and merges `regimes: [...]` into spec_json. Idempotent:
 * skips rows that already declare regimes (operator-set values preserved).
 * Pass --force to overwrite existing values.
 *
 *   npx tsx scripts/backfill-strategy-regimes.ts
 *   npx tsx scripts/backfill-strategy-regimes.ts --force
 *   npx tsx scripts/backfill-strategy-regimes.ts --dry-run
 */
import "./_env.ts";
import { db as openDb } from "../src/lib/db/client.ts";

type Args = { force: boolean; dryRun: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { force: false, dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === "--force") args.force = true;
    else if (a === "--dry-run") args.dryRun = true;
  }
  return args;
}

/**
 * Strategy-slug → regimes mapping. Mirrors the metadata in
 * src/lib/capsules/diversity-inference.ts but at the strategy-slug
 * granularity (a strategy and the genome kind on its bound paper agent are
 * different layers). Unknown slugs default to ["any"].
 */
const REGIMES_BY_STRATEGY_SLUG: Record<string, string[]> = {
  // Gen-1
  "fade-headline-spikes":    ["chop", "low_vol"],
  "stale-quote-arb":         ["any"],
  "weekly-deep-dives":       ["any"],
  "breakout-rider":          ["trending", "breakout"],
  "btc-price-threshold-fade":["chop", "low_vol"],

  // Gen-2
  "near-resolution-scrape":      ["any"],
  "cross-timeframe-spread-trade":["any"],
  "orderbook-imbalance-watch":   ["any"],
  "midwindow-trajectory":        ["trending", "breakout"],
  "consensus-tail-follow":       ["any"],
};

function regimesFor(slug: string): string[] {
  return REGIMES_BY_STRATEGY_SLUG[slug] ?? ["any"];
}

function main() {
  const args = parseArgs(process.argv);
  const db = openDb();

  const rows = db
    .prepare(
      `SELECT sv.id AS version_id, sv.strategy_id, sv.version, sv.spec_json, s.slug AS strategy_slug, s.name AS strategy_name
         FROM strategy_versions sv
         JOIN strategies s ON s.id = sv.strategy_id
        ORDER BY sv.id`,
    )
    .all() as Array<{
      version_id: number;
      strategy_id: number;
      version: number;
      spec_json: string;
      strategy_slug: string;
      strategy_name: string;
    }>;

  if (rows.length === 0) {
    console.log("[backfill-regimes] no strategy_versions found.");
    return;
  }

  const update = db.prepare(
    `UPDATE strategy_versions SET spec_json = ? WHERE id = ?`,
  );

  let updated = 0;
  let skipped = 0;
  let unknown = 0;

  console.log(`[backfill-regimes] scanning ${rows.length} strategy_version(s)...`);

  for (const r of rows) {
    let spec: Record<string, unknown>;
    try {
      spec = JSON.parse(r.spec_json) as Record<string, unknown>;
    } catch {
      console.log(`  ✗ ${String(r.version_id).padStart(4)} ${r.strategy_slug.slice(0, 30)}  → unparseable spec_json, skipping`);
      skipped++;
      continue;
    }

    if (spec.regimes && !args.force) {
      skipped++;
      continue;
    }

    const regimes = regimesFor(r.strategy_slug);
    const isFallback = !(r.strategy_slug in REGIMES_BY_STRATEGY_SLUG);
    if (isFallback) unknown++;

    const newSpec = { ...spec, regimes };
    if (args.dryRun) {
      console.log(`  ~ v${r.version_id.toString().padStart(4)} ${r.strategy_slug.slice(0, 35).padEnd(35)} → regimes=${JSON.stringify(regimes)}${isFallback ? " (unknown→fallback)" : ""}`);
    } else {
      update.run(JSON.stringify(newSpec), r.version_id);
      console.log(`  + v${r.version_id.toString().padStart(4)} ${r.strategy_slug.slice(0, 35).padEnd(35)} → regimes=${JSON.stringify(regimes)}${isFallback ? " (unknown→fallback)" : ""}`);
      updated++;
    }
  }

  console.log("");
  console.log(`[backfill-regimes] summary:`);
  console.log(`  updated:                  ${updated}`);
  console.log(`  skipped (already had regimes): ${skipped}`);
  console.log(`  unknown slugs (used fallback): ${unknown}`);
  if (args.dryRun) console.log(`  (dry-run — no DB writes)`);
}

main();
