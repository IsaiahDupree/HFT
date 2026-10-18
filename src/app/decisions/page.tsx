/**
 * /decisions — operator-visible audit log of every per-trade decision the
 * pipeline has made (or would have made, in shadow mode).
 *
 * Reads from the `decision_journal` table populated by Phase 1 + 2:
 * `recordDecision()` is called by `live-capsule.ts` whenever
 * DECISION_PIPELINE_SHADOW=1 (and Phase 3 onward, also when active).
 *
 * Filter via URL search params: ?decision=REJECTED&strategy=midwindow-trajectory&capsule=0edfced5
 * (page reads these on the server; client-side filtering UI is deferred to v2)
 */
import Link from "next/link";
import { readRecentDecisions, type DecisionJournalRow } from "@/lib/decision/journal";
import { AutoRefresh } from "@/components/AutoRefresh";
import type { GateResult } from "@/lib/decision/types";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{ decision?: string; strategy?: string; capsule?: string; limit?: string }>;
};

const DECISION_COLOR: Record<string, string> = {
  APPROVED_FULL: "text-accent-green",
  APPROVED_REDUCED: "text-accent-amber",
  WATCHLIST: "text-zinc-400",
  REJECTED: "text-accent-red",
  KILL_SWITCH: "text-accent-red font-bold",
};
const DECISIONS = ["APPROVED_FULL", "APPROVED_REDUCED", "WATCHLIST", "REJECTED", "KILL_SWITCH"];

function shortTs(iso: string): string {
  try {
    return iso.slice(11, 19) + "Z";
  } catch {
    return iso;
  }
}

