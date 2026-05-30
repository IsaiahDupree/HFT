import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { currentVersion, getAgentBySlug, listTradesForStrategy, listVersions, performanceFor } from "@/lib/db/queries";
import { PromoteButton, RetireButton } from "./Actions";

export const dynamic = "force-dynamic";

export default async function StrategyDetail({ params }: { params: Promise<{ agent: string; strategy: string }> }) {
  const { agent: agentSlug, strategy: stratSlug } = await params;
  const agent = getAgentBySlug(agentSlug);
  if (!agent) notFound();
  const strat = db().prepare("SELECT * FROM strategies WHERE agent_id = ? AND slug = ?").get(agent.id, stratSlug) as any;
  if (!strat) notFound();

  const cur = currentVersion(strat.id);
  const all = listVersions(strat.id);
  const trades = listTradesForStrategy(strat.id);
  const perf = cur ? performanceFor(cur.id) : [];

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/agents/${agent.slug}`} className="text-xs text-zinc-500 hover:text-zinc-300">← {agent.name}</Link>
        <div className="flex items-baseline justify-between mt-1">
          <h1 className="text-2xl font-semibold">{strat.name}</h1>
          <div className="flex items-center gap-2">
            <span className={strat.status === "active" ? "pill-green" : "pill-amber"}>{strat.status}</span>
            {strat.status !== "retired" && <RetireButton strategyId={strat.id} />}
          </div>
        </div>
        <p className="text-sm text-zinc-300 mt-1 max-w-3xl">{strat.thesis}</p>
      </div>

      <section className="grid grid-cols-2 gap-6">
        <div className="card">
          <h2 className="card-title">Version history</h2>
          <ul className="space-y-2 text-sm">
            {all.map((v) => (
              <li key={v.id} className="flex items-baseline justify-between gap-2">
                <span>
                  <span className={v.is_current ? "text-accent-green" : "text-zinc-400"}>v{v.version}</span>
                  <span className="ml-2 text-zinc-500 text-xs">{v.introduced_by}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500">{v.created_at?.slice(0, 16)}</span>
                  {!v.is_current && <PromoteButton strategyId={strat.id} versionId={v.id} />}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h2 className="card-title">Performance</h2>
          {perf.length === 0 ? (
            <p className="text-zinc-500 text-xs">No metrics yet — the research loop populates this after trades close.</p>
          ) : (
            <table className="list">
              <thead><tr><th>Window</th><th>Trades</th><th>Win%</th><th>PnL</th><th>Sharpe</th></tr></thead>
              <tbody>
                {perf.map((p: any) => (
                  <tr key={p.id}>
                    <td>{p.window}</td>
                    <td>{p.trades_count}</td>
                    <td>{p.win_rate ? (p.win_rate * 100).toFixed(0) + "%" : "—"}</td>
                    <td className={p.total_pnl_usd >= 0 ? "text-accent-green" : "text-accent-red"}>${(p.total_pnl_usd ?? 0).toFixed(2)}</td>
                    <td>{p.sharpe?.toFixed(2) ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">Current spec (v{cur?.version})</h2>
        <pre className="bg-ink-950 rounded p-3 text-xs text-zinc-300 overflow-x-auto">{cur ? JSON.stringify(JSON.parse(cur.spec_json), null, 2) : "(no version)"}</pre>
        <p className="text-xs text-zinc-500 mt-2"><span className="text-zinc-400">Rationale:</span> {cur?.rationale}</p>
      </section>

      {all.filter((v) => !v.is_current).length > 0 && (
        <section className="card">
          <h2 className="card-title">Proposed versions awaiting promotion</h2>
          <div className="space-y-4">
            {all.filter((v) => !v.is_current).map((v) => (
              <div key={v.id} className="border border-ink-700 rounded p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm">
                    <span className="text-zinc-300">v{v.version}</span>
                    <span className="ml-2 text-xs text-zinc-500">by {v.introduced_by} • {v.created_at?.slice(0, 16)}</span>
                  </div>
                  <PromoteButton strategyId={strat.id} versionId={v.id} label={`promote v${v.version}`} />
                </div>
                <p className="text-xs text-zinc-400 mb-2">{v.rationale}</p>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <div className="card-title">Spec diff target</div>
                    <pre className="bg-ink-950 rounded p-2 overflow-x-auto text-zinc-300">{JSON.stringify(JSON.parse(v.spec_json), null, 2)}</pre>
                  </div>
                  <div>
                    <div className="card-title">Backtest summary</div>
                    <pre className="bg-ink-950 rounded p-2 overflow-x-auto text-zinc-300">{v.backtest_summary ? JSON.stringify(JSON.parse(v.backtest_summary), null, 2) : "(none)"}</pre>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <h2 className="card-title">Trades on this strategy</h2>
        {trades.length === 0 ? (
          <p className="text-zinc-500 text-xs">No trades yet.</p>
        ) : (
          <table className="list">
            <thead><tr><th>Opened</th><th>Side</th><th>Px</th><th>Size</th><th>Intent</th><th>Status</th><th>PnL</th></tr></thead>
            <tbody>{trades.map((t: any) => (
              <tr key={t.id}>
                <td>{t.opened_at?.slice(0, 16)}</td>
                <td>{t.side}</td>
                <td>{Number(t.price).toFixed(3)}</td>
                <td>{Number(t.size).toFixed(2)}</td>
                <td>{t.intent}</td>
                <td><span className={`pill-${t.status === "filled" ? "green" : t.status === "rejected" ? "red" : "amber"}`}>{t.status}</span></td>
                <td className={t.pnl_usd > 0 ? "text-accent-green" : t.pnl_usd < 0 ? "text-accent-red" : ""}>{t.pnl_usd ? `$${Number(t.pnl_usd).toFixed(2)}` : "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </div>
  );
}
