import Link from "next/link";
import { notFound } from "next/navigation";
import { currentVersion, getAgentBySlug, listStrategiesForAgent, listVersions } from "@/lib/db/queries";
import { buildAgentContext } from "@/lib/agents/context";
import { GovernanceCard } from "@/components/GovernanceCard";
import { db } from "@/lib/db/client";

export const dynamic = "force-dynamic";

function fmtUsd(n: number | null | undefined): string {
  return `$${Number(n ?? 0).toFixed(2)}`;
}
function fmtPct(n: number | null | undefined, digits = 1): string {
  return `${(Number(n ?? 0) * 100).toFixed(digits)}%`;
}

export default async function AgentDetail({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const agent = getAgentBySlug(slug);
  if (!agent) notFound();
  const strategies = listStrategiesForAgent(agent.id);

  // One AgentContext per strategy — surface the same snapshot the
  // research-loop evaluators see when they make decisions.
  const contexts = strategies.map((s) => ({ strategy: s, ctx: buildAgentContext(s.id) }));

  // Find a capsule bound to any of this agent's strategies (gen-2 capsules
  // link via strategy_id, not paper_agent_id). For the governance card we
  // pick the live-or-paper one if multiple exist.
  const strategyIds = strategies.map((s) => s.id);
  let agentCapsule: { id: string } | undefined;
  if (strategyIds.length > 0) {
    const placeholders = strategyIds.map(() => "?").join(",");
    agentCapsule = db()
      .prepare(
        `SELECT id FROM capsules
          WHERE strategy_id IN (${placeholders})
            AND status IN ('live', 'paper', 'paused')
          ORDER BY (status = 'live') DESC, (status = 'paper') DESC, updated_at DESC
          LIMIT 1`,
      )
      .get(...strategyIds) as { id: string } | undefined;
  }
  // For calibration filtering — use the first strategy's slug as a kind hint.
  const primaryStrategyKind = strategies[0]?.slug;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/agents" className="text-xs text-zinc-500 hover:text-zinc-300">← all agents</Link>
        <h1 className="text-2xl font-semibold mt-1">{agent.name}</h1>
        <p className="text-zinc-400 text-sm mt-1 max-w-3xl">{agent.charter}</p>
        <div className="flex gap-4 text-xs text-zinc-500 mt-2">
          <span>slug: <span className="text-zinc-300">{agent.slug}</span></span>
          <span>risk budget: <span className="text-zinc-300">${agent.risk_budget_usd.toLocaleString()}</span></span>
          <span>status: <span className={agent.status === "active" ? "text-accent-green" : "text-accent-amber"}>{agent.status}</span></span>
        </div>
      </div>

      {/* Governance — diversity profile, capsule state, decisions, calibration,
       *  governor / killswitch history. capsuleId from strategies binding;
       *  calibration filtered by primary strategy slug. */}
      <GovernanceCard capsuleId={agentCapsule?.id} strategyKind={primaryStrategyKind} />

      <section>
        <h2 className="card-title">Strategies</h2>
        <div className="space-y-4">
          {contexts.map(({ strategy: s, ctx }) => {
            const cur = currentVersion(s.id);
            const allVersions = listVersions(s.id);
            const filter = JSON.parse(s.market_filter);
            const spec = cur ? JSON.parse(cur.spec_json) : null;
            const topRejects = Object.entries(ctx.recentRejectCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
            return (
              <div key={s.id} className="card">
                <div className="flex items-baseline justify-between mb-1">
                  <Link href={`/strategies/${agent.slug}/${s.slug}`} className="text-lg font-medium hover:text-accent-blue">{s.name}</Link>
                  <span className="text-xs text-zinc-500">v{cur?.version ?? "?"} of {allVersions.length}</span>
                </div>
                <p className="text-sm text-zinc-300">{s.thesis}</p>

                {/* Live context — same snapshot the evaluator sees */}
                <div className="mt-3 rounded border border-ink-700 bg-ink-950 p-3 text-xs">
                  <div className="flex items-baseline justify-between mb-2">
                    <span className="card-title">Live context</span>
                    <span className="text-zinc-600">built {ctx.builtAt.slice(11, 19)}Z</span>
                  </div>
                  <div className="grid grid-cols-4 gap-3">
                    <div>
                      <div className="text-zinc-500">Halt</div>
                      <div className={ctx.killSwitch.halted ? "text-accent-red" : "text-accent-green"}>{ctx.killSwitch.halted ? `HALTED: ${ctx.killSwitch.reason || "(no reason)"}` : "clear"}</div>
                    </div>
                    <div>
                      <div className="text-zinc-500">Capsules</div>
                      <div className="tabular-nums">{ctx.activeCapsules.length} active / {ctx.capsules.length} total</div>
                    </div>
                    <div>
                      <div className="text-zinc-500">Last backtest</div>
                      <div className="tabular-nums">{ctx.lastBacktest?.score != null ? `score ${ctx.lastBacktest.score.toFixed(1)}` : "(none)"}</div>
                      {ctx.lastBacktest?.pnlUsd != null && (
                        <div className="text-zinc-600">{fmtUsd(ctx.lastBacktest.pnlUsd)} pnl / {fmtPct((ctx.lastBacktest.maxDrawdownUsd ?? 0) / 1000, 1)} dd</div>
                      )}
                    </div>
                    <div>
                      <div className="text-zinc-500">Top recent rejects</div>
                      {topRejects.length === 0 ? (
                        <div className="text-zinc-600">(none)</div>
                      ) : (
                        topRejects.map(([code, count]) => (
                          <div key={code} className="text-zinc-300 tabular-nums">{code} <span className="text-zinc-600">×{count}</span></div>
                        ))
                      )}
                    </div>
                  </div>

                  {ctx.activeCapsules.length > 0 && (
                    <div className="mt-3 border-t border-ink-800 pt-2">
                      <div className="text-zinc-500 mb-1">Bound capsules</div>
                      <table className="list w-full">
                        <thead><tr><th>id</th><th>status</th><th className="text-right">allocated</th><th className="text-right">deployed</th><th className="text-right">daily pnl</th><th className="text-right">trades today</th><th className="text-right">open pos</th></tr></thead>
                        <tbody>
                          {ctx.activeCapsules.map((c) => (
                            <tr key={c.id}>
                              <td className="font-mono text-[10px]">{c.id.slice(0, 8)}…</td>
                              <td>{c.status}</td>
                              <td className="text-right tabular-nums">{fmtUsd(c.capital_allocated_usd)}</td>
                              <td className="text-right tabular-nums">{fmtUsd(c.capital_deployed_usd)}</td>
                              <td className={`text-right tabular-nums ${c.daily_pnl_usd < 0 ? "text-accent-red" : c.daily_pnl_usd > 0 ? "text-accent-green" : ""}`}>{fmtUsd(c.daily_pnl_usd)}</td>
                              <td className="text-right tabular-nums">{c.trades_today}{c.max_trades_per_day > 0 ? ` / ${c.max_trades_per_day}` : ""}</td>
                              <td className="text-right tabular-nums">{c.open_positions}{c.max_open_positions > 0 ? ` / ${c.max_open_positions}` : ""}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {ctx.recentEvolution.length > 0 && (
                    <div className="mt-3 border-t border-ink-800 pt-2">
                      <div className="text-zinc-500 mb-1">Recent evolution (last {Math.min(5, ctx.recentEvolution.length)})</div>
                      <ul className="space-y-0.5">
                        {ctx.recentEvolution.slice(0, 5).map((e) => (
                          <li key={e.id} className="font-mono text-[11px] text-zinc-400">
                            <span className="text-zinc-600">{e.created_at.slice(11, 19)}</span>{" "}
                            <span className="text-accent-blue">{e.event_type}</span>{" "}
                            <span className="text-zinc-300">{e.summary}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                <div className="mt-3 grid grid-cols-2 gap-4 text-xs">
                  <div>
                    <div className="card-title mb-1">Market filter</div>
                    <pre className="bg-ink-950 rounded p-2 overflow-x-auto text-zinc-300">{JSON.stringify(filter, null, 2)}</pre>
                  </div>
                  <div>
                    <div className="card-title mb-1">Current spec</div>
                    <pre className="bg-ink-950 rounded p-2 overflow-x-auto text-zinc-300">{spec ? JSON.stringify(spec, null, 2) : "(no version)"}</pre>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
