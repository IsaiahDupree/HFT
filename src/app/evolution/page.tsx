import { listEvolutionEvents } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export default function EvolutionPage() {
  const events = listEvolutionEvents(200);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Evolution log</h1>
        <p className="text-zinc-400 text-sm">Append-only history of strategy proposals, promotions, retirements, and scoring events.</p>
      </div>
      {events.length === 0 ? (
        <div className="card text-zinc-500 text-sm">No events yet.</div>
      ) : (
        <ol className="relative border-l border-ink-700 ml-2 space-y-4 pl-4">
          {events.map((e) => (
            <li key={e.id}>
              <div className="absolute -left-1.5 w-3 h-3 rounded-full bg-accent-blue mt-1.5" />
              <div className="text-xs text-zinc-500">{e.created_at} • {e.agent_name ?? "—"} • {e.strategy_name ?? "—"}</div>
              <div className="text-sm">
                <span className={`pill-${e.event_type === "promotion" ? "green" : e.event_type === "retirement" ? "red" : "blue"} mr-2`}>{e.event_type}</span>
                <span className="text-zinc-200">{e.summary}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
