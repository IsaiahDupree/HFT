/**
 * Diagnostic: for every alive agent in the open generation, run decide() once
 * against the current live snapshot context and report what it returned + a
 * hint at why a hold fired. Read-only — no DB writes.
 *
 * Run: `npx tsx scripts/arena-debug-decisions.ts`
 */
import "./_env.ts";
import { getCurrentGeneration, listAliveAgentsForGen, toLiveAgent } from "../src/lib/arena/db.ts";
import { decide } from "../src/lib/arena/sim.ts";
import { buildLiveTickContext } from "../src/lib/arena/context.ts";
import { loadRecentCandles, velocity, acceleration } from "../src/lib/arena/momentum.ts";

const gen = getCurrentGeneration();
if (!gen) { console.error("no open generation"); process.exit(1); }

const ctx = buildLiveTickContext();
const agents = listAliveAgentsForGen(gen.gen_number).map(toLiveAgent);
const cutoffUnix = Math.floor(new Date(ctx.now).getTime() / 1000);

console.log(`gen ${gen.gen_number}: ${agents.length} agents, ${ctx.snapshots.size} markets in context, now=${ctx.now}`);
console.log("--");

const byKind = new Map<string, { firedEntry: number; held: number; details: string[] }>();
for (const agent of agents) {
  const kind = agent.genome.kind;
  if (!byKind.has(kind)) byKind.set(kind, { firedEntry: 0, held: 0, details: [] });
  const bucket = byKind.get(kind)!;

  let extra = "";
  // For cb_momentum_burst: print v/a so we can see if thresholds are reachable.
  if (agent.genome.kind === "cb_momentum_burst") {
    const p = agent.genome.params;
    const lookbackMin = Math.max(p.vel_window_min * 2 + 5, 30);
    const candles = loadRecentCandles(p.product_id, lookbackMin, { cutoffUnix });
    const v = candles.length >= p.vel_window_min + 2 ? velocity(candles, p.vel_window_min) : NaN;
    const a = candles.length >= p.vel_window_min + 2 ? acceleration(candles, p.vel_window_min) : NaN;
    extra = `v=${(v * 100).toFixed(3)}% (>= ${(p.vel_entry_pct * 100).toFixed(3)}%) a=${(a * 100).toFixed(4)}% (>= ${(p.accel_min * 100).toFixed(4)}%) bias=${p.direction_bias}`;
  }
  if (agent.genome.kind === "cb_mean_reversion") {
    const p = agent.genome.params;
    const win = ctx.snapshots.get(p.product_id);
    if (win) {
      const cutoffMs = new Date(ctx.now).getTime() - p.lookback_min * 60_000;
      const inWindow = win.history.filter((s) => new Date(s.captured_at).getTime() >= cutoffMs);
      const mean = inWindow.length ? inWindow.reduce((a, b) => a + b.price, 0) / inWindow.length : 0;
      const sd = inWindow.length > 1 ? Math.sqrt(inWindow.reduce((a, b) => a + (b.price - mean) ** 2, 0) / (inWindow.length - 1)) : 0;
      const z = sd > 0 ? (win.latest.price - mean) / sd : NaN;
      extra = `z=${z.toFixed(2)} (entry<=-${p.z_entry}) n=${inWindow.length}/12+ window=${p.lookback_min}min`;
    } else extra = `no snapshot for ${p.product_id}`;
  }

  const signal = decide(agent, ctx, Math.random);
  if (signal.kind === "entry") {
    bucket.firedEntry += 1;
    bucket.details.push(`✓ ${agent.name}: ENTRY ${signal.side} on ${signal.market_id.slice(0, 16)}… size=$${signal.size_usd.toFixed(2)} — ${signal.rationale}${extra ? ` | ${extra}` : ""}`);
  } else {
    bucket.held += 1;
    if (bucket.details.length < 3) {
      bucket.details.push(`· ${agent.name}: hold${extra ? ` | ${extra}` : ""}`);
    }
  }
}

for (const [kind, b] of byKind) {
  console.log(`\n[${kind}] entries=${b.firedEntry} holds=${b.held}`);
  for (const d of b.details) console.log("  " + d);
}
