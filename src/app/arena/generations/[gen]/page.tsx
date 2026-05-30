/**
 * /arena/generations/[gen] — every agent in a single generation.
 *
 * Linked from /arena/generations (timeline) and /arena (Recent generations
 * card). Shows BOTH alive and retired agents for the requested gen, with the
 * key stats (entries, round-trips, fitness, equity, retire reason).
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { equityCurvesForAgents, listAllAgentsForGen } from "@/lib/arena/db";
import { rankAgents, liveEquity } from "@/lib/arena/score";
import { parseGenome, genomeNickname } from "@/lib/arena/genome";
import { Sparkline } from "@/components/Sparkline";
import type { GenerationRow } from "@/lib/arena/types";

export const dynamic = "force-dynamic";

function fmtPct(n: number): string { return `${(n * 100).toFixed(2)}%`; }
function fmtUsd(n: number): string { return `$${n.toFixed(2)}`; }

export default async function GenerationDetailPage(props: { params: Promise<{ gen: string }> }) {
  const { gen: genStr } = await props.params;
  const genNumber = Number(genStr);
  if (!Number.isFinite(genNumber)) notFound();

  const genRow = db().prepare(
    `SELECT * FROM paper_generations WHERE gen_number = ?`,
  ).get(genNumber) as GenerationRow | undefined;
  if (!genRow) notFound();

  // Pull every agent in this generation (alive + retired), pre-compute the
  // per-agent entries count from paper_trades so we can show entries alongside
  // round-trips.
  const agents = listAllAgentsForGen(genNumber);
  const ranked = rankAgents(agents);
  const ids = ranked.map((r) => r.agent.id);
  const entriesById = new Map<number, number>();
  const openByAgent = new Map<number, number>();
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const rows = db().prepare(
      `SELECT paper_agent_id, COUNT(*) AS n FROM paper_trades
        WHERE intent = 'entry' AND paper_agent_id IN (${placeholders})
        GROUP BY paper_agent_id`,
    ).all(...ids) as Array<{ paper_agent_id: number; n: number }>;
    for (const r of rows) entriesById.set(r.paper_agent_id, r.n);
    // Open-position counts straight off the basket JSON.
    for (const r of ranked) {
      try {
        const arr = JSON.parse(r.agent.position_basket_json || "[]") as unknown[];
        openByAgent.set(r.agent.id, arr.length);
      } catch { openByAgent.set(r.agent.id, 0); }
    }
  }
  const equityCurves = equityCurvesForAgents(ids);

  const alive = ranked.filter((r) => r.agent.alive);
  const retired = ranked.filter((r) => !r.agent.alive);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/arena/generations" className="text-xs text-zinc-500 hover:text-zinc-300">← generations timeline</Link>
        <h1 className="text-2xl font-semibold mt-1">Generation g{genRow.gen_number}</h1>
        <p className="text-zinc-400 text-sm mt-1">
          {genRow.sealed_at ? <span className="pill-green">sealed</span> : <span className="pill-blue">open</span>}
          {" · "}
          {agents.length} agents ({alive.length} alive, {retired.length} retired)
          {" · "}started {new Date(genRow.started_at).toLocaleString()}
          {genRow.sealed_at && <> · sealed {new Date(genRow.sealed_at).toLocaleString()}</>}
        </p>
        {genRow.top_paper_agent_id && (
          <p className="text-xs text-zinc-400 mt-1">
            Top agent at seal:{" "}
            <Link className="hover:text-accent-blue" href={`/arena/${genRow.top_paper_agent_id}`}>
              #{genRow.top_paper_agent_id}
            </Link>
            {" "}with fitness {genRow.top_score != null ? genRow.top_score.toFixed(4) : "—"}
          </p>
        )}
        {genRow.notes && <p className="text-xs text-zinc-500 mt-1 italic">{genRow.notes}</p>}
      </div>

      {/* Stats row */}
      <section className="grid grid-cols-4 gap-4">
        <Stat label="Total agents" value={String(agents.length)} />
        <Stat label="Alive" value={String(alive.length)} />
        <Stat label="Retired" value={String(retired.length)} />
        <Stat label="Top fitness" value={genRow.top_score != null ? genRow.top_score.toFixed(4) : "—"} />
      </section>

      {/* Alive section */}
      <section className="card">
        <h2 className="card-title">Alive ({alive.length})</h2>
        {alive.length === 0 ? (
          <p className="text-xs text-zinc-500">No alive agents in this generation.</p>
        ) : (
          <AgentTable
            rows={alive}
            entriesById={entriesById}
            openByAgent={openByAgent}
            equityCurves={equityCurves}
            showRetireReason={false}
          />
        )}
      </section>

      {/* Retired section */}
      <section className="card">
        <h2 className="card-title">Retired ({retired.length})</h2>
        {retired.length === 0 ? (
          <p className="text-xs text-zinc-500">No retired agents yet.</p>
        ) : (
          <AgentTable
            rows={retired}
            entriesById={entriesById}
            openByAgent={openByAgent}
            equityCurves={equityCurves}
            showRetireReason={true}
          />
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="card-title">{label}</div>
      <div className="stat">{value}</div>
    </div>
  );
}

