/**
 * One tick of the arena. For every alive agent in the current (unsealed)
 * generation, build the TickContext, ask the agent's decide() for a signal,
 * apply, mark-to-market, persist. Increment the generation's tick counter
 * and auto-call evolve when ARENA_EVOLVE_EVERY (default 50) is crossed.
 *
 * Designed to be called once per cron tick (e.g., every 5 min). Crashes
 * leave partial work persisted (per-agent transactions).
 */
import "./_env.ts";
import {
  listAliveAgentsForGen, listAliveElites, listAliveAgentsWithLiveCapsule,
  getCurrentGeneration, persistAgentTick,
  persistTradeWithLink, toLiveAgent, incrementGenerationTickCount,
} from "../src/lib/arena/db.ts";
import { applySignal, decide, markToMarket } from "../src/lib/arena/sim.ts";
import { buildLiveTickContext } from "../src/lib/arena/context.ts";
import { runEvolveOnce } from "../src/lib/arena/evolve.ts";
import { findLiveCapsuleForPaperAgent, refreshCapsuleRealtime, routeArenaSignal, supportsLiveRouting } from "../src/lib/arena/live-capsule.ts";
import { applyRiskRails } from "../src/lib/arena/risk-wrapper.ts";
import { warmOracleCacheForTick } from "../src/lib/arena/oracle-warmer.ts";
import { resolveExpiredBinaries } from "../src/lib/arena/binary-resolver.ts";

const EVOLVE_EVERY = Number(process.env.ARENA_EVOLVE_EVERY ?? "50");

