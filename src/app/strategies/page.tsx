import Link from "next/link";
import { listAllStrategies, currentVersion } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export default function StrategiesPage() {
  const rows = listAllStrategies();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Strategies</h1>
      <p className="text-zinc-400 text-sm">All strategies across every agent. Each strategy keeps a version history so changes are inspectable.</p>
      <table className="list">
        <thead>
          <tr><th>Strategy</th><th>Agent</th><th>Version</th><th>Status</th><th>Thesis</th></tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const cur = currentVersion(s.id);
            return (
              <tr key={s.id}>
                <td><Link className="text-accent-blue hover:underline" href={`/strategies/${s.agent_slug}/${s.slug}`}>{s.name}</Link></td>
                <td><Link className="text-zinc-300 hover:text-zinc-100" href={`/agents/${s.agent_slug}`}>{s.agent_name}</Link></td>
                <td className="text-zinc-300 tabular-nums">v{cur?.version ?? "?"}</td>
                <td>{s.status === "active" ? <span className="pill-green">{s.status}</span> : <span className="pill-amber">{s.status}</span>}</td>
                <td className="text-zinc-400 max-w-xl truncate">{s.thesis}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
