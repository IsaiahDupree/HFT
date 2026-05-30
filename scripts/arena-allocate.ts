/**
 * arena-allocate — run the capital allocator over the arena leaderboard and
 * report which agents should get a capsule of money and why.
 *
 *   npx tsx scripts/arena-allocate.ts                       # DRY RUN: print the plan
 *   npx tsx scripts/arena-allocate.ts --budget 10000 --max-capsules 10 --max-share 0.25
 *   npx tsx scripts/arena-allocate.ts --commit              # also append a capital-allocation
 *                                                           # audit event to evolution_log
 *
 * The allocator only PROPOSES (and audits) allocations — promoting a capsule to
 * live remains an explicit operator action. Pure policy lives in
 * src/lib/arena/allocator.ts; this script is just I/O + presentation.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { planAllocations, type AllocationInput } from "../src/lib/arena/allocator.ts";
import { getCurrentGeneration, listAllAgentsForGen, listAliveAgentsAcrossGens } from "../src/lib/arena/db.ts";

function num(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}

function main(): void {
  const input: AllocationInput = {
    totalBudgetUsd: num("--budget", 10_000),
    maxCapsules: num("--max-capsules", 10),
    minFitness: num("--min-fitness", 0),
    minTrades: num("--min-trades", 1),
    maxShare: num("--max-share", 0.25),
  };
  const commit = process.argv.includes("--commit");

  // Pick the generation to allocate over: the open one if present, else all alive.
  const gen = getCurrentGeneration();
  const agents = gen ? listAllAgentsForGen(gen.gen_number) : listAliveAgentsAcrossGens();

  if (agents.length === 0) {
    console.log("No paper-agents found. Seed the arena first: `npm run arena:init` then `npm run arena:tick`.");
    return;
  }

  const plan = planAllocations(agents, input);
  plan.generatedAt = new Date().toISOString();

  console.log(
    `\n══ capital allocation · ${gen ? `gen ${gen.gen_number}` : "all-alive"} · ` +
      `pool $${input.totalBudgetUsd.toLocaleString()} · ≤${input.maxCapsules} capsules · ` +
      `cap ${(input.maxShare * 100).toFixed(0)}%/capsule ══\n`,
  );
  console.log("  rank  agent                       fitness   pnl%   maxDD%  win%  trades   grant      why");
  for (const d of plan.decisions.slice(0, Math.max(plan.funded.length + 5, 12))) {
    const mark = d.funded ? "✅" : "➖";
    console.log(
      `  ${String(d.rank).padStart(3)}  ${mark} ${d.agentName.slice(0, 22).padEnd(22)} ` +
        `${d.fitness.toFixed(3).padStart(7)} ${String(d.pnlPct).padStart(6)} ${String(d.maxDdPct).padStart(7)} ` +
        `${String(d.winRate).padStart(5)} ${String(d.trades).padStart(6)}  ${("$" + d.grantUsd.toFixed(2)).padStart(9)}`,
    );
  }
  console.log(
    `\n  funded ${plan.funded.length} capsule(s), $${plan.totalAllocatedUsd.toLocaleString()} of ` +
      `$${plan.totalBudgetUsd.toLocaleString()} deployed.`,
  );
  console.log("\n  rationale (the \"why\"):");
  for (const d of plan.funded) console.log(`   • ${d.agentName}: ${d.reason}`);

  if (!commit) {
    console.log(`\n  DRY RUN — no DB writes. Re-run with --commit to append a capital-allocation event to evolution_log.`);
    return;
  }

  db()
    .prepare(
      `INSERT INTO evolution_log (agent_id, strategy_id, event_type, summary, payload_json)
       VALUES (NULL, NULL, 'capital-allocation', @summary, @payload)`,
    )
    .run({
      summary: `Allocated $${plan.totalAllocatedUsd} across ${plan.funded.length} capsules from a $${plan.totalBudgetUsd} pool.`,
      payload: JSON.stringify(plan),
    });
  console.log(`\n  COMMITTED capital-allocation audit event to evolution_log.`);
}

main();
