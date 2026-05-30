/**
 * Seed generation 0 — N=8 random agents (configurable via ARENA_POP_SIZE).
 * Idempotent guard: refuses if any paper_agents already exist.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { GENOME_KINDS, randomGenome, genomeNickname } from "../src/lib/arena/genome.ts";
import { insertPaperAgent, startGeneration, setGenerationAgentCount } from "../src/lib/arena/db.ts";

const POP_SIZE = Number(process.env.ARENA_POP_SIZE ?? "8");
const STARTING_CASH = (() => {
  const i = process.argv.indexOf("--starting-cash");
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return Number(process.env.ARENA_STARTING_CASH ?? "100");
})();

const handle = db();
const existing = (handle.prepare("SELECT COUNT(*) AS n FROM paper_agents").get() as { n: number }).n;
if (existing > 0) {
  console.log(`arena:init refused — paper_agents already has ${existing} rows. Run arena:evolve to advance, or wipe the table to re-seed.`);
  process.exit(1);
}

const polyConditionIdPool = (handle.prepare("SELECT poly_condition_id FROM cross_venue_arbs WHERE active = 1").all() as { poly_condition_id: string }[])
  .map((r) => r.poly_condition_id);

// Round-robin across the strategy kinds so generation 0 is diverse.
const rng = Math.random;
const ids: number[] = [];
const seenName = new Set<string>();
const genId = startGeneration(0, undefined, `seed pop=${POP_SIZE} kinds=${GENOME_KINDS.join(",")}`);
for (let i = 0; i < POP_SIZE; i++) {
  const kind = GENOME_KINDS[i % GENOME_KINDS.length];
  const genome = randomGenome(rng, kind, { polyConditionIdPool });
  let baseName = `g0-a${i}-${genomeNickname(genome)}`;
  let name = baseName;
  let suffix = 0;
  while (seenName.has(name)) { suffix += 1; name = `${baseName}-${suffix}`; }
  seenName.add(name);
  const id = insertPaperAgent({ name, generation: 0, genome, cash_usd_start: STARTING_CASH });
  ids.push(id);
}
setGenerationAgentCount(genId, ids.length);
console.log(`arena:init seeded gen0 with ${ids.length} agents @ $${STARTING_CASH} each (ids ${ids.join(", ")}).`);
