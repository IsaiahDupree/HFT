import { listAgents, listAllStrategies, listRecentTrades, listEvolutionEvents } from "@/lib/db/queries";
import { poly } from "@/lib/polymarket/client";
import Link from "next/link";

export const dynamic = "force-dynamic";

async function safe<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try { return await fn(); } catch (err) { return { error: (err as Error).message }; }
}

export default async function Home() {
  const agents = listAgents();
  const strategies = listAllStrategies();
  const trades = listRecentTrades(10);
  const evo = listEvolutionEvents(10);
  const [oi, lb] = await Promise.all([
    safe(() => poly.openInterest()),
    safe(() => poly.traderLeaderboard({ limit: 5 })),
  ]);

  const totalRisk = agents.reduce((acc, a) => acc + a.risk_budget_usd, 0);
  const activeAgents = agents.filter((a) => a.status === "active").length;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Control plane</h1>
        <p className="text-zinc-400 mt-1">Local workspace for AI-agent prediction-market strategies and research.</p>
      </div>

      <section className="grid grid-cols-4 gap-4">
        <Stat label="Active agents" value={`${activeAgents}/${agents.length}`} />
        <Stat label="Strategies" value={strategies.length.toString()} />
        <Stat label="Risk budget (USD)" value={`$${totalRisk.toLocaleString()}`} />
        <Stat label="Open interest (live)" value={renderOI(oi)} />
      </section>

      <section className="grid grid-cols-2 gap-6">
        <div className="card">
          <h2 className="card-title">Agents</h2>
          <ul className="divide-y divide-ink-800">
            {agents.map((a) => (
              <li key={a.id} className="py-3">
                <Link href={`/agents/${a.slug}`} className="flex items-baseline justify-between row-link">
                  <span>
                    <span className="text-zinc-100">{a.name}</span>
                    <span className="ml-2 text-xs text-zinc-500">{a.slug}</span>
                  </span>
                  <span className="text-xs text-zinc-400">${a.risk_budget_usd.toLocaleString()} risk</span>
                </Link>
                <p className="text-xs text-zinc-500 leading-snug">{a.charter}</p>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h2 className="card-title">Recent trades</h2>
          {trades.length === 0 ? (
            <p className="text-zinc-500 text-xs">No trades recorded yet. Once agents run, executions land here.</p>
          ) : (
            <table className="list">
              <thead><tr><th>Time</th><th>Agent</th><th>Side</th><th>Px</th><th>Size</th></tr></thead>
              <tbody>{trades.map((t) => (
                <tr key={t.id}><td>{t.opened_at?.slice(11, 19)}</td><td>{t.agent_name}</td><td>{t.side}</td><td>{Number(t.price).toFixed(3)}</td><td>{Number(t.size).toFixed(2)}</td></tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-6">
        <div className="card">
          <h2 className="card-title">Evolution log</h2>
          {evo.length === 0 ? (
            <p className="text-zinc-500 text-xs">No evolution events yet. The research loop appends here when it proposes or promotes a strategy version.</p>
          ) : (
            <ul className="space-y-2">{evo.map((e) => (
              <li key={e.id} className="text-xs">
                <span className="pill-blue mr-2">{e.event_type}</span>
                <span className="text-zinc-300">{e.summary}</span>
                <span className="ml-2 text-zinc-500">{e.created_at?.slice(0, 16)}</span>
              </li>
            ))}</ul>
          )}
        </div>

        <div className="card">
          <h2 className="card-title">Today's PnL leaderboard (Polymarket)</h2>
          {"error" in (lb as any) ? (
            <p className="text-accent-red text-xs">{(lb as any).error}</p>
          ) : Array.isArray(lb) && (lb as any[]).length > 0 ? (
            <ol className="space-y-1 text-xs">
              {(lb as any[]).slice(0, 5).map((row: any, i: number) => (
                <li key={i} className="flex justify-between">
                  <span className="text-zinc-300">#{row.rank ?? i + 1} {row.userName ?? row.proxyWallet?.slice(0, 8)}</span>
                  <span className="tabular-nums text-accent-green">${Number(row.pnl ?? 0).toLocaleString()}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-zinc-500 text-xs">No leaderboard rows.</p>
          )}
        </div>
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

function renderOI(oi: unknown): string {
  if (!oi || typeof oi !== "object") return "—";
  const o = oi as any;
  if (o.error) return "error";
  const v = o.value ?? o.openInterest ?? o.amount;
  if (typeof v === "number") return `$${Math.round(v).toLocaleString()}`;
  return JSON.stringify(o).slice(0, 24);
}
