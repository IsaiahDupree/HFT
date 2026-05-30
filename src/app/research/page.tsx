import { listResearchNotes } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export default function ResearchPage() {
  const notes = listResearchNotes(100);
  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Research</h1>
        <p className="text-xs text-zinc-500">Markdown theses + confidence scores attached to agents, strategies, and markets.</p>
      </div>
      {notes.length === 0 ? (
        <div className="card">
          <p className="text-zinc-400 text-sm">No research notes yet.</p>
          <p className="text-zinc-500 text-xs mt-2">Use <code className="text-zinc-300">POST /api/research</code> or the worker script to add notes. Each note belongs to an agent and optionally a strategy or a market.</p>
        </div>
      ) : (
        <ul className="space-y-4">
          {notes.map((n) => {
            const tags: string[] = JSON.parse(n.tags_json ?? "[]");
            const sources: string[] = JSON.parse(n.source_urls_json ?? "[]");
            return (
              <li key={n.id} className="card">
                <div className="flex items-baseline justify-between mb-1">
                  <h3 className="text-lg font-medium">{n.topic}</h3>
                  <span className="text-xs text-zinc-500">{n.created_at?.slice(0, 16)} • {n.agent_name ?? "—"} • conf {(n.confidence * 100).toFixed(0)}%</span>
                </div>
                <p className="text-sm text-zinc-300 whitespace-pre-wrap">{n.body}</p>
                <div className="flex flex-wrap gap-2 mt-3">
                  {tags.map((t) => <span key={t} className="pill-blue">{t}</span>)}
                </div>
                {sources.length > 0 && (
                  <ul className="mt-2 text-xs text-zinc-500 space-y-1">
                    {sources.map((s) => <li key={s}><a href={s} target="_blank" rel="noopener noreferrer" className="hover:text-accent-blue">{s}</a></li>)}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
