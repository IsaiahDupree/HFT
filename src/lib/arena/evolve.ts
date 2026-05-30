/**
 * Generation evolution as an importable function so both `scripts/arena-evolve.ts`
 * (manual CLI) and `scripts/arena-tick.ts` (auto-trigger when tick threshold
 * crossed) call the same code path.
 *
 * Seals the current open generation, ranks alive agents, retires bottom
 * SURVIVAL_PCT + retires survivors (their lineage continues via carryover
 * rows in the next generation), starts the next generation, breeds one
 * mutated child per survivor + one carryover row per survivor, then evaluates
 * championship eligibility.
 */
import { db } from "@/lib/db/client";
import { insertEvolutionEvent } from "@/lib/db/queries";
import { partitionSurvivors, rankAgents, scoreAgent } from "./score";
import { buildLiveTickContext } from "./context";
import {
  demoteElite, getCurrentGeneration, getPaperAgent, insertPaperAgent, insertPaperTrade,
  listAliveAgentsAcrossGens, listAliveAgentsForGen, listAliveElites, listGenerations,
  markElite, persistAgentTick, recordChampionship,
  retireAgent, sealGeneration, setGenerationAgentCount, startGeneration, toLiveAgent,
} from "./db";
import { genomeNickname, parseGenome, type Genome } from "./genome";
import { mutate, mutateLlm, mutateProgrammatic } from "./mutate";
import { computeReplayFitness } from "./replay-fitness";
import { aggressivePresets } from "./seed-presets";
import { applySignal, markToMarket } from "./sim";
import { runAutoPromote } from "./auto-promote";
import { runMetaEvolution, shouldRunMetaEvolution } from "./meta-evolution";
import { runCircuitBreaker } from "@/lib/capsules/circuit-breaker";
import { applyClusterKillSwitches } from "@/lib/portfolio/cluster-killswitch-wrapper";
import { getBinaryMeta } from "./short-binaries";
import type { LiveAgent, PaperAgentRow, TickContext } from "./types";

/**
 * Force-close any open positions on `row` at current snapshot prices, then
 * persist. Realizes PnL into the agent so its final fitness reflects the
 * positions it actually held at seal time, rather than leaving them orphaned
 * on a retired row.
 *
 * Positions whose market is missing from the snapshot context are left open
 * (we can't price them) — `applySignal` returns `{}` in that case.
 *
 * Returns the number of positions that were realized (for logging).
 */