(async () => {
  const gen = getCurrentGeneration();
  if (!gen) {
    console.error("arena:tick — no open generation. Run `npm run arena:init` first.");
    process.exit(1);
  }

  const ctx = buildLiveTickContext();
  if (ctx.snapshots.size === 0) {
    console.error("arena:tick — no recent snapshots. Run `npm run worker:snapshot` first.");
    process.exit(1);
  }

  // Settle expired short binaries BEFORE the decide loop. The directional
  // binary strategy sets `time_stop_at = expiry`; if we ran the resolver
  // after, decide() would fire a generic time-stop exit at the last quoted
  // midpoint (often 0.485 etc.) instead of the actual 0.0/1.0 outcome,
  // distorting realized PnL. Running first means the position is gone by
  // the time decide() walks the agent's open positions.
  const settle = resolveExpiredBinaries();
  const settleStr = settle.candidates > 0
    ? `  settled=${settle.settled}/${settle.candidates} (closed ${settle.positions_closed} positions)`
    : "";

  // Tick the current generation + any elite preserved from older gens +
  // any agent bound to a live capsule (so real-money capsules never get
  // stranded when their owning agent drops out of the gen + loses elite).
  // Dedupe by id since an agent can be in multiple of these sets at once.
  const currentRows = listAliveAgentsForGen(gen.gen_number);
  const eliteRows = listAliveElites();
  const capsuleRows = listAliveAgentsWithLiveCapsule();
  const seen = new Set<number>();
  const allRows = [...currentRows, ...eliteRows, ...capsuleRows].filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
  const agents = allRows.map(toLiveAgent);
  const rng = Math.random;
  const stats = { decided: 0, entries: 0, exits: 0, holds: 0, live_fills: 0, live_rejects: 0, ev_kelly_engaged: 0, ev_kelly_blocked: 0, ev_kelly_resized: 0 };

  // Warm the LLM oracle cache once before the per-agent decide loop. Inert
  // unless ARENA_LLM_ORACLE_ENABLED=1 + at least one llm_probability_oracle
  // agent is alive. Single call per tick keeps cost bounded.
  const warmResult = await warmOracleCacheForTick(agents, ctx);
  if (warmResult.attempted) {
    if (warmResult.result) {
      console.log(`arena:tick → oracle warmed ${warmResult.market_id?.slice(0, 12)}… p=${warmResult.result.probability.toFixed(2)} (${warmResult.result.confidence})`);
    } else {
      console.log(`arena:tick → oracle warm skipped: ${warmResult.reason}`);
    }
  }

  for (const agent of agents) {
    try {
      let signal = decide(agent, ctx, rng);
      // EV+Kelly risk wrapper: engages when the genome attached a pTrueEstimate
      // to the signal (e.g. llm_oracle, wallet_copy). Pass-through otherwise.
      if (signal.kind === "entry") {
        const rail = applyRiskRails(signal, ctx, agent);
        if (!rail.kept) {
          signal = { kind: "hold" };
          stats.ev_kelly_blocked += 1;
        } else if (rail.engaged) {
          signal = rail.signal;
          stats.ev_kelly_engaged += 1;
          if (rail.sizeAdjusted) stats.ev_kelly_resized += 1;
        }
      }
      if (signal.kind === "hold") stats.holds += 1;
      if (signal.kind !== "hold") {
        // Route through ExecutionRouter when an agent has a live capsule AND
        // its venue supports live routing (Coinbase only in v1). On router
        // rejection, skip arena bookkeeping so we don't track phantom positions.
        const capsule = findLiveCapsuleForPaperAgent(agent.id);
        const liveRoutable = capsule && supportsLiveRouting(signal);
        let proceedToSim = true;
        let liveRouteResult: { liveTokenId?: string; liveSizeUsd?: number; brokerOrderId?: string; clientOrderId?: string } | null = null;
        if (capsule && liveRoutable) {
          const win = ctx.snapshots.get(signal.market_id);
          const refPrice = win?.latest.price ?? 0;
          // For exits, look up the open position so the router can compute
          // base_size from the held qty.
          const position = signal.kind === "exit"
            ? agent.positions.find((p) => p.market_id === signal.market_id)
            : undefined;
          // Pass the already-built tick window so the decision pipeline's regime features
          // come from the SAME window (no per-order rebuild; train/serve parity).
          const route = await routeArenaSignal(signal, capsule, agent.id, refPrice, position, win);
          if (!route.ok) { proceedToSim = false; stats.live_rejects += 1; }
          else if (route.status === "filled") {
            stats.live_fills += 1;
            liveRouteResult = {
              liveTokenId: route.liveTokenId,
              liveSizeUsd: route.liveSizeUsd,
              brokerOrderId: route.brokerOrderId,
              clientOrderId: route.clientOrderId,
            };
          }
        }
        if (proceedToSim) {
          const res = applySignal(agent, signal, ctx, gen.gen_number);
          if (res.trade) {
            // persistTradeWithLink stamps the opened position's entry_trade_id so
            // the eventual EXIT links back (linked_entry_id) — round-trip PnL
            // attribution + shadow-gate calibration.
            persistTradeWithLink(res);
            if (res.trade.intent === "entry") stats.entries += 1;
            if (res.trade.intent === "exit")  stats.exits   += 1;
          }
          // Attach live-routing audit fields to the just-created position so
          // the resolver/exit paths can settle against the actual filled
          // token (= NO token after a SELL→BUY-NO swap on a poly directional).
          if (liveRouteResult && signal.kind === "entry") {
            const pos = agent.positions.find((p) => p.market_id === signal.market_id);
            if (pos) {
              pos.live_token_id = liveRouteResult.liveTokenId;
              pos.live_paid_usd = liveRouteResult.liveSizeUsd;
              pos.live_broker_order_id = liveRouteResult.brokerOrderId;
              pos.live_client_order_id = liveRouteResult.clientOrderId;
              // live_filled_shares stays undefined until the reconciler reads
              // the actual fill from CLOB and writes the exact qty.
            }
          }
        }
        if (capsule) refreshCapsuleRealtime(capsule.id, agent.id);
      }
      markToMarket(agent, ctx);
      persistAgentTick(agent);
      stats.decided += 1;
    } catch (err) {
      console.error(`[arena:tick] agent ${agent.name} crashed:`, (err as Error).message);
    }
  }

  const tickCount = incrementGenerationTickCount(gen.id);
  const railStr = stats.ev_kelly_engaged > 0 || stats.ev_kelly_blocked > 0
    ? ` rails=engaged${stats.ev_kelly_engaged}/blocked${stats.ev_kelly_blocked}/resized${stats.ev_kelly_resized}`
    : "";
  const eliteSuffix = eliteRows.length > 0 ? ` elites=${eliteRows.length}` : "";
  const capsuleSuffix = capsuleRows.length > 0 ? ` capsules=${capsuleRows.length}` : "";
  console.log(`arena:tick gen=${gen.gen_number} agents=${agents.length}${eliteSuffix}${capsuleSuffix} → entries=${stats.entries} exits=${stats.exits} holds=${stats.holds} live=${stats.live_fills}/${stats.live_rejects + stats.live_fills}${railStr}${settleStr}  tick=${tickCount}/${EVOLVE_EVERY}`);

  // Auto-evolve trigger
  if (EVOLVE_EVERY > 0 && tickCount >= EVOLVE_EVERY) {
    console.log(`arena:tick → auto-evolve triggered (tick_count=${tickCount} >= ARENA_EVOLVE_EVERY=${EVOLVE_EVERY})`);
    const result = await runEvolveOnce();
    if ("skipped" in result) {
      console.log(`auto-evolve skipped: ${result.skipped}`);
    } else {
      console.log(
        `auto-evolve sealed gen${result.sealed_gen}; bred gen${result.next_gen} ` +
        `with ${result.n_children} agents (top fitness=${(result.top_score ?? 0).toFixed(4)})` +
        (result.championship_recorded ? "  🏆 championship eligible" : ""),
      );
    }
  }
})();
