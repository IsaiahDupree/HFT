/**
 * go-live-check — the decision-pipeline GO-LIVE pre-flight (the automatable half of the
 * checklist in live-capsule.ts). Reads the shadow decision_journal and prints a READY /
 * NOT_READY verdict; exits 1 when NOT_READY so it can gate a deploy/arming step.
 *
 *   npm run go-live-check            # assess the most recent 5000 journaled decisions
 *   npm run go-live-check -- --limit 2000
 *
 * Run this (green) BEFORE flipping DECISION_PIPELINE_ENABLED=1, and still eyeball a sample
 * of REJECTED + APPROVED_FULL reasons by hand — the manual half the script can't automate.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { assessPreflight, renderPreflight, type JournaledDecision } from "../src/lib/decision/preflight.ts";

const arg = (name: string, def: number): number => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
};
const limit = arg("--limit", 5000);

const rows = db()
  .prepare(`SELECT ts, decision, approval_score, gate_results_json FROM decision_journal ORDER BY id DESC LIMIT ?`)
  .all(limit) as JournaledDecision[];

const result = assessPreflight(rows);
console.log("\n" + renderPreflight(result) + "\n");
process.exit(result.ready ? 0 : 1);
