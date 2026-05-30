/**
 * CLI wrapper around runEvolveOnce — see src/lib/arena/evolve.ts.
 */
import "./_env.ts";
import { runEvolveOnce } from "../src/lib/arena/evolve.ts";

(async () => {
  const result = await runEvolveOnce();
  if ("skipped" in result) {
    if (result.skipped === "no_open_generation") {
      console.error("arena:evolve — no open generation.");
      process.exit(1);
    }
    console.log(`arena:evolve gen=${result.sealed_gen} sealed (no alive agents)`);
    return;
  }
  console.log(
    `arena:evolve sealed gen${result.sealed_gen}; bred gen${result.next_gen} ` +
    `with ${result.n_children} agents (top fitness=${(result.top_score ?? 0).toFixed(4)})` +
    (result.championship_recorded ? "  🏆 championship eligible" : ""),
  );
})();
