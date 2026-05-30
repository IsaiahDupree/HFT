/**
 * hft-pipeline — the factory → arena → allocator loop in one command.
 *
 * Chains the scale-layer pieces end to end:
 *   1. worker:snapshot : OBTAIN real market data (Polymarket + Coinbase + short
 *      binaries + candles) into the local DB (best-effort — needs network).
 *   2. strategy-factory --arena --seed : populate the arena (paper_agents) from a
 *      genome grid (the "hundreds of thousands of strategies" sampled down to a
 *      bounded batch at stage:sim).
 *   3. arena:tick : score the population against the real snapshots.
 *   4. arena:allocate --commit : decide which agents get a capsule of money and
 *      why, logging the rationale to evolution_log.
 *
 *   npm run hft:pipeline                       # defaults: seed 60, 3 ticks, $10k pool
 *   npm run hft:pipeline -- --seed 120 --ticks 5 --budget 25000 --snaps 2
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
const SNAPS = arg("--snaps", 1);

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

console.log(`\n╔═ HFT pipeline · snaps=${SNAPS} seed=${SEED} ticks=${TICKS} pool=$${BUDGET.toLocaleString()} ═╗`);

// 1. Obtain real market data (best-effort — needs network)
let dataOk = false;
for (let i = 0; i < SNAPS; i++) {
  dataOk = step(`1/4 worker:snapshot — obtain real market data (${i + 1}/${SNAPS})`, `npx tsx scripts/snapshot-worker.ts`, { allowFail: true }) || dataOk;
}
if (!dataOk) console.log("   ↳ no live data (offline?) — agents can't be scored; allocation will fall back to even split.");

// 2. Factory → arena population
step("2/4 factory → seed arena population (genome grid)", `npx tsx scripts/strategy-factory.ts --arena --seed --limit ${SEED}`);

// 3. Score the population against the real snapshots
let ticked = 0;
for (let i = 0; i < TICKS; i++) {
  const ok = step(`3/4 arena:tick (${i + 1}/${TICKS})`, `npx tsx scripts/arena-tick.ts`, { allowFail: true });
  if (!ok) { console.log("   ↳ tick failed — continuing to allocation."); break; }
  ticked++;
}

// 4. Allocate capsules over the (scored) leaderboard.
// With real scores, fund only proven positive-fitness agents (risk discipline);
// without any scores, fall back to an even split so the wiring is still visible.
const gate = ticked > 0 && dataOk ? "--min-trades 0 --min-fitness 0.00001" : "--min-trades 0 --min-fitness -1";
step("4/4 arena:allocate → grant capsules + log rationale", `npx tsx scripts/arena-allocate.ts --commit --budget ${BUDGET} ${gate}`);

console.log(`\n╚═ pipeline complete — data=${dataOk ? "live" : "none"}, ${ticked} tick(s) scored. The allocator funds only`);
console.log(`   proven positive-fitness agents; on a short window that may be zero — that's the risk discipline.`);
console.log(`   Run continuously (cron: worker:snapshot + arena:tick every 5m) to accrue real edge. ═╝\n`);
