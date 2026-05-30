import Link from "next/link";
import { getPaperAgent, lineageDescendants, lineageRoot } from "@/lib/arena/db";
import { scoreAgent } from "@/lib/arena/score";
import { parseGenome, genomeNickname } from "@/lib/arena/genome";

export const dynamic = "force-dynamic";

/**
 * Lineage tree page. Accepts any agent id in the path; walks up to the
 * root, then expands every descendant. The tree is rendered as a recursive
 * indented list with per-node fitness/PnL stats.
 */
export default async function LineagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const startId = Number(id);
  if (!Number.isFinite(startId)) return <p className="text-accent-red text-xs">invalid id</p>;
  const root = lineageRoot(startId);
  if (!root) return <p className="text-accent-red text-xs">agent {startId} not found</p>;
  const all = lineageDescendants(root.id);

  // Index by parent for tree-walking.
  const byParent = new Map<number | null, typeof all>();
  for (const a of all) {
    const key = a.parent_paper_agent_id ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(a);
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/arena/${startId}`} className="text-xs text-zinc-500 hover:text-zinc-300">← agent {startId}</Link>
        <h1 className="text-2xl font-semibold mt-1">Lineage of {root.name}</h1>
        <p className="text-xs text-zinc-500">
          Root id {root.id} · {all.length} total agents across the tree ·
          {all.filter((a) => a.alive).length} currently alive
        </p>
      </div>
      <section className="card">
        <ul className="text-xs">
          <TreeNode node={root} byParent={byParent} depth={0} />
        </ul>
      </section>
    </div>
  );
}

function TreeNode({ node, byParent, depth }: { node: any; byParent: Map<number | null, any[]>; depth: number }) {
  const children = (byParent.get(node.id) ?? []).filter((c) => c.id !== node.id);
  const score = scoreAgent(node);
  const nick = (() => { try { return genomeNickname(parseGenome(node.genome_json)); } catch { return "?"; } })();
  return (
    <li className="border-l border-ink-800/60" style={{ paddingLeft: `${depth * 16}px` }}>
      <div className="flex items-baseline gap-2 py-1">
        <span className="text-zinc-500">{"·".repeat(depth)}</span>
        <Link href={`/arena/${node.id}`} className={node.alive ? "text-zinc-100 hover:text-accent-blue" : "text-zinc-500 hover:text-zinc-300"}>
          {node.name}
        </Link>
        <span className="text-[10px] text-zinc-500">g{node.generation} · {nick} · {node.introduced_by}</span>
        <span className={`text-[10px] tabular-nums ${score.fitness >= 0 ? "text-accent-green" : "text-accent-red"}`}>
          {score.fitness >= 0 ? "+" : ""}{(score.fitness * 100).toFixed(2)}
        </span>
        <span className="text-[10px] text-zinc-500 tabular-nums">{node.trades_count}t</span>
        {!node.alive && <span className="text-[10px] text-zinc-600 italic">retired</span>}
      </div>
      {children.map((c) => (
        <ul key={c.id}><TreeNode node={c} byParent={byParent} depth={depth + 1} /></ul>
      ))}
    </li>
  );
}
