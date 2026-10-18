import Link from "next/link";
import { listCapsules } from "@/lib/capsules/store";
import { listEligibleChampionships } from "@/lib/arena/championship";
import { getPaperAgent } from "@/lib/arena/db";
import { ActivateForm } from "./ActivateForm";
import { AutoRefresh } from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export default async function CapsulesPage() {
  const capsules = listCapsules();
  const eligible = listEligibleChampionships();

  return (
    <div className="space-y-6">
      <AutoRefresh label="capsules" />
      <div>
        <h1 className="text-2xl font-semibold">Capsules</h1>
        <p className="text-zinc-400 text-sm mt-1">
          Bounded real-money envelopes per agent. Stage ladder: draft → paper → live ⇄ paused → stopped|closed.
        </p>
      </div>

      {eligible.length > 0 && (
        <section className="card border-accent-amber/40 bg-accent-amber/5">
          <h2 className="card-title text-accent-amber">🏆 Eligible championships ({eligible.length})</h2>
          <p className="text-xs text-zinc-400 mt-1">
            These paper-agent lineages won top-1 in {process.env.ARENA_CHAMPION_GENS ?? "3"} consecutive sealed generations.
            Propose a paper capsule (you can edit caps before activating to live).
          </p>
          <table className="list mt-3">
            <thead><tr><th>#</th><th>Paper agent</th><th className="text-right">Gen wins</th><th>Rationale</th><th>Capsule</th><th></th></tr></thead>
            <tbody>
              {eligible.map((c) => {
                const agent = getPaperAgent(c.paper_agent_id);
                return (
                  <tr key={c.id}>
                    <td className="text-zinc-500 text-xs">{c.id}</td>
                    <td>
                      <Link className="text-zinc-100 hover:text-accent-blue" href={`/arena/${c.paper_agent_id}`}>
                        {agent?.name ?? `#${c.paper_agent_id}`}
                      </Link>
                    </td>
                    <td className="text-right tabular-nums">{c.consecutive_gen_wins}</td>
                    <td className="text-xs text-zinc-400">{c.rationale ?? "—"}</td>
                    <td>{c.capsule_id ? <code className="text-xs">{c.capsule_id.slice(0, 8)}…</code> : <span className="text-zinc-500 text-xs">not proposed</span>}</td>
                    <td>
                      {!c.capsule_id ? (
                        <ProposeForm championshipId={c.id} />
                      ) : (
                        <span className="pill-amber">proposed</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <h2 className="card-title">Capsules ({capsules.length})</h2>
        {capsules.length === 0 ? (
          <p className="text-xs text-zinc-500">No capsules yet. Run arena ticks + evolve until a lineage qualifies, then propose above.</p>
        ) : (
          <table className="list">
            <thead><tr><th>Capsule</th><th>Status</th><th className="text-right">Allocated</th><th className="text-right">PnL</th><th className="text-right">Daily PnL</th><th className="text-right">Daily cap</th><th>Venues</th><th>Activated</th><th></th></tr></thead>
            <tbody>
              {capsules.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link className="text-zinc-100 hover:text-accent-blue" href={`/capsules/${c.id}`}>{c.name}</Link>
                    <div className="text-[10px] text-zinc-500">{c.id.slice(0, 8)}…</div>
                  </td>
                  <td><StatusPill status={c.status} /></td>
                  <td className="text-right tabular-nums">{fmtUsd(c.capital_allocated_usd)}</td>
                  <td className={`text-right tabular-nums ${c.current_pnl_usd >= 0 ? "text-accent-green" : "text-accent-red"}`}>{fmtUsd(c.current_pnl_usd)}</td>
                  <td className={`text-right tabular-nums ${c.daily_pnl_usd >= 0 ? "text-accent-green" : "text-accent-red"}`}>{fmtUsd(c.daily_pnl_usd)}</td>
                  <td className="text-right tabular-nums text-zinc-400">{fmtUsd(c.max_daily_loss_usd)}</td>
                  <td className="text-xs text-zinc-400">{c.allowed_venues.join(", ")}</td>
                  <td className="text-xs text-zinc-500">{c.activated_at ? new Date(c.activated_at).toLocaleString() : "—"}</td>
                  <td>
                    {c.status === "paper" && <ActivateForm capsuleId={c.id} />}
                    {c.status === "live" && <PauseForm capsuleId={c.id} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const cls = status === "live" ? "pill-green" : status === "paper" ? "pill-blue" : status === "paused" ? "pill-amber" : "pill-red";
  return <span className={cls}>{status}</span>;
}

function ProposeForm({ championshipId }: { championshipId: number }) {
  return (
    <form action={`/api/arena/championships/${championshipId}/propose`} method="POST" className="inline">
      <button
        type="submit"
        className="text-xs px-2 py-1 rounded bg-accent-amber/15 text-accent-amber hover:bg-accent-amber/25"
      >
        Propose ($25 capsule)
      </button>
    </form>
  );
}
function PauseForm({ capsuleId }: { capsuleId: string }) {
  return (
    <form action={`/api/capsules/${capsuleId}/pause`} method="POST" className="inline">
      <input type="hidden" name="reason" value="UI kill-switch" />
      <button
        type="submit"
        className="text-xs px-2 py-1 rounded bg-accent-amber/15 text-accent-amber hover:bg-accent-amber/25"
      >
        Kill switch (pause)
      </button>
    </form>
  );
}