function realizeOpenPositions(row: PaperAgentRow, ctx: TickContext, generation: number): { closed: number; realized_usd: number } {
  const positionsJson = row.position_basket_json;
  if (!positionsJson || positionsJson === "[]") return { closed: 0, realized_usd: 0 };
  const agent: LiveAgent = toLiveAgent(row);
  if (agent.positions.length === 0) return { closed: 0, realized_usd: 0 };
  let closed = 0;
  let realized = 0;
  // Snapshot the list of market_ids first — applySignal mutates agent.positions.
  const marketIds = agent.positions.map((p) => p.market_id);
  for (const mid of marketIds) {
    const pos = agent.positions.find((p) => p.market_id === mid);
    if (!pos) continue;

    // 2026-05-26 bug-fix: Binary positions must NOT be force-closed at the
    // snapshot mid. The mid (usually still equal to the entry price) hides
    // the true outcome — if the binary already settled YES/NO, we'd be
    // robbing the agent of the resolution PnL. Three sub-cases:
    //
    //   (a) Binary is settled        → settle at the actual 0/1 outcome
    //                                  (mirrors binary-resolver math)
    //   (b) Binary expired, not yet
    //       settled                  → skip — let the resolver handle it on
    //                                  a future tick. Agent gets retired
    //                                  but resolver still pays out (it
    //                                  iterates listAliveAgentsAcrossGens
    //                                  which excludes retired agents — so
    //                                  this case needs follow-up to credit
    //                                  retired agents too).
    //   (c) Binary not yet expired   → leave the position open for now (sim
    //                                  fitness will reflect mark-to-market;
    //                                  resolver will settle when expiry
    //                                  arrives). Same risk as (b).
    const binary = getBinaryMeta(mid);
    if (binary) {
      if (binary.settled && binary.outcome_yes != null) {
        const resolvedPrice = binary.outcome_yes === 1 ? 1.0 : 0.0;
        // SELL is BUY-NO-equivalent (bounded loss) — matches sim.ts applySignal
        // and binary-resolver. Pre-2026-05-26: unbounded short math.
        const shareRet = pos.side === "BUY"
          ? (resolvedPrice - pos.entry_price) / pos.entry_price
          : (pos.entry_price - resolvedPrice) / (1 - pos.entry_price);
        const realized_one = pos.size_usd * shareRet;
        agent.cash_usd_current += pos.size_usd + realized_one;
        agent.realized_pnl_usd += realized_one;
        agent.trades_count += 1;
        if (realized_one > 0) agent.wins_count += 1;
        const idx = agent.positions.findIndex((p) => p.market_id === mid);
        if (idx !== -1) agent.positions.splice(idx, 1);
        insertPaperTrade({
          paper_agent_id: agent.id, venue: pos.venue, market_id: pos.market_id,
          side: pos.side === "BUY" ? "SELL" : "BUY", intent: "exit",
          price: resolvedPrice, size_usd: pos.size_usd, fee_usd: 0,
          realized_pnl_usd: realized_one, linked_entry_id: pos.entry_trade_id ?? null,
          signal_rationale: `force-close-at-binary-outcome ${binary.asset} ${binary.outcome_yes === 1 ? "UP" : "DOWN"}`,
          tick_at: ctx.now, generation,
        });
        closed += 1;
        realized += realized_one;
      }
      // (b) and (c): skip — leave open. Resolver picks them up post-expiry.
      // The agent gets retired with these positions still in the basket;
      // operator can audit via the trade log.
      continue;
    }

    // Non-binary position: existing behavior — close at snapshot mid.
    if (!ctx.snapshots.has(mid)) continue;
    const res = applySignal(agent, { kind: "exit", venue: pos.venue, market_id: mid, rationale: "force-close on retire" }, ctx, generation);
    if (res.trade) {
      insertPaperTrade(res.trade);
      closed += 1;
      realized += res.trade.realized_pnl_usd ?? 0;
    }
  }
  markToMarket(agent, ctx);
  persistAgentTick(agent);
  return { closed, realized_usd: realized };
}

/**
 * Reject any child genome that doesn't fire at least once when replayed
 * against the historical candle window. Up to `maxAttempts` mutation retries
 * before falling back to a permissive random genome of the same kind.
 * Read-only — runs entirely in memory, never touches paper_trades.
 *
 * This is the cold-start cure: without it, populations can freeze when every
 * agent has thresholds too strict to fire, leaving evolution no fitness signal.
 */
async function genFiringChild(
  produce: () => Promise<Genome> | Genome,
  _fallbackKind: Genome["kind"],
  opts: { polyConditionIdPool?: string[]; maxAttempts?: number } = {},
): Promise<{ genome: Genome; attempts: number; trades: number }> {
  const maxAttempts = opts.maxAttempts ?? 6;
  let lastAttempt: Genome | undefined;
  for (let i = 0; i < maxAttempts; i++) {
    const g = await produce();
    lastAttempt = g;
    try {
      const r = computeReplayFitness(g, { tickIntervalMin: 5 });
      if (r.trades_count >= 1) return { genome: g, attempts: i + 1, trades: r.trades_count };
    } catch {
      // Replay can fail when historical data is too thin for the strategy
      // (e.g. poly_fade_spike with 45h lookback against 4h snapshot history).
      // Treat as "didn't fire" and retry.
    }
  }
  // All attempts exhausted. Accept the last mutation rather than a permissive
  // random genome — poly_fade_spike / poly_breakout / cross_venue_arb can't be
  // replay-validated until we have multi-day snapshot history, so the gate
  // would otherwise destroy the evolutionary signal for those strategies.
  // Live ticks will sort firing from non-firing on the next sealed gen.
  return { genome: lastAttempt!, attempts: maxAttempts, trades: 0 };
}

