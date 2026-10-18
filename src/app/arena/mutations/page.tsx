import Link from "next/link";
import { compareMutationCohorts } from "@/lib/arena/mutation-stats";

export const dynamic = "force-dynamic";

export default async function MutationsPage() {
  const { cohorts, gens_considered, total_agents } = compareMutationCohorts({ lastN: 10 });
  const mode = (process.env.ARENA_MUTATION_MODE ?? "programmatic").toLowerCase();

  return (
    <div className="space-y-6">
      <div>
        <Link href="/arena" className="text-xs text-zinc-500 hover:text-zinc-300">← arena</Link>
        <h1 className="text-2xl font-semibold mt-1">Mutation comparison</h1>
        <p className="text-zinc-400 text-sm mt-1">
          Last {gens_considered.length} generations · {total_agents} agents · current `ARENA_MUTATION_MODE` ={" "}
          <code className={mode === "compare" ? "text-accent-green" : "text-zinc-300"}>{mode}</code>
        </p>
        {mode !== "compare" && (
          <p className="text-xs text-accent-amber mt-2">
            Set <code>ARENA_MUTATION_MODE=compare</code> in <code>.env.local</code> and run several
            <code> arena:evolve </code>cycles to get a head-to-head head-to-head sample (otherwise survivors all
            come from one mutation source).
          </p>
        )}
      </div>

      {cohorts.length === 0 ? (
        <p className="text-xs text-zinc-500">No paper_agents found. Run <code>npm run arena:init</code> first.</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Cohort (introduced_by)</th>
              <th className="text-right">N</th>
              <th className="text-right">Avg fitness</th>
              <th className="text-right">Median</th>
              <th className="text-right">Avg PnL%</th>
              <th className="text-right">Avg DD%</th>
              <th className="text-right">Trades</th>
              <th className="text-right">Win %</th>
              <th className="text-right">Top</th>
              <th className="text-right">Bottom</th>
            </tr>
          </thead>
          <tbody>
            {cohorts.map((c) => (
              <tr key={c.introduced_by}>
                <td className="text-zinc-100">{c.introduced_by}</td>
                <td className="text-right tabular-nums">{c.n_agents}</td>
                <td className={`text-right tabular-nums ${c.avg_fitness >= 0 ? "text-accent-green" : "text-accent-red"}`}>{c.avg_fitness.toFixed(4)}</td>
                <td className="text-right tabular-nums">{c.med_fitness.toFixed(4)}</td>
                <td className="text-right tabular-nums">{(c.avg_pnl_pct * 100).toFixed(2)}%</td>
                <td className="text-right tabular-nums text-zinc-400">{(c.avg_dd_pct * 100).toFixed(2)}%</td>
                <td className="text-right tabular-nums">{c.total_trades}</td>
                <td className="text-right tabular-nums">{(c.win_rate * 100).toFixed(0)}%</td>
                <td className="text-right tabular-nums text-accent-green">{c.top_fitness.toFixed(4)}</td>
                <td className="text-right tabular-nums text-accent-red">{c.bottom_fitness.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <section className="card text-xs text-zinc-400">
        <h2 className="card-title">How to read this</h2>
        <p>
          Fitness = <code>pnl_pct − 2 × max_dd_pct</code> (TradingBot Arena formula). Survivor-carryover and init rows
          serve as baselines: the carryover cohort tells you "how does the parent do without any mutation," and init
          tells you "what does a random kind look like." A meaningful win for the LLM cohort needs both a higher
          <code> avg_fitness</code> AND a larger sample (N) than the programmatic cohort over multiple sealed gens.
        </p>
      </section>
    </div>
  );
}
