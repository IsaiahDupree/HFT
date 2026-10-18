/**
 * One-shot inference of capsule diversity profile from the bound agent's
 * genome kind. Writes strategy_family / asset_class / allowed_assets_json /
 * time_horizon / regime_dependency / directional_bias / diversity_profile_json
 * onto each capsule that doesn't already have an operator-set profile.
 *
 * Idempotent: re-running skips capsules whose `diversity_confidence` is
 * 'operator_set'. Pass `--force` to overwrite operator-set values too.
 *
 * Pass `--include-paused` to also infer for paused/stopped capsules
 * (default: only paper, live, draft).
 *
 *   npx tsx scripts/infer-capsule-diversity.ts
 *   npx tsx scripts/infer-capsule-diversity.ts --force
 *   npx tsx scripts/infer-capsule-diversity.ts --include-paused
 */
import "./_env.ts";
import { db as openDb } from "../src/lib/db/client.ts";
import {
  inferDiversityProfile,
  isKnownKind,
} from "../src/lib/capsules/diversity-inference.ts";

type Args = { force: boolean; includePaused: boolean; dryRun: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { force: false, includePaused: false, dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === "--force") args.force = true;
    else if (a === "--include-paused") args.includePaused = true;
    else if (a === "--dry-run") args.dryRun = true;
  }
  return args;
}

type CapsuleRow = {
  id: string;
  name: string;
  status: string;
  paper_agent_id: number | null;
  diversity_confidence: string | null;
  strategy_family: string | null;
  /** From paper_agents — present when capsule is bound to an evolved arena agent. */
  genome_json: string | null;
  /** From strategies.slug — present when capsule is bound via the gen-2 agents+strategies tables. */
  strategy_slug: string | null;
};

function main() {
  const args = parseArgs(process.argv);
  // Use the project's `db()` helper so runLightMigrations runs first —
  // ensures `diversity_confidence` etc. exist on older DBs before we query.
  const db = openDb();

  // SELECT capsules joined with the bound agent's genome.
  const statusFilter = args.includePaused
    ? "('draft','paper','live','paused','stopped')"
    : "('draft','paper','live')";
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.status, c.paper_agent_id, c.diversity_confidence,
              c.strategy_family, p.genome_json, s.slug AS strategy_slug
         FROM capsules c
         LEFT JOIN paper_agents p ON p.id = c.paper_agent_id
         LEFT JOIN strategies s ON s.id = c.strategy_id
        WHERE c.status IN ${statusFilter}
        ORDER BY c.created_at`,
    )
    .all() as CapsuleRow[];

  if (rows.length === 0) {
    console.log("[infer-capsule-diversity] no capsules found.");
    return;
  }

  const update = db.prepare(
    `UPDATE capsules
        SET strategy_family        = @strategy_family,
            asset_class            = @asset_class,
            allowed_assets_json    = @allowed_assets_json,
            time_horizon           = @time_horizon,
            regime_dependency      = @regime_dependency,
            directional_bias       = @directional_bias,
            diversity_profile_json = @diversity_profile_json,
            diversity_confidence   = 'inferred',
            updated_at             = datetime('now')
      WHERE id = @id`,
  );

  let updated = 0;
  let skippedOperator = 0;
  let skippedNoKind = 0;
  let unknownKind = 0;

  console.log(`[infer-capsule-diversity] scanning ${rows.length} capsule(s)...`);

  for (const c of rows) {
    if (c.diversity_confidence === "operator_set" && !args.force) {
      skippedOperator++;
      console.log(`  - ${c.id.slice(0, 8)} ${c.name.slice(0, 36)}  → operator-set, skipping (use --force to override)`);
      continue;
    }
    // Two possible sources of the strategy identifier:
    //   - paper_agents.genome_json.kind (arena-evolved capsules)
    //   - strategies.slug              (gen-2 explicit-strategy capsules)
    // Try genome_json first; fall back to strategy slug.
    let kind: string | null = null;
    if (c.genome_json) {
      try {
        kind = JSON.parse(c.genome_json).kind ?? null;
      } catch {
        kind = null;
      }
    }
    if (!kind && c.strategy_slug) kind = c.strategy_slug;

    if (!kind) {
      skippedNoKind++;
      console.log(`  - ${c.id.slice(0, 8)} ${c.name.slice(0, 36)}  → no genome_json or strategy_slug, skipping`);
      continue;
    }
    const wasKnown = isKnownKind(kind);
    if (!wasKnown) unknownKind++;

    const profile = inferDiversityProfile(kind);
    const params = {
      id: c.id,
      strategy_family: profile.strategy_family ?? null,
      asset_class: profile.asset_class ?? null,
      allowed_assets_json: profile.allowed_assets ? JSON.stringify(profile.allowed_assets) : null,
      time_horizon: profile.time_horizon ?? null,
      regime_dependency: profile.regime_dependency ?? null,
      directional_bias: profile.directional_bias ?? null,
      diversity_profile_json: JSON.stringify(profile),
    };
    if (args.dryRun) {
      console.log(`  ~ ${c.id.slice(0, 8)} ${c.name.slice(0, 36)}  kind=${kind}${wasKnown ? "" : " (unknown→fallback)"}  → family=${params.strategy_family} regime=${params.regime_dependency}`);
    } else {
      update.run(params);
      updated++;
      console.log(`  + ${c.id.slice(0, 8)} ${c.name.slice(0, 36)}  kind=${kind}${wasKnown ? "" : " (unknown→fallback)"}  → family=${params.strategy_family} regime=${params.regime_dependency}`);
    }
  }

  console.log("");
  console.log(`[infer-capsule-diversity] summary:`);
  console.log(`  updated:                 ${updated}`);
  console.log(`  skipped (operator_set):  ${skippedOperator}`);
  console.log(`  skipped (no genome):     ${skippedNoKind}`);
  console.log(`  unknown kinds (fallback): ${unknownKind}`);
  if (args.dryRun) console.log("  (dry-run — no DB writes)");
}

main();