export type EvolveResult = {
  sealed_gen: number;
  next_gen: number;
  n_survivors: number;
  n_culled: number;
  n_children: number;
  top_paper_agent_id: number | null;
  top_score: number | null;
  championship_recorded: boolean;
  /** Null when ALLOW_AUTO_PROMOTE != 1 or no qualifying elites; otherwise
   *  summary of the auto-promote pass that ran after the seal. */
  auto_promote: {
    qualified_agents: number;
    promoted_count: number;
    paused_count: number;
    per_capsule_usd: number;
  } | null;
  /** Capsule circuit-breaker summary from this seal — see circuit-breaker.ts. */
  circuit_breaker: {
    inspected: number;
    paused: number;
  };
  /** Cluster kill switches summary — see portfolio/cluster-killswitch.ts. */
  cluster_killswitch: {
    inspected: number;
    paused: number;
    risk_off: number;
    global_kill_switch: boolean;
  };
  /** Meta-evolution: when this seal triggers a meta-evolve pass
   *  (every ARENA_META_EVOLVE_EVERY gens), summarize how many variants
   *  Claude proposed and how many passed zod validation. */
  meta_evolve: { proposed: number; accepted: number } | null;
} | { skipped: "no_open_generation" } | { skipped: "no_alive_agents"; sealed_gen: number };

