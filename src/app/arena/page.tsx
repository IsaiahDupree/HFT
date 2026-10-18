import Link from "next/link";
import { equityCurvesForAgents, listAliveAgentsAcrossGens, listAliveElites, listGenerations, toLiveAgent } from "@/lib/arena/db";
import { rankAgents, liveEquity } from "@/lib/arena/score";
import { listEligibleChampionships } from "@/lib/arena/championship";
import { parseGenome, genomeNickname } from "@/lib/arena/genome";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Sparkline } from "@/components/Sparkline";
import { db } from "@/lib/db/client";
import { buildLiveTickContext } from "@/lib/arena/context";
import { diagnoseAgents, type AgentDiagnostic } from "@/lib/arena/diagnostic";
import { wsHealth } from "@/lib/arena/realtime-ticks";
import { LivePortfolioCard } from "@/components/LivePortfolioCard";

export const dynamic = "force-dynamic";

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}
function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export default async function ArenaPage() {
  const alive = listAliveAgentsAcrossGens();
  const ranked = rankAgents(alive);
  const gens = listGenerations(10);
  const eligible = listEligibleChampionships();
  const currentGen = gens.find((g) => g.sealed_at == null);
  // Elite preservation — agents flagged is_elite=1 are protected from cull
  // and tick across gen boundaries. Sorted by descending fitness so the
  // explainer card lists best first.
  const eliteRows = listAliveElites();
  const rankedElites = rankAgents(eliteRows);
  const eliteCount = Number(process.env.ARENA_ELITE_COUNT ?? "5");
  const eliteMaxDdPct = Number(process.env.ARENA_ELITE_MAX_DD_PCT ?? "0.20");

  // Live-capital map: paper_agent_id → { capsule_id, capital_usd, status, mode }
  // Surfaces which agents actually have real money behind their signals so the
  // operator can spot the live-trading set at a glance. `mode` reflects the
  // global ALLOW_TRADE gate — a `live`-status capsule with ALLOW_TRADE unset
  // still routes through the live router but execute.ts returns DRY_RUN.
  const liveCapsules = db().prepare(
    `SELECT id, name, paper_agent_id, status, capital_allocated_usd, current_pnl_usd, daily_pnl_usd, trades_today,
            strategy_family, asset_class, regime_dependency, time_horizon, directional_bias
       FROM capsules
      WHERE status IN ('live', 'paper') AND paper_agent_id IS NOT NULL`,
  ).all() as Array<{
    id: string; name: string; paper_agent_id: number; status: string;
    capital_allocated_usd: number; current_pnl_usd: number; daily_pnl_usd: number; trades_today: number;
    strategy_family: string | null; asset_class: string | null; regime_dependency: string | null;
    time_horizon: string | null; directional_bias: string | null;
  }>;
  const capsuleByAgent = new Map<number, typeof liveCapsules[number]>();
  for (const c of liveCapsules) capsuleByAgent.set(c.paper_agent_id, c);
  const allowTradeLive = process.env.ALLOW_TRADE === "1";

  // Portfolio-diversity diagnostic — counts capsules by strategy_family +
  // regime_dependency so the operator instantly sees "are these capsules
  // actually different strategies, or one strategy in N costumes?"
  // (Surfaces the concrete failure mode the PRD targets.)
  const diversityCounts = new Map<string, number>();
  for (const c of liveCapsules) {
    const fam = c.strategy_family ?? "unknown";
    const reg = c.regime_dependency ?? "any";
    const key = `${fam}/${reg}`;
    diversityCounts.set(key, (diversityCounts.get(key) ?? 0) + 1);
  }
  const diversitySummary = Array.from(diversityCounts.entries()).sort((a, b) => b[1] - a[1]);
  const totalLiveCapsules = liveCapsules.length;
  const distinctFamilies = new Set(liveCapsules.map((c) => c.strategy_family ?? "unknown")).size;

  // All-time top agents (any gen, dead or alive) by net PnL — shown above the
  // current-gen leaderboard so freshly-bred 0-trade agents don't drown out the
  // actual winners. We include agents whose only activity is entries (no exits
  // yet) so open positions surface here too — `trades_count` only bumps on
  // exit, so an EXISTS check against paper_trades is the broader gate.
  // net_pnl includes locked principal in open positions — counting only
  // cash+unrealized would treat every open entry as an immediate loss equal
  // to the position size. Bug-fix 2026-05-25.
  const allTimeTop = db().prepare(
    `SELECT pa.id, pa.name, pa.generation, pa.alive, pa.is_elite,
            pa.genome_json, pa.introduced_by,
            pa.cash_usd_start, pa.cash_usd_current,
            pa.realized_pnl_usd, pa.unrealized_pnl_usd,
            pa.trades_count, pa.wins_count,
            json_extract(pa.genome_json, '$.kind') AS kind,
            IFNULL((SELECT SUM(json_extract(value, '$.size_usd'))
                      FROM json_each(pa.position_basket_json)), 0) AS open_principal,
            (pa.cash_usd_current + pa.unrealized_pnl_usd
              + IFNULL((SELECT SUM(json_extract(value, '$.size_usd'))
                          FROM json_each(pa.position_basket_json)), 0)
              - pa.cash_usd_start) AS net_pnl,
            (SELECT COUNT(*) FROM paper_trades pt WHERE pt.paper_agent_id = pa.id AND pt.intent = 'entry') AS entries_count
       FROM paper_agents pa
      WHERE EXISTS (SELECT 1 FROM paper_trades pt WHERE pt.paper_agent_id = pa.id)
      ORDER BY net_pnl DESC, realized_pnl_usd DESC, entries_count DESC
      LIMIT 10`,
  ).all() as Array<{ id: number; name: string; generation: number; alive: 0 | 1; is_elite: 0 | 1; genome_json: string; introduced_by: string | null; cash_usd_start: number; cash_usd_current: number; realized_pnl_usd: number; unrealized_pnl_usd: number; trades_count: number; wins_count: number; kind: string; net_pnl: number; entries_count: number; open_principal: number }>;

  // Batched equity curves so each row can render an inline sparkline without
  // issuing 28+ extra queries.
  const sparkIds = Array.from(new Set([
    ...ranked.slice(0, 50).map((r) => r.agent.id),
    ...allTimeTop.map((r) => r.id),
  ]));
  const equityCurves = equityCurvesForAgents(sparkIds);

  // Batched entries count for the current-gen leaderboard so we can show
  // "Entries" alongside "Trades" (round-trips). An agent with N entries and 0
  // trades has N positions still open — currently invisible without this.
  const entriesById = new Map<number, number>();
  if (sparkIds.length > 0) {
    const placeholders = sparkIds.map(() => "?").join(",");
    const rows = db().prepare(
      `SELECT paper_agent_id, COUNT(*) AS n
         FROM paper_trades
        WHERE intent = 'entry' AND paper_agent_id IN (${placeholders})
        GROUP BY paper_agent_id`,
    ).all(...sparkIds) as Array<{ paper_agent_id: number; n: number }>;
    for (const r of rows) entriesById.set(r.paper_agent_id, r.n);
  }

  // Live decision diagnostic per alive agent — surfaces *why* an agent is
  // holding (e.g. "v=0.05% / ≥0.22%") so the leaderboard stays informative
  // even in flat markets where nothing fires.
  const liveCtx = buildLiveTickContext();
  const liveAgents = alive.map(toLiveAgent);
  const diagnostics = diagnoseAgents(liveAgents, liveCtx);

  // WS health — sub-minute crypto tick freshness from worker:realtime.
  const wsRows = wsHealth(60);

  return (
    <div className="space-y-8">
      <AutoRefresh label="arena" />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Arena — evolving paper agents</h1>
        <p className="text-zinc-400 mt-1 text-sm">
          {ranked.length} alive · gen {currentGen?.gen_number ?? "—"} open ·
          fitness = pnl% − 2 × max-DD% (TradingBot Arena formula). Top-1 across {process.env.ARENA_CHAMPION_GENS ?? "3"} consecutive sealed gens → eligible for capsule activation.
        </p>
        {wsRows.length > 0 && (
          <div className="flex gap-2 mt-2 flex-wrap text-[10px]">
            <span className="text-zinc-500">WS:</span>
            {wsRows.map((w) => (
              <span
                key={w.product_id}
                className={`px-1.5 py-0.5 rounded ${w.fresh ? "bg-accent-green/20 text-accent-green" : "bg-accent-red/20 text-accent-red"}`}
                title={`Last tick: ${w.ageSec}s ago, price=$${w.latest_price.toFixed(2)}`}
              >
                {w.product_id}={w.ageSec}s
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Live Polymarket portfolio — source of truth for real-money state.
       *  Mounted ABOVE the sim leaderboard because operators want to see
       *  actual fills + unrealized P/L first, before sim fitness rankings. */}
      <LivePortfolioCard funderAddress={process.env.POLYMARKET_FUNDER_ADDRESS ?? ""} />

      {/* Portfolio-diversity diagnostic — surfaces "N live capsules, M distinct
       *  strategy families." Red border when totalLiveCapsules > distinctFamilies
       *  (i.e. some family has >1 capsule, meaning at least two capsules are
       *  effectively the same strategy in different costumes). This is the
       *  exact failure mode the capsule-portfolio-governance PRD targets. */}
      {totalLiveCapsules > 0 && (
        <section
          className={`card ${
            totalLiveCapsules > distinctFamilies
              ? "border-accent-red/40 bg-accent-red/5"
              : "border-accent-green/30"
          }`}
        >
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="card-title m-0">
              Portfolio diversity{" "}
              <span className="text-xs text-zinc-500 font-normal ml-1">
                ({distinctFamilies} distinct {distinctFamilies === 1 ? "family" : "families"} across {totalLiveCapsules} live {totalLiveCapsules === 1 ? "capsule" : "capsules"})
              </span>
            </h2>
            {totalLiveCapsules > distinctFamilies ? (
              <span className="text-[10px] text-accent-red">
                ⚠️ correlated risk — some capsules share strategy family
              </span>
            ) : (
              <span className="text-[10px] text-accent-green">✓ all capsules distinct</span>
            )}
          </div>
          <p className="text-xs text-zinc-400 mb-3">
            A family with multiple capsules means those capsules will lose
            together on the strategy's bad day. The correlation engine + cluster
            kill switches (Phase 7+8) will quantify this; for now, see the
            distribution at a glance. Profiles inferred from each capsule's
            bound strategy kind.
          </p>
          <div className="flex flex-wrap gap-2">
            {diversitySummary.map(([key, count]) => {
              const [family, regime] = key.split("/");
              const tooClustered = count > 1;
              return (
                <span
                  key={key}
                  className={`inline-flex items-center text-xs px-2 py-1 rounded border ${
                    tooClustered
                      ? "bg-accent-red/15 text-accent-red border-accent-red/50"
                      : "bg-zinc-800 text-zinc-300 border-zinc-700"
                  }`}
                  title={`${count} capsule(s) with strategy_family=${family}, regime=${regime}`}
                >
                  <span className="font-mono">{family}</span>
                  <span className="text-zinc-500 mx-1">·</span>
                  <span className="text-zinc-500">{regime}</span>
                  <span className="ml-2 text-zinc-400">×{count}</span>
                </span>
              );
            })}
          </div>
        </section>
      )}

      <section className="grid grid-cols-5 gap-4">
        <Stat label="Alive agents" value={ranked.length.toString()} />
        <Stat label="Generations sealed" value={gens.filter((g) => g.sealed_at != null).length.toString()} />
        <Stat label="Eligible champions" value={eligible.length.toString()} hint={eligible.length > 0 ? "review on /capsules" : ""} />
        <Stat label="Elites preserved" value={`${eliteRows.length} / ${eliteCount}`} hint={`top-${eliteCount} across all gens · DD cap ${(eliteMaxDdPct * 100).toFixed(0)}%`} />
        <Stat label="Mutation mode" value={(process.env.ARENA_MUTATION_MODE ?? "programmatic").toUpperCase()} hint="ARENA_MUTATION_MODE env" />
      </section>

      {/* Elite preservation explainer + current elite roster. Surfaces what
       *  the amber ELITE pill on the leaderboard means and which agents are
       *  currently exempt from cull. */}
      <section className="card border-accent-amber/30 bg-accent-amber/5">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="card-title m-0 text-accent-amber">Elite roster ({eliteRows.length})</h2>
          <span className="text-[10px] text-zinc-500">
            top-{eliteCount} by fitness · drawdown cap {(eliteMaxDdPct * 100).toFixed(0)}% · re-evaluated every seal
          </span>
        </div>
        <p className="text-xs text-zinc-400 mb-2">
          Elites are protected from retirement at gen seal time. They keep their accumulated cash,
          open positions, and PnL across generations, and continue trading on every tick. An elite
          whose drawdown crosses the cap loses its flag and re-enters the normal cull pool.
        </p>
        {rankedElites.length === 0 ? (
          <p className="text-xs text-zinc-500 italic">
            No elites yet — top-{eliteCount} alive agents will be promoted at the next gen seal.
            (Current open gen: g{currentGen?.gen_number ?? "—"} · seal triggers at ARENA_EVOLVE_EVERY ticks.)
          </p>
        ) : (
          <table className="list">
            <thead><tr><th>#</th><th>Agent</th><th>Born</th><th>Strategy</th><th className="text-right">Sim equity</th><th className="text-right">Sim PnL%</th><th className="text-right">DD%</th><th className="text-right">Fitness</th><th className="text-right">Entries</th><th className="text-right">Round-trips</th><th className="text-right" title="Live capital (allocated) + capsule trades today. Real fills are in the Live Portfolio card at the top.">Live cap</th></tr></thead>
            <tbody>
              {rankedElites.map(({ agent, score }, i) => {
                const equity = liveEquity(agent);
                const nick = (() => { try { return genomeNickname(parseGenome(agent.genome_json)); } catch { return "?"; } })();
                const ddNearCap = score.max_dd_pct > eliteMaxDdPct * 0.75;
                const capsule = capsuleByAgent.get(agent.id);
                const isAi = /llm_probability_oracle/.test(agent.genome_json);
                return (
                  <tr key={agent.id}>
                    <td className="text-zinc-500 text-xs">{i + 1}</td>
                    <td>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Link className="text-zinc-100 hover:text-accent-blue" href={`/arena/${agent.id}`}>{agent.name}</Link>
                        <span className="inline-flex items-center text-[10px] leading-none px-1.5 py-0.5 rounded bg-accent-amber/20 text-accent-amber border border-accent-amber/40">ELITE</span>
                        <span
                          className={`inline-flex items-center text-[10px] leading-none px-1.5 py-0.5 rounded border ${isAi ? "bg-accent-blue/15 text-accent-blue border-accent-blue/40" : "bg-zinc-700/40 text-zinc-400 border-zinc-600/40"}`}
                          title={isAi
                            ? "AI: this agent's genome includes an llm_probability_oracle component — Claude estimates probability per market"
                            : "Pattern matcher: deterministic rules (velocity / z-score / threshold). No LLM involved."}
                        >{isAi ? "🧠 AI" : "📐 pattern"}</span>
                        {capsule && (
                          <span
                            className={`inline-flex items-center text-[10px] leading-none px-1.5 py-0.5 rounded border ${allowTradeLive ? "bg-accent-green/20 text-accent-green border-accent-green/60" : "bg-zinc-700/40 text-zinc-300 border-zinc-500/40"}`}
                            title={allowTradeLive
                              ? `LIVE: $${capsule.capital_allocated_usd} capital, capsule ${capsule.id.slice(0, 8)} — real orders armed`
                              : `Paper-live: $${capsule.capital_allocated_usd} capital, capsule ${capsule.id.slice(0, 8)} — orders DRY_RUN (ALLOW_TRADE unset)`}
                          >{allowTradeLive ? "💰 LIVE" : "📝 PAPER"}</span>
                        )}
                        {capsule?.strategy_family && (
                          <span
                            className="inline-flex items-center text-[10px] leading-none px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700 font-mono"
                            title={`Diversity profile (inferred): family=${capsule.strategy_family} · regime=${capsule.regime_dependency ?? "any"} · horizon=${capsule.time_horizon ?? "—"} · bias=${capsule.directional_bias ?? "—"}`}
                          >{capsule.strategy_family}</span>
                        )}
                      </div>
                    </td>
                    <td className="text-zinc-400 text-xs">
                      <Link className="hover:text-accent-blue" href={`/arena/generations/${agent.generation}`}>g{agent.generation}</Link>
                    </td>
                    <td className="text-zinc-400 text-xs">{nick}</td>
                    <td className="text-right tabular-nums">{fmtUsd(equity)}</td>
                    <td className={`text-right tabular-nums ${score.pnl_pct >= 0 ? "text-accent-green" : "text-accent-red"}`}>{fmtPct(score.pnl_pct)}</td>
                    <td className={`text-right tabular-nums ${ddNearCap ? "text-accent-red" : "text-zinc-400"}`} title={ddNearCap ? `near cap of ${(eliteMaxDdPct * 100).toFixed(0)}%` : ""}>{fmtPct(score.max_dd_pct)}</td>
                    <td className={`text-right tabular-nums ${score.fitness >= 0 ? "text-accent-green" : "text-accent-red"}`}>{score.fitness.toFixed(4)}</td>
                    <td className="text-right tabular-nums text-zinc-400">{score.entries_count}</td>
                    <td className="text-right tabular-nums text-zinc-400">{score.trades_count}</td>
                    <td className="text-right tabular-nums text-xs whitespace-nowrap">
                      {capsule ? (
                        <span title={`capsule capital $${capsule.capital_allocated_usd.toFixed(2)} · today: ${capsule.trades_today} trades, daily P/L $${capsule.daily_pnl_usd.toFixed(2)} (sim accounting). For REAL live P/L see the Live Portfolio card at the top of the page.`}>
                          <span className="text-zinc-300">${capsule.capital_allocated_usd.toFixed(2)}</span>
                          <span className="text-zinc-500 ml-1">·</span>
                          <span className="text-zinc-500 ml-1">{capsule.trades_today}t</span>
                        </span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {eligible.length > 0 && (
        <section className="card border-accent-amber/40 bg-accent-amber/5">
          <h2 className="card-title text-accent-amber">🏆 Championship eligible — needs human approval</h2>
          <ul className="text-xs space-y-1 mt-2">
            {eligible.map((c) => (
              <li key={c.id} className="text-zinc-300">
                <Link href={`/capsules`} className="hover:text-accent-blue">
                  championship #{c.id} · agent {c.paper_agent_id} · {c.consecutive_gen_wins} consecutive gen wins → review on /capsules
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* All-time top agents — surfaces actual winners even when current gen is fresh */}
      <section className="card border-accent-blue/30">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="card-title m-0">All-time top agents ({allTimeTop.length})</h2>
          <span className="text-[10px] text-zinc-500">across every generation · by net PnL</span>
        </div>
        {allTimeTop.length === 0 ? (
          <p className="text-xs text-zinc-500">No agent has traded yet across any generation. Wait for the snapshot worker to fill enough history for momentum / fade strategies to fire.</p>
        ) : (
          <table className="list">
            <thead><tr><th>#</th><th>Agent</th><th>Brain</th><th>Lineage</th><th>Gen</th><th>Kind</th><th>Status</th><th className="text-right">Start</th><th className="text-right">Equity</th><th className="text-right">Net PnL</th><th className="text-right" title="Positions opened (including still-open)">Entries</th><th className="text-right" title="Round-trips (closed positions only)">Round-trips</th><th className="text-right">Win%</th><th>Equity curve</th></tr></thead>
            <tbody>
              {allTimeTop.map((r, i) => {
                const curve = equityCurves.get(r.id) ?? [];
                const up = curve.length > 1 ? curve[curve.length - 1] >= curve[0] : false;
                // AI-or-pattern detection (matches elite-roster badge logic).
                // An agent counts as AI-driven if its genome includes an
                // llm_probability_oracle component (top-level OR as a multi_strategy sub).
                const isAi = /llm_probability_oracle/.test(r.genome_json ?? "");
                // Lineage tag tells you where the genome came from — useful to
                // visually compare LLM-mutation-bred vs preset vs survivor
                // lineages once meta-evolution has had a few cycles to seed.
                const lineageLabel: Record<string, { text: string; className: string }> = {
                  "meta-llm": { text: "meta-LLM", className: "bg-purple-500/20 text-purple-300 border-purple-500/40" },
                  "mutate-llm": { text: "mut-LLM", className: "bg-accent-blue/15 text-accent-blue border-accent-blue/40" },
                  "mutate-programmatic": { text: "mut-prog", className: "bg-zinc-700/40 text-zinc-300 border-zinc-600/40" },
                  "preset-aggressive": { text: "preset", className: "bg-accent-amber/15 text-accent-amber border-accent-amber/40" },
                  "survivor-carryover": { text: "carry", className: "bg-zinc-800/40 text-zinc-500 border-zinc-700/40" },
                  "survivor-carryover-refreshed": { text: "carry+", className: "bg-zinc-800/40 text-zinc-500 border-zinc-700/40" },
                };
                const lineage = r.introduced_by ? lineageLabel[r.introduced_by] : null;
                return (
                <tr key={r.id}>
                  <td className="text-zinc-500 text-xs">{i + 1}</td>
                  <td>
                    <Link className="text-zinc-100 hover:text-accent-blue" href={`/arena/${r.id}`}>{r.name}</Link>
                    {r.is_elite ? <span className="ml-1.5 text-[10px] px-1 rounded bg-accent-amber/20 text-accent-amber border border-accent-amber/40">ELITE</span> : null}
                  </td>
                  <td>
                    <span
                      className={`inline-flex items-center text-[10px] leading-none px-1.5 py-0.5 rounded border ${isAi ? "bg-accent-blue/15 text-accent-blue border-accent-blue/40" : "bg-zinc-700/40 text-zinc-400 border-zinc-600/40"}`}
                      title={isAi ? "AI: genome includes llm_probability_oracle — Claude estimates probability per market" : "Pattern matcher: deterministic rules (velocity / z-score / threshold). No LLM."}
                    >{isAi ? "🧠 AI" : "📐 pattern"}</span>
                  </td>
                  <td>
                    {lineage ? (
                      <span
                        className={`inline-flex items-center text-[9px] leading-none px-1.5 py-0.5 rounded border ${lineage.className}`}
                        title={`introduced_by=${r.introduced_by}`}
                      >{lineage.text}</span>
                    ) : <span className="text-zinc-600 text-xs">—</span>}
                  </td>
                  <td className="text-zinc-400 text-xs">g{r.generation}</td>
                  <td className="text-zinc-400 text-xs">{r.kind?.replace(/_/g, "-")}</td>
                  <td>
                    {r.alive
                      ? (r.is_elite
                          ? <span className="pill-amber" title="Elite — protected from cull across generations">elite</span>
                          : <span className="pill-green">alive</span>)
                      : <span className="pill-amber">retired</span>}
                  </td>
                  <td className="text-right tabular-nums text-zinc-400">${r.cash_usd_start.toFixed(2)}</td>
                  <td className="text-right tabular-nums">${(r.cash_usd_current + (r.open_principal ?? 0) + r.unrealized_pnl_usd).toFixed(2)}</td>
                  <td className={`text-right tabular-nums ${r.net_pnl >= 0 ? "text-accent-green" : "text-accent-red"}`}>{r.net_pnl >= 0 ? "+" : ""}${r.net_pnl.toFixed(2)}</td>
                  <td className="text-right tabular-nums text-zinc-400">{r.entries_count}</td>
                  <td className="text-right tabular-nums text-zinc-400">{r.trades_count}</td>
                  <td className="text-right tabular-nums text-zinc-400">{r.trades_count > 0 ? Math.round((r.wins_count / r.trades_count) * 100) : 0}%</td>
                  <td><Sparkline values={curve} width={100} height={20} stroke={up ? "#46d39a" : "#ff6e6e"} /></td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">Current-gen leaderboard ({ranked.length})</h2>
        {ranked.length === 0 ? (
          <div className="text-xs text-zinc-400 space-y-2">
            <p>No alive agents yet. To get started:</p>
            <ol className="list-decimal list-inside text-zinc-500 space-y-1 ml-2">
              <li><code className="text-zinc-300">npm run arena:init</code> — seed gen 0 with 8 agents (one of each strategy kind)</li>
              <li><code className="text-zinc-300">npm run worker:snapshot</code> — pull live Polymarket midpoints + Coinbase top-of-book + 1-min candles</li>
              <li><code className="text-zinc-300">npm run arena:tick</code> — each alive agent decides; auto-evolves when tick_count hits ARENA_EVOLVE_EVERY (default 6 ticks = 30 min)</li>
              <li>Or install the Windows Task Scheduler entry once: <code className="text-zinc-300">scripts/scheduler/install-arena-tasks.ps1</code></li>
            </ol>
          </div>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>#</th><th>Agent</th><th>Gen</th><th>Strategy</th><th>Status</th><th className="text-right">Equity</th>
                <th className="text-right">PnL%</th><th className="text-right">DD%</th><th className="text-right">Fitness</th>
                <th className="text-right" title="Positions opened (including still-open)">Entries</th>
                <th className="text-right" title="Round-trips (closed positions only)">Round-trips</th>
                <th className="text-right">Win%</th><th>Equity curve</th>
              </tr>
            </thead>
            <tbody>
              {ranked.slice(0, 50).map(({ agent, score }, i) => {
                const equity = liveEquity(agent);
                const nick = (() => { try { return genomeNickname(parseGenome(agent.genome_json)); } catch { return "?"; } })();
                const curve = equityCurves.get(agent.id) ?? [];
                const up = curve.length > 1 ? curve[curve.length - 1] >= curve[0] : false;
                const diag = diagnostics.get(agent.id);
                return (
                  <tr key={agent.id}>
                    <td className="text-zinc-500 text-xs">{i + 1}</td>
                    <td>
                      <Link className="text-zinc-100 hover:text-accent-blue" href={`/arena/${agent.id}`}>{agent.name}</Link>
                      {agent.is_elite ? <span className="ml-1.5 text-[10px] px-1 rounded bg-accent-amber/20 text-accent-amber border border-accent-amber/40">ELITE</span> : null}
                    </td>
                    <td className="text-zinc-400 text-xs">g{agent.generation}</td>
                    <td className="text-zinc-400 text-xs">{nick}</td>
                    <td className="text-xs"><DiagCell diag={diag} /></td>
                    <td className="text-right tabular-nums">{fmtUsd(equity)}</td>
                    <td className={`text-right tabular-nums ${score.pnl_pct >= 0 ? "text-accent-green" : "text-accent-red"}`}>{fmtPct(score.pnl_pct)}</td>
                    <td className="text-right tabular-nums text-zinc-400">{fmtPct(score.max_dd_pct)}</td>
                    <td className={`text-right tabular-nums ${score.fitness >= 0 ? "text-accent-green" : "text-accent-red"}`}>{score.fitness.toFixed(4)}</td>
                    <td className="text-right tabular-nums text-zinc-400">{entriesById.get(agent.id) ?? 0}</td>
                    <td className="text-right tabular-nums text-zinc-400">{score.trades_count}</td>
                    <td className="text-right tabular-nums text-zinc-400">{(score.win_rate * 100).toFixed(0)}%</td>
                    <td><Sparkline values={curve} width={100} height={20} stroke={up ? "#46d39a" : "#ff6e6e"} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">Recent generations</h2>
        <table className="list">
          <thead><tr><th>Gen</th><th>Status</th><th className="text-right">Agents</th><th className="text-right">Top fitness</th><th>Top agent</th><th>Sealed</th></tr></thead>
          <tbody>
            {gens.map((g) => (
              <tr key={g.id}>
                <td>
                  <Link href={`/arena/generations/${g.gen_number}`} className="text-zinc-100 hover:text-accent-blue">
                    g{g.gen_number}
                  </Link>
                </td>
                <td><span className={g.sealed_at ? "pill-green" : "pill-blue"}>{g.sealed_at ? "sealed" : "open"}</span></td>
                <td className="text-right tabular-nums">{g.n_agents}</td>
                <td className="text-right tabular-nums text-zinc-400">{g.top_score != null ? g.top_score.toFixed(4) : "—"}</td>
                <td className="text-zinc-400 text-xs">{g.top_paper_agent_id ? <Link className="hover:text-accent-blue" href={`/arena/${g.top_paper_agent_id}`}>#{g.top_paper_agent_id}</Link> : "—"}</td>
                <td className="text-xs text-zinc-500">{g.sealed_at ? new Date(g.sealed_at).toLocaleString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <nav className="text-xs text-zinc-500 flex gap-4">
        <Link href="/arena/generations" className="hover:text-zinc-300">→ Generations timeline</Link>
        <Link href="/capsules" className="hover:text-zinc-300">→ Capsules</Link>
        <Link href="/api/arena/leaderboard" className="hover:text-zinc-300">→ Leaderboard JSON</Link>
      </nav>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card">
      <div className="card-title">{label}</div>
      <div className="stat">{value}</div>
      {hint && <div className="text-[10px] text-zinc-500 mt-1">{hint}</div>}
    </div>
  );
}

function DiagCell({ diag }: { diag: AgentDiagnostic | undefined }) {
  if (!diag) return <span className="text-zinc-600">—</span>;
  const color =
    diag.status === "would-enter" ? "text-accent-green"
    : diag.status === "in-position" ? "text-accent-blue"
    : diag.status === "no-data" ? "text-zinc-600"
    : "text-zinc-400";
  return <span className={color} title={diag.detail}>{diag.label}</span>;
}
