/**
 * Initialize the reserve capsule (Phase 11 of capsule-portfolio-governance PRD §4.7).
 *
 * Seeds a single capsule row with status='paused' and strategy_family='reserve'.
 * The Global Risk Governor (Phase 9) hard-rejects every proposal where the
 * capsule's strategy_family is 'reserve' — capital is by design un-deployable
 * by any agent.
 *
 * Capital allocation = ARENA_RESERVE_PCT × ARENA_TOTAL_ACCOUNT_USD.
 *   - ARENA_RESERVE_PCT defaults to 0.50, HARD FLOORED at 0.25
 *   - ARENA_TOTAL_ACCOUNT_USD is the operator's full Polymarket balance
 *     (env-supplied; required)
 *
 * Idempotent: re-running updates only the capital allocation (if env
 * changed); does NOT create a duplicate row. Pass --force to recreate.
 *
 *   npx tsx scripts/init-reserve-capsule.ts
 *   npx tsx scripts/init-reserve-capsule.ts --force
 *   npx tsx scripts/init-reserve-capsule.ts --dry-run
 */
import "./_env.ts";
import { randomUUID } from "node:crypto";
import { db as openDb } from "../src/lib/db/client.ts";
import {
  readGovernorThresholdsFromEnv,
  RESERVE_PCT_HARD_FLOOR,
} from "../src/lib/portfolio/governor.ts";

type Args = { force: boolean; dryRun: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { force: false, dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === "--force") args.force = true;
    else if (a === "--dry-run") args.dryRun = true;
  }
  return args;
}

const RESERVE_CAPSULE_ID = "reserve-floor";

function main() {
  const args = parseArgs(process.argv);
  const db = openDb();
  const thresholds = readGovernorThresholdsFromEnv();

  const totalAccountRaw = process.env.ARENA_TOTAL_ACCOUNT_USD ?? process.env.RISK_TOTAL_ACCOUNT_USD;
  const totalAccount = totalAccountRaw ? Number(totalAccountRaw.replace(/[^0-9.]/g, "")) : 0;
  if (!Number.isFinite(totalAccount) || totalAccount <= 0) {
    console.error(
      "[init-reserve-capsule] ARENA_TOTAL_ACCOUNT_USD not set. Set it to your Polymarket account balance.",
    );
    console.error("  Example: ARENA_TOTAL_ACCOUNT_USD=20 in .env.local");
    process.exit(2);
  }

  const reservePct = Math.max(RESERVE_PCT_HARD_FLOOR, thresholds.reservePct);
  const reserveUsd = +(totalAccount * reservePct).toFixed(2);

  console.log("[init-reserve-capsule] computed reserve:");
  console.log(`  total account:  $${totalAccount.toFixed(2)} (env)`);
  console.log(`  reserve pct:    ${(reservePct * 100).toFixed(1)}% (floored at ${(RESERVE_PCT_HARD_FLOOR * 100).toFixed(1)}%)`);
  console.log(`  reserve usd:    $${reserveUsd.toFixed(2)}`);
  console.log("");

  const existing = db
    .prepare("SELECT id, capital_allocated_usd, strategy_family, status FROM capsules WHERE id = ?")
    .get(RESERVE_CAPSULE_ID) as
    | { id: string; capital_allocated_usd: number; strategy_family: string | null; status: string }
    | undefined;

  if (existing && !args.force) {
    if (Math.abs(existing.capital_allocated_usd - reserveUsd) < 0.005) {
      console.log("[init-reserve-capsule] reserve capsule already exists and is up-to-date — no-op");
      return;
    }
    console.log(`[init-reserve-capsule] updating reserve capital $${existing.capital_allocated_usd.toFixed(2)} → $${reserveUsd.toFixed(2)}`);
    if (args.dryRun) {
      console.log("  (dry-run — no DB writes)");
      return;
    }
    db.prepare(
      `UPDATE capsules
          SET capital_allocated_usd = ?,
              capital_available_usd = ?,
              strategy_family       = 'reserve',
              status                = 'paused',
              updated_at            = datetime('now')
        WHERE id = ?`,
    ).run(reserveUsd, reserveUsd, RESERVE_CAPSULE_ID);
    console.log("[init-reserve-capsule] updated.");
    return;
  }

  if (existing && args.force) {
    console.log(`[init-reserve-capsule] --force: rewriting existing reserve capsule (was $${existing.capital_allocated_usd.toFixed(2)})`);
    if (!args.dryRun) {
      db.prepare("DELETE FROM capsules WHERE id = ?").run(RESERVE_CAPSULE_ID);
    }
  }

  if (args.dryRun) {
    console.log(`[init-reserve-capsule] (dry-run) would create reserve capsule '${RESERVE_CAPSULE_ID}' with $${reserveUsd.toFixed(2)}`);
    return;
  }

  db.prepare(
    `INSERT INTO capsules
       (id, name, status, strategy_family, asset_class,
        capital_allocated_usd, capital_available_usd, capital_deployed_usd,
        max_daily_loss_usd, max_total_drawdown_usd,
        max_position_pct, max_open_positions, max_trades_per_day,
        allowed_venues_json, allowed_symbols_json,
        min_seconds_between_trades,
        diversity_confidence,
        created_at, updated_at)
     VALUES
       (@id, @name, 'paused', 'reserve', NULL,
        @capital, @capital, 0,
        0, 0,
        0, 0, 0,
        '[]', NULL,
        0,
        'operator_set',
        datetime('now'), datetime('now'))`,
  ).run({
    id: RESERVE_CAPSULE_ID,
    name: `Reserve floor (${(reservePct * 100).toFixed(0)}% of account)`,
    capital: reserveUsd,
  });
  void randomUUID; // (placeholder; we use a fixed id for the reserve)

  console.log(`[init-reserve-capsule] created reserve capsule '${RESERVE_CAPSULE_ID}' with $${reserveUsd.toFixed(2)} (status=paused, strategy_family=reserve)`);
  console.log("");
  console.log("Behavior:");
  console.log("  - Governor rejects every proposal where capsule.strategy_family='reserve'");
  console.log("  - Reserve capital is EXCLUDED from active-capital denominator in correlation/family math");
  console.log("  - Status='paused' means it won't be auto-promoted or scheduled by the arena loop");
  console.log("  - To rebalance: change ARENA_TOTAL_ACCOUNT_USD or ARENA_RESERVE_PCT in env, then re-run this script");
}

main();
