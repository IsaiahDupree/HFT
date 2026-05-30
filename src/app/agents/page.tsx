import Link from "next/link";
import { listAgents, listStrategiesForAgent } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export default function AgentsPage() {
  const agents = listAgents();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Agents</h1>
      <p className="text-zinc-400 text-sm">Every agent has a charter, a risk budget, and one or more versioned strategies.</p>
      <div className="grid grid-cols-2 gap-4">
        {agents.map((a) => {
          const ss = listStrategiesForAgent(a.id);
          return (
            <Link key={a.id} href={`/agents/${a.slug}`} className="card hover:border-ink-600 transition-colors">
              <div className="flex items-baseline justify-between mb-2">
                <h2 className="text-lg font-semibold">{a.name}</h2>
                <span className={a.status === "active" ? "pill-green" : "pill-amber"}>{a.status}</span>
              </div>
              <p className="text-xs text-zinc-400 leading-snug mb-3">{a.charter}</p>
              <div className="flex justify-between text-xs text-zinc-500">
                <span>Risk ${a.risk_budget_usd.toLocaleString()}</span>
                <span>{ss.length} strateg{ss.length === 1 ? "y" : "ies"}</span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
