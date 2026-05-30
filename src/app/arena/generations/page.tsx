import Link from "next/link";
import { listGenerations } from "@/lib/arena/db";

export const dynamic = "force-dynamic";

export default async function GenerationsPage() {
  const gens = listGenerations(50);
  return (
    <div className="space-y-6">
      <div>
        <Link href="/arena" className="text-xs text-zinc-500 hover:text-zinc-300">← arena</Link>
        <h1 className="text-2xl font-semibold mt-1">Generations timeline</h1>
      </div>
      <table className="list">
        <thead><tr><th>Gen</th><th>Status</th><th>Started</th><th>Sealed</th><th className="text-right">N agents</th><th className="text-right">N alive</th><th>Top agent</th><th className="text-right">Top fitness</th><th>Notes</th></tr></thead>
        <tbody>
          {gens.map((g) => (
            <tr key={g.id}>
              <td>
                <Link href={`/arena/generations/${g.gen_number}`} className="text-zinc-100 hover:text-accent-blue">
                  g{g.gen_number}
                </Link>
              </td>
              <td><span className={g.sealed_at ? "pill-green" : "pill-blue"}>{g.sealed_at ? "sealed" : "open"}</span></td>
              <td className="text-xs text-zinc-500">{new Date(g.started_at).toLocaleString()}</td>
              <td className="text-xs text-zinc-500">{g.sealed_at ? new Date(g.sealed_at).toLocaleString() : "—"}</td>
              <td className="text-right tabular-nums">{g.n_agents}</td>
              <td className="text-right tabular-nums">{g.n_alive_at_seal ?? "—"}</td>
              <td className="text-zinc-400 text-xs">{g.top_paper_agent_id ? <Link className="hover:text-accent-blue" href={`/arena/${g.top_paper_agent_id}`}>#{g.top_paper_agent_id}</Link> : "—"}</td>
              <td className="text-right tabular-nums text-zinc-400">{g.top_score != null ? g.top_score.toFixed(4) : "—"}</td>
              <td className="text-xs text-zinc-500">{g.notes ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
