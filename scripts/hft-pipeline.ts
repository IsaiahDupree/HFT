/**
 * hft-pipeline — the factory → arena → allocator loop in one command.
 *
 * Chains the scale-layer pieces end to end:
 *   1. strategy-factory --arena --seed : populate the arena (paper_agents) from a
 *      genome grid (the "hundreds of thousands of strategies" sampled down to a
 *      bounded batch at stage:sim).
 *   2. arena:tick : score the population against real market snapshots
 *      (best-effort — skipped with a note if `npm run worker:snapshot` hasn't run).
 *   3. arena:allocate --commit : decide which agents get a capsule of money and
 *      why, logging the rationale to evolution_log.
 *
 *   npm run hft:pipeline                       # defaults: seed 60, 3 ticks, $10k pool
 *   npm run hft:pipeline -- --seed 120 --ticks 5 --budget 25000
 *
 * Safe: seeding is bounded; ticks are sim; allocation only audits (capsule
 * activation toward real money stays an explicit operator action).
 */
import "./_env.ts";
import { execSync } from "node:child_process";

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}

const SEED = arg("--seed", 60);
const TICKS = arg("--ticks", 3);
const BUDGET = arg("--budget", 10_000);

function step(label: string, cmd: string, opts: { allowFail?: boolean } = {}): boolean {
  console.log(`\n━━ ${label}\n$ ${cmd}`);
  try {
    execSync(cmd, { stdio: "inherit" });
    return true;
  } catch (e) {
    if (opts.allowFail) {
      console.log(`   ↳ skipped: ${(e as Error).message.split("\n")[0]}`);
      return false;
    }
    throw e;
  }
}

console.log(`\n╔═ HFT pipeline · seed=${SEED} ticks=${TICKS} pool=$${BUDGET.toLocaleString()} ═╗`);

// 1. Factory → arena population
step("1/3 factory → seed arena population (genome grid)", `npx tsx scripts/strategy-factory.ts --arena --seed --limit ${SEED}`);

// 2. Score the population (needs snapshots; best-effort)
let ticked = 0;
for (let i = 0; i < TICKS; i++) {
  const ok = step(`2/3 arena:tick (${i + 1}/${TICKS})`, `npx tsx scripts/arena-tick.ts`, { allowFail: true });
  if (!ok) {
    console.log("   ↳ no market snapshots — run `npm run worker:snapshot` first to get real scores. Continuing to allocation.");
    break;
  }
  ticked++;
}

// 3. Allocate capsules over the (scored) leaderboard
// min-trades/min-fitness relaxed so a freshly-seeded, un-ticked population is
// still demonstrably allocated; tighten these once ticks have produced scores.
const gate = ticked > 0 ? "--min-trades 1 --min-fitness 0" : "--min-trades 0 --min-fitness -1";
step("3/3 arena:allocate → grant capsules + log rationale", `npx tsx scripts/arena-allocate.ts --commit --budget ${BUDGET} ${gate}`);

console.log(`\n╚═ pipeline complete — ${ticked} tick(s) scored. Inspect evolution_log for the capital-allocation rationale. ═╝\n`);