function parseGates(json: string): GateResult[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function topFailingGate(gates: GateResult[]): GateResult | null {
  // First gate with KILL_SWITCH / REJECT / WAIT / REDUCE_SIZE — whatever's the strongest negative signal.
  const priority: Record<string, number> = {
    KILL_SWITCH: 5,
    REJECT: 4,
    HEDGE_OR_OFFSET: 3,
    REDUCE_SIZE: 2,
    WAIT: 1,
    RECHECK: 1,
    CONTINUE: 0,
  };
  let worst: GateResult | null = null;
  let worstScore = 0;
  for (const g of gates) {
    const s = priority[g.action] ?? 0;
    if (s > worstScore) {
      worst = g;
      worstScore = s;
    }
  }
  return worst;
}

export default async function DecisionsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const decision = params.decision;
  const strategy = params.strategy;
  const capsule = params.capsule;
  const limit = Math.min(Math.max(10, Number(params.limit) || 50), 500);

  const rows = readRecentDecisions({
    limit,
    decision: decision && DECISIONS.includes(decision) ? decision : undefined,
    strategyKind: strategy,
    capsuleId: capsule,
  });

  // Counts for the header summary (independent of current filter).
  const allRecent = decision || strategy || capsule ? readRecentDecisions({ limit: 500 }) : rows;
  const counts: Record<string, number> = {};
  for (const r of allRecent) {
    counts[r.decision] = (counts[r.decision] ?? 0) + 1;
  }

  return (
    <main className="space-y-6">
      <AutoRefresh intervalMs={15_000} label="decisions refresh" />

      <section className="card border-accent-blue/30">
        <div className="flex items-baseline justify-between mb-2">
          <h1 className="text-xl font-medium text-zinc-100">Decision journal</h1>
          <span className="text-xs text-zinc-500">
            shadow mode:{" "}
            <span className={process.env.DECISION_PIPELINE_SHADOW === "1" ? "text-accent-green" : "text-zinc-500"}>
              {process.env.DECISION_PIPELINE_SHADOW === "1" ? "ON" : "off"}
            </span>
            {" · "}
            active enforcement:{" "}
            <span className={process.env.DECISION_PIPELINE_ENABLED === "1" ? "text-accent-green" : "text-zinc-500"}>
              {process.env.DECISION_PIPELINE_ENABLED === "1" ? "ON" : "off"}
            </span>
          </span>
        </div>
        <p className="text-xs text-zinc-400 mb-3">
          Every per-trade decision the pipeline has made (or would have made in shadow mode).
          Filter via URL params: ?decision=REJECTED&strategy=midwindow-trajectory
        </p>
        <div className="flex flex-wrap gap-2 text-xs">
          {DECISIONS.map((d) => {
            const active = decision === d;
            return (
              <Link
                key={d}
                href={`/decisions${active ? "" : `?decision=${d}`}`}
                className={`px-2 py-1 rounded border ${
                  active
                    ? "bg-accent-blue/20 border-accent-blue/60 text-accent-blue"
                    : "bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700"
                }`}
              >
                <span className={DECISION_COLOR[d] ?? ""}>{d}</span>
                <span className="ml-1 text-zinc-500">{counts[d] ?? 0}</span>
              </Link>
            );
          })}
          {(decision || strategy || capsule) && (
            <Link
              href="/decisions"
              className="px-2 py-1 rounded border bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-200"
            >
              clear filters
            </Link>
          )}
        </div>
      </section>

      <section className="card">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="card-title m-0">
            Recent decisions{" "}
            <span className="text-xs text-zinc-500 font-normal">
              ({rows.length} shown
              {decision ? ` · decision=${decision}` : ""}
              {strategy ? ` · strategy=${strategy}` : ""}
              {capsule ? ` · capsule=${capsule.slice(0, 8)}` : ""})
            </span>
          </h2>
          <Link href="/api/decisions" className="text-xs text-zinc-500 hover:text-accent-blue">
            JSON export →
          </Link>
        </div>

        {rows.length === 0 ? (
          <p className="text-xs text-zinc-500 italic">
            No decisions match the current filter.
            {process.env.DECISION_PIPELINE_SHADOW !== "1" && process.env.DECISION_PIPELINE_ENABLED !== "1" && (
              <>
                {" "}Set <code className="text-zinc-400">DECISION_PIPELINE_SHADOW=1</code> in .env.local and restart
                to start journaling.
              </>
            )}
          </p>
        ) : (
          <table className="list w-full">
            <thead>
              <tr className="text-xs text-zinc-500">
                <th className="text-left">Time</th>
                <th className="text-left">Capsule</th>
                <th className="text-left">Strategy</th>
                <th className="text-left">Venue / Symbol</th>
                <th className="text-right">Proposed</th>
                <th className="text-right">Approved</th>
                <th className="text-right">Score</th>
                <th className="text-left">Decision</th>
                <th className="text-left">Top failing gate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: DecisionJournalRow) => {
                const gates = parseGates(r.gate_results_json);
                const worst = topFailingGate(gates);
                return (
                  <tr key={r.id} className="text-xs">
                    <td className="text-zinc-400 font-mono">{shortTs(r.ts)}</td>
                    <td className="text-zinc-400 font-mono">
                      <Link href={`/decisions?capsule=${r.capsule_id}`} className="hover:text-accent-blue">
                        {(r.capsule_id ?? "").slice(0, 8)}
                      </Link>
                    </td>
                    <td className="text-zinc-400">
                      <Link href={`/decisions?strategy=${r.strategy_kind}`} className="hover:text-accent-blue">
                        {r.strategy_kind}
                      </Link>
                    </td>
                    <td className="text-zinc-400">
                      <span className="text-zinc-500">{r.venue}</span> · {r.symbol.slice(0, 14)}
                      <span className="text-zinc-600 ml-1">{r.side}</span>
                    </td>
                    <td className="text-right text-zinc-400 tabular-nums">
                      ${r.proposed_size_usd.toFixed(2)}
                    </td>
                    <td className="text-right text-zinc-300 tabular-nums">
                      {r.approved_size_usd === r.proposed_size_usd ? (
                        <span className="text-zinc-300">${r.approved_size_usd.toFixed(2)}</span>
                      ) : (
                        <span className={r.approved_size_usd === 0 ? "text-accent-red" : "text-accent-amber"}>
                          ${r.approved_size_usd.toFixed(2)}
                        </span>
                      )}
                    </td>
                    <td className="text-right tabular-nums">
                      <span
                        className={
                          r.approval_score > 0.8
                            ? "text-accent-green"
                            : r.approval_score > 0.5
                              ? "text-accent-amber"
                              : "text-accent-red"
                        }
                      >
                        {r.approval_score.toFixed(2)}
                      </span>
                    </td>
                    <td>
                      <span className={DECISION_COLOR[r.decision] ?? "text-zinc-400"}>{r.decision}</span>
                    </td>
                    <td className="text-zinc-500" title={worst?.reason ?? ""}>
                      {worst && worst.action !== "CONTINUE" ? (
                        <>
                          <span className="font-mono text-[10px]">{worst.gate}</span>
                          <span className="ml-1 text-[10px]">({worst.action})</span>
                        </>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