export async function runEvolveOnce(opts: { survivalPct?: number; championshipGens?: number; eliteCount?: number; eliteMaxDdPct?: number } = {}): Promise<EvolveResult> {
  const survivalPct = opts.survivalPct ?? Number(process.env.ARENA_SURVIVAL_PCT ?? "0.5");
  const championshipGens = opts.championshipGens ?? Number(process.env.ARENA_CHAMPION_GENS ?? "3");
  // Elite preservation params. Top-N alive agents across every generation
  // are protected from retirement; elites whose drawdown exceeds the cap
  // get demoted (alive, eligible for normal cull next time).
  const eliteCount = opts.eliteCount ?? Number(process.env.ARENA_ELITE_COUNT ?? "5");
  const eliteMaxDdPct = opts.eliteMaxDdPct ?? Number(process.env.ARENA_ELITE_MAX_DD_PCT ?? "0.20");

  const gen = getCurrentGeneration();
  if (!gen) return { skipped: "no_open_generation" };

  const aliveRows = listAliveAgentsForGen(gen.gen_number);
  const ranked = rankAgents(aliveRows);
  if (ranked.length === 0) {
    sealGeneration(gen.id, { n_alive: 0, top_agent_id: null, top_score: null, n_promoted_children: 0 });
    return { skipped: "no_alive_agents", sealed_gen: gen.gen_number };
  }

  // -- ELITE PRESERVATION --
  // 1. Demote existing elites that exceeded the drawdown cap. They stay alive
  //    but lose their cull-immunity for the next round.
  // 2. Promote the top-N alive agents across every gen by fitness. Eliteship
  //    is recomputed each seal — yesterday's elite can be replaced.
  const currentElites = listAliveElites();
  const demoted: number[] = [];
  for (const el of currentElites) {
    const s = scoreAgent(el);
    if (s.max_dd_pct > eliteMaxDdPct) {
      demoteElite(el.id);
      demoted.push(el.id);
    }
  }
  const allAlive = listAliveAgentsAcrossGens();
  const rankedAll = rankAgents(allAlive);
  // Require trades_count > 0 — an agent that opens positions but never closes
  // them (e.g. long-duration fade-spike whose time_stop_h spans many gen
  // seals) racks up entries but produces no resolved PnL. Such agents would
  // dominate the leaderboard via the activity bonus while contributing
  // nothing real. Closed round-trips = proof the strategy actually works.
  const newElites = rankedAll
    .filter((r) => r.agent.trades_count > 0)
    .slice(0, eliteCount);
  const promoted: number[] = [];
  const demotedSet = new Set(demoted);
  for (const e of newElites) {
    // Don't re-promote an agent we just demoted in this same seal — it would
    // defeat the drawdown protection. Give it at least one cycle off.
    if (demotedSet.has(e.agent.id)) continue;
    if (!e.agent.is_elite) {
      markElite(e.agent.id);
      promoted.push(e.agent.id);
    }
  }
  // Anyone who WAS elite but is no longer in the new top-N (and wasn't already
  // demoted above) — demote without retiring.
  const newEliteIds = new Set(newElites.map((e) => e.agent.id));
  for (const el of currentElites) {
    if (demotedSet.has(el.id)) continue;
    if (!newEliteIds.has(el.id)) {
      demoteElite(el.id);
      demoted.push(el.id);
    }
  }
  // Final set of elites for this seal — used below to exclude from cull.
  const eliteIds = new Set(newElites.filter((e) => !demotedSet.has(e.agent.id)).map((e) => e.agent.id));

  // Force zero-activity agents into the cull bucket regardless of where they
  // rank. A lineage that never acted produces no fitness signal and just
  // dilutes the gene pool with cautious genomes that never trade. See PRD
  // `arena-agent-decision-framework.md` §6.1.R1.3.
  //
  // Elites are removed from ALL partition pools — they aren't culled, aren't
  // counted as survivors-needing-mutation, and they don't retire. They just
  // continue trading across the gen boundary.
  const activeRanked = ranked.filter((r) => r.agent.entries_count > 0 && !eliteIds.has(r.agent.id));
  const inactiveRanked = ranked.filter((r) => r.agent.entries_count === 0 && !eliteIds.has(r.agent.id));
  const { survivors, cull } = partitionSurvivors(activeRanked, survivalPct);
  const inactiveCull = inactiveRanked;  // every zero-entry agent is culled

  // Force-close any open positions on agents being retired so their final
  // fitness reflects MtM-at-seal rather than leaving positions orphaned on a
  // dead row. Refresh the ranking afterward so sealGeneration's `top_score`
  // sees the realized state. Elites are EXCLUDED — their open positions must
  // survive the gen boundary because they keep trading next gen.
  const ctx = buildLiveTickContext();
  let totalClosed = 0;
  for (const r of [...cull, ...survivors, ...inactiveCull]) {
    const result = realizeOpenPositions(r.agent, ctx, gen.gen_number);
    totalClosed += result.closed;
  }
  const refreshedRows = listAliveAgentsForGen(gen.gen_number);
  const refreshedRanked = rankAgents(refreshedRows);
  const topAfterClose = refreshedRanked[0] ?? ranked[0];

  for (const c of cull) retireAgent(c.agent.id, "culled by evolve (bottom pct)");
  for (const c of inactiveCull) retireAgent(c.agent.id, "no-activity (0 entries)");
  for (const s of survivors) retireAgent(s.agent.id, "carried over (survivor)");

  sealGeneration(gen.id, {
    n_alive: aliveRows.length,
    top_agent_id: topAfterClose.agent.id,
    top_score: topAfterClose.score.fitness,
    n_promoted_children: survivors.length,
  });

  const nextGen = gen.gen_number + 1;
  const nextGenId = startGeneration(nextGen, undefined, `bred from gen${gen.gen_number} survivors`);

  const polyConditionIdPool = (db().prepare("SELECT poly_condition_id FROM cross_venue_arbs WHERE active = 1").all() as { poly_condition_id: string }[])
    .map((r) => r.poly_condition_id);

  const newIds: number[] = [];

  // In 'compare' mode, spawn one programmatic + one LLM child per survivor so
  // we can group fitness by introduced_by across future generations.
  const mode = (process.env.ARENA_MUTATION_MODE ?? "programmatic").toLowerCase();
  const compare = mode === "compare";
  // Sim starting cash per agent — defaults to $100 so sim caps are small +
  // safe. Override via ARENA_STARTING_CASH or per-call opts.
  const startingCash = Number(process.env.ARENA_STARTING_CASH ?? "100");

  for (const s of survivors) {
    const parentGenome = parseGenome(s.agent.genome_json);
    const perf = {
      fitness: s.score.fitness, pnl_pct: s.score.pnl_pct,
      max_dd_pct: s.score.max_dd_pct, trades_count: s.score.trades_count,
    };
    if (compare) {
      const prog = await genFiringChild(
        () => mutateProgrammatic(parentGenome, Math.random, { polyConditionIdPool }),
        parentGenome.kind, { polyConditionIdPool },
      );
      const llm = await genFiringChild(
        () => mutateLlm(parentGenome, perf, { polyConditionIdPool }),
        parentGenome.kind, { polyConditionIdPool },
      );
      newIds.push(insertPaperAgent({
        name: `g${nextGen}-cp${newIds.length}-${genomeNickname(prog.genome)}`,
        generation: nextGen, parent_paper_agent_id: s.agent.id,
        genome: prog.genome, introduced_by: "mutate-programmatic",
        cash_usd_start: startingCash,
      }));
      newIds.push(insertPaperAgent({
        name: `g${nextGen}-cl${newIds.length}-${genomeNickname(llm.genome)}`,
        generation: nextGen, parent_paper_agent_id: s.agent.id,
        genome: llm.genome, introduced_by: "mutate-llm",
        cash_usd_start: startingCash,
      }));
    } else {
      const child = await genFiringChild(
        () => mutate(parentGenome, perf, { polyConditionIdPool }),
        parentGenome.kind, { polyConditionIdPool },
      );
      newIds.push(insertPaperAgent({
        name: `g${nextGen}-c${newIds.length}-${genomeNickname(child.genome)}`,
        generation: nextGen, parent_paper_agent_id: s.agent.id,
        genome: child.genome,
        introduced_by: mode === "llm" ? "mutate-llm" : "mutate-programmatic",
        cash_usd_start: startingCash,
      }));
    }
  }
  for (const s of survivors) {
    const parentGenome = parseGenome(s.agent.genome_json);
    // If the carryover genome wouldn't fire in replay, re-mutate it until it
    // does — otherwise the lineage is functionally dead and we waste a slot.
    let carryGenome: Genome = parentGenome;
    let carryNote = "survivor-carryover";
    if (s.agent.trades_count === 0) {
      const perf = { fitness: 0, pnl_pct: 0, max_dd_pct: 0, trades_count: 0 };
      const replacement = await genFiringChild(
        () => mutate(parentGenome, perf, { polyConditionIdPool }),
        parentGenome.kind, { polyConditionIdPool },
      );
      carryGenome = replacement.genome;
      carryNote = "survivor-carryover-refreshed";
    }
    const id = insertPaperAgent({
      name: `g${nextGen}-s${newIds.length}-${genomeNickname(carryGenome)}`,
      generation: nextGen,
      parent_paper_agent_id: s.agent.id,
      genome: carryGenome,
      introduced_by: carryNote,
      cash_usd_start: startingCash,
    });
    newIds.push(id);
  }

  // Inject aggressive presets — guaranteed-firing reference points so the
  // gene pool always has known-active agents to compete against. See PRD
  // §6.1.R1.4. Tagged `preset-aggressive` so mutation-stats can group fitness
  // by introduced_by across future generations.
  const presets = aggressivePresets({ polyConditionIdPool });
  for (const p of presets) {
    const id = insertPaperAgent({
      name: `g${nextGen}-p${newIds.length}-${p.nick}`,
      generation: nextGen,
      parent_paper_agent_id: null,
      genome: p.genome,
      introduced_by: "preset-aggressive",
      cash_usd_start: startingCash,
    });
    newIds.push(id);
  }

  setGenerationAgentCount(nextGenId, newIds.length);

  const eliteSummary = eliteIds.size > 0
    ? ` · ${eliteIds.size} elite${eliteIds.size === 1 ? "" : "s"} preserved (top-${eliteCount})`
    : "";
  insertEvolutionEvent({
    event_type: "arena-evolve",
    summary: `gen${gen.gen_number} sealed — top fitness ${topAfterClose.score.fitness.toFixed(4)} by ${topAfterClose.agent.name}; bred ${newIds.length} into gen${nextGen}` + (totalClosed > 0 ? ` (force-closed ${totalClosed} open positions)` : "") + (inactiveCull.length > 0 ? ` · ${inactiveCull.length} no-activity culled` : "") + eliteSummary,
    payload_json: JSON.stringify({
      from_gen: gen.gen_number, to_gen: nextGen,
      top_agent_id: topAfterClose.agent.id, top_score: topAfterClose.score.fitness,
      n_survivors: survivors.length, n_culled: cull.length, n_inactive_culled: inactiveCull.length,
      n_children: newIds.length, force_closed_positions: totalClosed,
      elites_promoted: promoted, elites_demoted: demoted, elite_ids: [...eliteIds],
    }),
  });

  // Championship check — top-1 lineage across last N sealed gens.
  let championshipRecorded = false;
  const recent = listGenerations(championshipGens).filter((g) => g.sealed_at !== null);
  if (recent.length >= championshipGens) {
    const tops = recent.map((g) => g.top_paper_agent_id).filter((x): x is number => x != null);
    if (tops.length === championshipGens) {
      const lineageRoot = (id: number): number => {
        let cur = getPaperAgent(id);
        while (cur && cur.parent_paper_agent_id != null) {
          const next = getPaperAgent(cur.parent_paper_agent_id);
          if (!next) break;
          cur = next;
        }
        return cur?.id ?? id;
      };
      const roots = tops.map(lineageRoot);
      if (roots.every((r) => r === roots[0])) {
        recordChampionship(
          tops[0],
          championshipGens,
          `lineage rooted at agent ${roots[0]} won top-1 in gens ${recent.map((g) => g.gen_number).reverse().join(", ")}`,
        );
        insertEvolutionEvent({
          event_type: "arena-championship",
          summary: `lineage ${roots[0]} eligible for capsule activation`,
          payload_json: JSON.stringify({ recent_gens: recent.map((g) => g.gen_number), tops, roots }),
        });
        championshipRecorded = true;
      }
    }
  }

  // Circuit-breaker: auto-pause capsules with runaway broker errors. Runs
  // BEFORE auto-promote so a freshly-tripped capsule isn't immediately
  // re-promoted in the same seal. Bug-fix #14 (2026-05-26).
  const breaker = runCircuitBreaker();

  // Cluster kill switches (Phase 8) — pause every capsule in a cluster
  // whose aggregate daily loss exceeds the family / asset-class / global
  // thresholds. Runs AFTER circuit-breaker (per-capsule layer) and BEFORE
  // auto-promote so freshly-paused capsules don't get re-promoted in the
  // same seal. Pure module + DB wrapper; thresholds in .env.local.
  const clusterTrips = applyClusterKillSwitches();

  // Auto-promote top-N elites to live capsules (no-op unless
  // ALLOW_AUTO_PROMOTE=1 + ARENA_LIVE_CAPITAL_TOTAL_USD set). Logs to
  // evolution_log internally. Runs AFTER cluster killswitch so a freshly-
  // paused capsule isn't re-promoted in the same seal.
  const autoPromote = runAutoPromote();

  // Meta-evolution: every ARENA_META_EVOLVE_EVERY gens (default 5), ask
  // Claude to synthesize new genome variants by reading the existing
  // population's genomes + perf. Seeded as `introduced_by=meta-llm` so we
  // can later compare lineages. Non-blocking — any failure (no auth, LLM
  // unavailable, JSON parse error) just logs and continues with the
  // already-seeded preset + mutation genomes. (Feature added 2026-05-27.)
  let metaEvolveResult: { proposed: number; accepted: number } | null = null;
  if (shouldRunMetaEvolution(gen.gen_number)) {
    try {
      const meta = await runMetaEvolution({ nextGen, startingCash });
      if (meta.attempted) {
        metaEvolveResult = { proposed: meta.proposed_count, accepted: meta.accepted_count };
        for (const id of meta.seeded_agent_ids) newIds.push(id);
      }
    } catch (e) {
      console.warn(`[meta-evolve] failed: ${(e as Error).message?.slice(0, 100)}`);
    }
  }

  return {
    sealed_gen: gen.gen_number,
    next_gen: nextGen,
    n_survivors: survivors.length,
    n_culled: cull.length,
    n_children: newIds.length,
    top_paper_agent_id: topAfterClose.agent.id,
    top_score: topAfterClose.score.fitness,
    championship_recorded: championshipRecorded,
    auto_promote: autoPromote.skipped ? null : {
      qualified_agents: autoPromote.qualified_agents,
      promoted_count: autoPromote.promoted.length,
      paused_count: autoPromote.paused.length,
      per_capsule_usd: autoPromote.per_capsule_usd,
    },
    circuit_breaker: {
      inspected: breaker.inspected,
      paused: breaker.paused.length,
    },
    cluster_killswitch: {
      inspected: clusterTrips.inspected,
      paused: clusterTrips.paused.length,
      risk_off: clusterTrips.risk_off.length,
      global_kill_switch: clusterTrips.global_kill_switch,
    },
    meta_evolve: metaEvolveResult,
  };
}
