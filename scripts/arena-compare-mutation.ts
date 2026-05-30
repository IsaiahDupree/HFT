/**
 * Print a side-by-side comparison of mutation cohorts across the last N
 * generations. Reads paper_agents grouped by `introduced_by`.
 *
 * Usage:
 *   tsx scripts/arena-compare-mutation.ts            # last 5 gens
 *   tsx scripts/arena-compare-mutation.ts --lastN 10 # last 10 gens
 */
import "./_env.ts";
import { compareMutationCohorts } from "../src/lib/arena/mutation-stats.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const lastN = Number(arg("lastN") ?? "5");

const { cohorts, gens_considered, total_agents } = compareMutationCohorts({ lastN });

console.log(`\nMutation cohort comparison — last ${lastN} gens (${gens_considered.join(", ")}), ${total_agents} agents total\n`);
console.log("introduced_by             N    avg_fitness  med_fit  avg_pnl%  avg_dd%  trades  win%   top      bot");
console.log("------------------------ ----- ----------- -------- --------- -------- ------- ------ -------- --------");
for (const c of cohorts) {
  console.log(
    `${c.introduced_by.padEnd(24)} ${String(c.n_agents).padStart(5)}  ` +
    `${c.avg_fitness.toFixed(4).padStart(10)} ` +
    `${c.med_fitness.toFixed(4).padStart(8)}  ` +
    `${(c.avg_pnl_pct * 100).toFixed(2).padStart(7)}%  ` +
    `${(c.avg_dd_pct * 100).toFixed(2).padStart(6)}%  ` +
    `${String(c.total_trades).padStart(6)}  ` +
    `${(c.win_rate * 100).toFixed(0).padStart(4)}%  ` +
    `${c.top_fitness.toFixed(4).padStart(7)}  ` +
    `${c.bottom_fitness.toFixed(4).padStart(7)}`,
  );
}
console.log();
if (cohorts.length === 0) {
  console.log("No paper_agents found. Run `npm run arena:init` + a few `arena:evolve` cycles first.");
}