function AgentTable({
  rows, entriesById, openByAgent, equityCurves, showRetireReason,
}: {
  rows: ReturnType<typeof rankAgents>;
  entriesById: Map<number, number>;
  openByAgent: Map<number, number>;
  equityCurves: Map<number, number[]>;
  showRetireReason: boolean;
}) {
  return (
    <table className="list">
      <thead>
        <tr>
          <th>#</th>
          <th>Agent</th>
          <th>Strategy</th>
          <th className="text-right">Equity</th>
          <th className="text-right">PnL%</th>
          <th className="text-right">DD%</th>
          <th className="text-right">Fitness</th>
          <th className="text-right">Open</th>
          <th className="text-right">Entries</th>
          <th className="text-right">Round-trips</th>
          <th className="text-right">Wins</th>
          <th className="text-right">Win%</th>
          {showRetireReason && <th>Retire reason</th>}
          <th>Equity curve</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ agent, score }, i) => {
          const equity = liveEquity(agent);
          const nick = (() => { try { return genomeNickname(parseGenome(agent.genome_json)); } catch { return "?"; } })();
          const curve = equityCurves.get(agent.id) ?? [];
          const up = curve.length > 1 ? curve[curve.length - 1] >= curve[0] : false;
          return (
            <tr key={agent.id}>
              <td className="text-zinc-500 text-xs">{i + 1}</td>
              <td>
                <Link className="text-zinc-100 hover:text-accent-blue" href={`/arena/${agent.id}`}>
                  {agent.name}
                </Link>
                {agent.is_elite ? <span className="ml-1.5 text-[10px] px-1 rounded bg-accent-amber/20 text-accent-amber border border-accent-amber/40">ELITE</span> : null}
              </td>
              <td className="text-zinc-400 text-xs">{nick}</td>
              <td className="text-right tabular-nums">{fmtUsd(equity)}</td>
              <td className={`text-right tabular-nums ${score.pnl_pct >= 0 ? "text-accent-green" : "text-accent-red"}`}>
                {fmtPct(score.pnl_pct)}
              </td>
              <td className="text-right tabular-nums text-zinc-400">{fmtPct(score.max_dd_pct)}</td>
              <td className={`text-right tabular-nums ${score.fitness >= 0 ? "text-accent-green" : "text-accent-red"}`}>
                {score.fitness.toFixed(4)}
              </td>
              <td className="text-right tabular-nums text-zinc-400">{openByAgent.get(agent.id) ?? 0}</td>
              <td className="text-right tabular-nums text-zinc-400">{entriesById.get(agent.id) ?? 0}</td>
              <td className="text-right tabular-nums text-zinc-400">{score.trades_count}</td>
              <td className="text-right tabular-nums text-zinc-400">{agent.wins_count}</td>
              <td className="text-right tabular-nums text-zinc-400">{(score.win_rate * 100).toFixed(0)}%</td>
              {showRetireReason && (
                <td className="text-xs text-zinc-500">{agent.retire_reason ?? "—"}</td>
              )}
              <td><Sparkline values={curve} width={100} height={20} stroke={up ? "#46d39a" : "#ff6e6e"} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
