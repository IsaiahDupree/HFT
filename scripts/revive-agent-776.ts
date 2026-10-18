/**
 * Drop agent 776's exact genome into the current open generation as an
 * elite-protected agent so it keeps running indefinitely.
 *
 * 776 (`g33-c0-5m-binary-5a`, kind `poly_short_binary_directional`) posted
 * +$139.30 on 6 round-trips over a single 30-min gen on 2026-05-26 before
 * its lineage died in gen 34. Reviving here as `is_elite=1` means
 * evolve() will not retire it even if it's outranked, so the params get
 * an extended live-tick trial.
 *
 * Idempotent: refuses to re-insert if an agent with the same name already
 * exists in the current open generation. Run again with
 * REVIVE_FORCE_RENAME=1 to suffix `-v2`, `-v3` etc.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { insertPaperAgent } from "../src/lib/arena/db.ts";
import { parseGenome } from "../src/lib/arena/genome.ts";

const SOURCE_AGENT_ID = 776;
const REVIVE_NAME = "g{GEN}-revive-776";
const CASH_USD_START = 100;

function findOpenGen(): { id: number; gen_number: number } {
  const row = db().prepare(
    `SELECT id, gen_number FROM paper_generations
      WHERE sealed_at IS NULL
      ORDER BY gen_number DESC LIMIT 1`,
  ).get() as { id: number; gen_number: number } | undefined;
  if (!row) {
    throw new Error("No open generation. Run `npm run arena:tick` to start one, then re-run this script.");
  }
  return row;
}

function getAgent(id: number) {
  const row = db().prepare(
    `SELECT id, name, generation, genome_json, realized_pnl_usd, trades_count, wins_count
       FROM paper_agents WHERE id = ?`,
  ).get(id) as
    | { id: number; name: string; generation: number; genome_json: string;
        realized_pnl_usd: number; trades_count: number; wins_count: number }
    | undefined;
  if (!row) throw new Error(`Source agent ${id} not found`);
  return row;
}

function pickName(baseName: string, gen: number): string {
  const proposed = baseName.replace("{GEN}", String(gen));
  const existing = db().prepare(
    `SELECT name FROM paper_agents WHERE generation = ? AND name LIKE ?`,
  ).all(gen, `${proposed}%`) as { name: string }[];
  if (existing.length === 0) return proposed;
  if (process.env.REVIVE_FORCE_RENAME !== "1") {
    throw new Error(
      `Agent '${proposed}' already exists in gen ${gen}. ` +
      `Re-run with REVIVE_FORCE_RENAME=1 to create a suffixed copy.`,
    );
  }
  let i = 2;
  while (existing.some((e) => e.name === `${proposed}-v${i}`)) i += 1;
  return `${proposed}-v${i}`;
}

function main(): void {
  const source = getAgent(SOURCE_AGENT_ID);
  const genome = parseGenome(source.genome_json);
  const openGen = findOpenGen();
  const name = pickName(REVIVE_NAME, openGen.gen_number);

  console.log(`Source agent: #${source.id} ${source.name}`);
  console.log(`  generation : ${source.generation}`);
  console.log(`  realized   : $${source.realized_pnl_usd.toFixed(2)} on ${source.trades_count} round-trips (${source.wins_count} wins)`);
  console.log(`  kind       : ${genome.kind}`);
  console.log("");
  console.log(`Open generation: gen ${openGen.gen_number} (paper_generations.id=${openGen.id})`);
  console.log(`Inserting as : ${name} (elite-protected, $${CASH_USD_START} starting cash)`);
  console.log("");

  const newId = insertPaperAgent({
    name,
    generation: openGen.gen_number,
    parent_paper_agent_id: source.id,
    genome,
    introduced_by: "manual-revive-776",
    cash_usd_start: CASH_USD_START,
  });

  db().prepare(
    `UPDATE paper_agents SET is_elite = 1 WHERE id = ?`,
  ).run(newId);

  db().prepare(
    `INSERT INTO evolution_log (event_type, summary, payload_json)
     VALUES ('arena-revive', @summary, @payload)`,
  ).run({
    summary: `revived agent ${source.id} (${source.name}) into gen ${openGen.gen_number} as elite (#${newId} ${name})`,
    payload: JSON.stringify({
      action: "revive-elite",
      source_paper_agent_id: source.id,
      new_paper_agent_id: newId,
      new_name: name,
      generation: openGen.gen_number,
      cash_usd_start: CASH_USD_START,
      reason: "manual revive of g33-c0 5m-binary winner with original loose params",
    }),
  });

  console.log(`✓ inserted paper_agents.id=${newId}, is_elite=1`);
  console.log(`  next arena:tick will include it; evolve() cannot retire it.`);
  console.log("");
  console.log(`To pause it later: UPDATE paper_agents SET is_elite=0, alive=0, retire_reason='manual-pause' WHERE id=${newId};`);
}

main();
