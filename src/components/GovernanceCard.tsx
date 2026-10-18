/**
 * GovernanceCard — per-agent inline view of the gated-decision-system +
 * portfolio-governance data that's otherwise scattered across /decisions,
 * /portfolio, /calibration.
 *
 * Server component. Takes either a paperAgentId (for /arena/[id]) or a
 * strategyKind + capsule binding (for /agents/[slug]) and pulls:
 *   - Diversity profile (strategy_family / asset_class / regime / horizon / bias)
 *   - Bound capsule status + today's PnL + lifetime equity
 *   - Loss-overlap rank vs portfolio (capsule_pnl_daily-driven, last 30d)
 *   - Recent decision-journal entries (last 24h, filtered to this capsule
 *     OR strategy_kind)
 *   - Calibration filtered to this strategy_kind (last 30d)
 *   - Recent governor / cluster-killswitch / pipeline-killswitch events from
 *     evolution_log (last 7d, filtered to this capsule when available)
 *
 * If no capsule is bound, renders a minimal version with just the agent
 * metadata and notes "no capsule — not eligible for live trading."
 *
 * All queries are read-only + cheap (each is a single SELECT with a small
 * LIMIT). Designed to be safe to drop into a detail page without changing
 * page-load latency materially.
 */
import Link from "next/link";
import { db } from "@/lib/db/client";
import { buildCalibrationReport, bucketVerdict } from "@/lib/decision/calibration";
import { loadLabeledDecisions } from "@/lib/decision/calibration-loader";
import { lossOverlapScore } from "@/lib/portfolio/loss-overlap";
import type { DailyPnlPoint } from "@/lib/portfolio/correlation";

export type GovernanceCardProps = {
  /** Look up capsule by paper_agent_id (arena detail page). */
  paperAgentId?: number;
  /** Filter decisions / calibration by strategy_kind (gen-1/gen-2 detail page). */
  strategyKind?: string;
  /** Optional explicit capsule binding when caller already has it. */
  capsuleId?: string;
};

type CapsuleRow = {
  id: string;
  name: string;
  status: string;
  strategy_family: string | null;
  asset_class: string | null;
  regime_dependency: string | null;
  time_horizon: string | null;
  directional_bias: string | null;
  capital_allocated_usd: number;
  current_pnl_usd: number;
  daily_pnl_usd: number;
  max_daily_loss_usd: number;
  trades_today: number;
  paper_agent_id: number | null;
};

type DecisionRow = {
  id: number;
  ts: string;
  decision: string;
  approval_score: number;
  proposed_size_usd: number;
  approved_size_usd: number;
  symbol: string;
  side: string;
};

type EvolutionEventRow = {
  id: number;
  ts: string;
  event_type: string;
  summary: string;
};

const DECISION_COLOR: Record<string, string> = {
  APPROVED_FULL: "text-accent-green",
  APPROVED_REDUCED: "text-accent-amber",
  WATCHLIST: "text-zinc-400",
  REJECTED: "text-accent-red",
  KILL_SWITCH: "text-accent-red font-bold",
};

const EVENT_COLOR: Record<string, string> = {
  "capsule-auto-promote-vetoed": "text-accent-amber",
  "cluster-killswitch-trip": "text-accent-red",
  "decision-pipeline-killswitch": "text-accent-red font-bold",
  "capsule-auto-paused": "text-accent-amber",
  "capsule-auto-promoted": "text-accent-green",
  "capsule-auto-rebalanced": "text-zinc-400",
};

export async function GovernanceCard({
  paperAgentId,
  strategyKind,
  capsuleId,
}: GovernanceCardProps) {
  const dbHandle = db();

  // Resolve capsule binding. Three lookup paths:
  //   1. explicit capsuleId
  //   2. paper_agent_id (arena agents)
  //   3. via agents.slug + strategies for /agents/[slug] (defer to caller-supplied capsuleId)
  let capsule: CapsuleRow | null = null;
  if (capsuleId) {
    capsule = (dbHandle
      .prepare(
        `SELECT id, name, status, strategy_family, asset_class, regime_dependency,
                time_horizon, directional_bias, capital_allocated_usd,
                current_pnl_usd, daily_pnl_usd, max_daily_loss_usd,
                trades_today, paper_agent_id
           FROM capsules WHERE id = ?`,
      )
      .get(capsuleId) as CapsuleRow | undefined) ?? null;
  } else if (paperAgentId != null) {
    capsule = (dbHandle
      .prepare(
        `SELECT id, name, status, strategy_family, asset_class, regime_dependency,
                time_horizon, directional_bias, capital_allocated_usd,
                current_pnl_usd, daily_pnl_usd, max_daily_loss_usd,
                trades_today, paper_agent_id
           FROM capsules
          WHERE paper_agent_id = ?
          ORDER BY (status = 'live') DESC, (status = 'paper') DESC, updated_at DESC
          LIMIT 1`,
      )
      .get(paperAgentId) as CapsuleRow | undefined) ?? null;
  }

  // ── Decisions filter ──────────────────────────────────────────────────
  const since24hIso = new Date(Date.now() - 24 * 3600_000).toISOString();
  const since7dIso = new Date(Date.now() - 7 * 86400_000).toISOString();
  const decisionFilter: string[] = ["ts >= ?"];
  const decisionParams: unknown[] = [since24hIso];
  if (capsule) {
    decisionFilter.push("capsule_id = ?");
    decisionParams.push(capsule.id);
  } else if (strategyKind) {
    decisionFilter.push("strategy_kind = ?");
    decisionParams.push(strategyKind);
  } else {
    // No filter possible → skip decisions section.
  }
  const recentDecisions = (capsule || strategyKind)
    ? (dbHandle
        .prepare(
          `SELECT id, ts, decision, approval_score, proposed_size_usd, approved_size_usd, symbol, side
             FROM decision_journal
            WHERE ${decisionFilter.join(" AND ")}
            ORDER BY ts DESC
            LIMIT 10`,
        )
        .all(...decisionParams) as DecisionRow[])
    : [];

  const decisionCounts: Record<string, number> = {};
  for (const d of recentDecisions) decisionCounts[d.decision] = (decisionCounts[d.decision] ?? 0) + 1;

  // ── Calibration filter ────────────────────────────────────────────────
  const calibrationKind = strategyKind;
  const labeled = calibrationKind ? loadLabeledDecisions({ strategyKind: calibrationKind, limit: 500 }) : [];
  const calibrationReport = labeled.length > 0 ? buildCalibrationReport(labeled) : null;

  // ── Loss-overlap (per-capsule) ────────────────────────────────────────
  let lossOverlap: number | null = null;
  let lossOverlapRank: { rank: number; total: number } | null = null;
  if (capsule && capsule.status !== "stopped" && capsule.status !== "closed") {
    // Pull last-30d PnL series for this capsule + every active peer.
    const pnlRows = dbHandle
      .prepare(
        `SELECT capsule_id, pnl_date, daily_pnl_usd
           FROM capsule_pnl_daily
          WHERE pnl_date >= date('now', '-30 days')
          ORDER BY pnl_date ASC`,
      )
      .all() as { capsule_id: string; pnl_date: string; daily_pnl_usd: number }[];
    const seriesByCapsule = new Map<string, DailyPnlPoint[]>();
    for (const r of pnlRows) {
      const list = seriesByCapsule.get(r.capsule_id) ?? [];
      list.push({ date: r.pnl_date, pnl: r.daily_pnl_usd });
      seriesByCapsule.set(r.capsule_id, list);
    }
    const activePeers = dbHandle
      .prepare(
        `SELECT id FROM capsules
          WHERE status IN ('live','paper') AND strategy_family != 'reserve' AND id != ?`,
      )
      .all(capsule.id) as { id: string }[];

    const target = seriesByCapsule.get(capsule.id) ?? [];
    const others = activePeers.map((p) => ({
      capsuleId: p.id,
      series: seriesByCapsule.get(p.id) ?? [],
    }));
    const result = lossOverlapScore({ targetSeries: target, others, windowDays: 30 });
    lossOverlap = result.targetLossDays > 0 ? result.score : null;

    // Rank vs other active capsules — compute everyone's loss-overlap, sort.
    if (lossOverlap !== null && activePeers.length > 0) {
      const allCapsules = [capsule.id, ...activePeers.map((p) => p.id)];
      const overlaps: { id: string; score: number; lossDays: number }[] = [];
      for (const id of allCapsules) {
        const tgt = seriesByCapsule.get(id) ?? [];
        const otherList = allCapsules
          .filter((x) => x !== id)
          .map((x) => ({ capsuleId: x, series: seriesByCapsule.get(x) ?? [] }));
        const r = lossOverlapScore({ targetSeries: tgt, others: otherList, windowDays: 30 });
        overlaps.push({ id, score: r.score, lossDays: r.targetLossDays });
      }
      const ranked = overlaps
        .filter((o) => o.lossDays > 0)
        .sort((a, b) => b.score - a.score);
      const rank = ranked.findIndex((o) => o.id === capsule!.id) + 1;
      if (rank > 0) lossOverlapRank = { rank, total: ranked.length };
    }
  }

  // ── Recent governor / killswitch / lifecycle events ───────────────────
  const relevantEventTypes = [
    "cluster-killswitch-trip",
    "capsule-auto-promote-vetoed",
    "decision-pipeline-killswitch",
    "capsule-auto-paused",
    "capsule-auto-promoted",
    "capsule-auto-rebalanced",
  ];
  const placeholders = relevantEventTypes.map(() => "?").join(",");
  const governorEvents = capsule
    ? (dbHandle
        .prepare(
          `SELECT id, created_at AS ts, event_type, summary
             FROM evolution_log
            WHERE event_type IN (${placeholders})
              AND created_at >= ?
              AND (summary LIKE '%' || ? || '%' OR payload_json LIKE '%' || ? || '%')
            ORDER BY created_at DESC
            LIMIT 8`,
        )
        .all(...relevantEventTypes, since7dIso, capsule.id.slice(0, 8), capsule.id) as EvolutionEventRow[])
    : [];

  // ── Render ────────────────────────────────────────────────────────────
  const headerColor = capsule?.status === "live"
    ? "border-accent-green/30"
    : capsule?.status === "paused"
      ? "border-accent-amber/40 bg-accent-amber/5"
      : "border-accent-blue/30";

  return (
    <section className={`card ${headerColor}`}>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="card-title m-0">Governance</h2>
        <span className="text-[10px] text-zinc-500">
          per-agent view of decision pipeline + portfolio governance
        </span>
      </div>

      {!capsule && (
        <div className="text-xs text-zinc-400 mb-3">
          <span className="text-zinc-500">No bound capsule.</span>
          {" "}This agent is not eligible for live trading. Decisions + calibration below are filtered by strategy_kind when available.
        </div>
      )}

      {capsule && (
        <div className="grid grid-cols-2 gap-3 mb-4">
          {/* Diversity profile */}
          <div className="rounded border border-ink-700 p-2 bg-ink-900/50">
            <div className="text-[10px] uppercase text-zinc-500 mb-1">Diversity profile</div>
            <div className="flex flex-wrap gap-1">
              {capsule.strategy_family && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700 font-mono">
                  {capsule.strategy_family}
                </span>
              )}
              {capsule.asset_class && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700 font-mono">
                  {capsule.asset_class}
                </span>
              )}
              {capsule.regime_dependency && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700 font-mono">
                  regime: {capsule.regime_dependency}
                </span>
              )}
              {capsule.time_horizon && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700 font-mono">
                  {capsule.time_horizon}
                </span>
              )}
              {capsule.directional_bias && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700 font-mono">
                  {capsule.directional_bias}
                </span>
              )}
              {!capsule.strategy_family && (
                <span className="text-[10px] text-zinc-500 italic">
                  not inferred — run npm run infer:capsule-diversity
                </span>
              )}
            </div>
          </div>

          {/* Capsule status */}
          <div className="rounded border border-ink-700 p-2 bg-ink-900/50">
            <div className="text-[10px] uppercase text-zinc-500 mb-1">Bound capsule</div>
            <div className="text-xs">
              <Link href={`/capsules`} className="text-zinc-300 font-mono hover:text-accent-blue">
                {capsule.id.slice(0, 8)}
              </Link>{" "}
              <span
                className={
                  capsule.status === "live"
                    ? "text-accent-green"
                    : capsule.status === "paper"
                      ? "text-accent-amber"
                      : "text-zinc-500"
                }
              >
                {capsule.status}
              </span>
              <div className="text-[10px] text-zinc-500 mt-1">
                cap ${capsule.capital_allocated_usd.toFixed(2)} · today{" "}
                <span
                  className={
                    capsule.daily_pnl_usd < 0
                      ? "text-accent-red"
                      : capsule.daily_pnl_usd > 0
                        ? "text-accent-green"
                        : "text-zinc-500"
                  }
                >
                  ${capsule.daily_pnl_usd.toFixed(2)}
                </span>
                /-${capsule.max_daily_loss_usd.toFixed(2)} · {capsule.trades_today} trades ·{" "}
                lifetime ${capsule.current_pnl_usd.toFixed(2)}
                {capsule.daily_pnl_usd <= -capsule.max_daily_loss_usd && (
                  <span className="text-accent-red ml-1">(daily cap tripped)</span>
                )}
              </div>
            </div>
          </div>

          {/* Loss-overlap */}
          <div className="rounded border border-ink-700 p-2 bg-ink-900/50">
            <div className="text-[10px] uppercase text-zinc-500 mb-1">Loss-overlap with portfolio</div>
            {lossOverlap === null ? (
              <div className="text-xs text-zinc-500 italic">
                No loss days in last 30d — can&apos;t measure overlap yet.
              </div>
            ) : (
              <>
                <div
                  className={`text-lg tabular-nums ${
                    lossOverlap > 0.70
                      ? "text-accent-red"
                      : lossOverlap > 0.40
                        ? "text-accent-amber"
                        : "text-accent-green"
                  }`}
                >
                  {(lossOverlap * 100).toFixed(0)}%
                </div>
                <div className="text-[10px] text-zinc-500">
                  {lossOverlapRank && (
                    <>
                      rank #{lossOverlapRank.rank}/{lossOverlapRank.total} (most-clustered first) ·{" "}
                    </>
                  )}
                  {lossOverlap > 0.70
                    ? "redundant — not adding diversification"
                    : lossOverlap > 0.40
                      ? "moderately correlated"
                      : "losses are unique"}
                </div>
              </>
            )}
          </div>

          {/* Quick links */}
          <div className="rounded border border-ink-700 p-2 bg-ink-900/50">
            <div className="text-[10px] uppercase text-zinc-500 mb-1">Drill-down</div>
            <ul className="text-xs space-y-1">
              <li>
                <Link
                  href={`/decisions?capsule=${capsule.id}`}
                  className="text-accent-blue hover:underline"
                >
                  → all decisions for this capsule
                </Link>
              </li>
              {strategyKind && (
                <li>
                  <Link
                    href={`/calibration?strategy=${strategyKind}`}
                    className="text-accent-blue hover:underline"
                  >
                    → calibration for {strategyKind}
                  </Link>
                </li>
              )}
              <li>
                <Link href={`/portfolio`} className="text-accent-blue hover:underline">
                  → full portfolio matrix
                </Link>
              </li>
            </ul>
          </div>
        </div>
      )}

      {/* Recent decisions */}
      {(capsule || strategyKind) && (
        <div className="mb-4">
          <div className="flex items-baseline justify-between mb-1">
            <h3 className="text-xs uppercase text-zinc-500">Last 24h decisions</h3>
            <Link
              href={`/decisions${capsule ? `?capsule=${capsule.id}` : strategyKind ? `?strategy=${strategyKind}` : ""}`}
              className="text-[10px] text-accent-blue hover:underline"
            >
              view all →
            </Link>
          </div>
          {recentDecisions.length === 0 ? (
            <div className="text-xs text-zinc-500 italic">
              No decisions journaled.{" "}
              {process.env.DECISION_PIPELINE_SHADOW !== "1" && process.env.DECISION_PIPELINE_ENABLED !== "1"
                ? "Pipeline is off — set DECISION_PIPELINE_SHADOW=1 to start recording."
                : "Waiting for live-routed orders to flow through the pipeline."}
            </div>
          ) : (
            <>
              <div className="text-[11px] text-zinc-400 mb-1">
                {["APPROVED_FULL", "APPROVED_REDUCED", "WATCHLIST", "REJECTED", "KILL_SWITCH"]
                  .filter((d) => decisionCounts[d])
                  .map((d) => (
                    <span key={d} className="mr-3">
                      <span className={DECISION_COLOR[d] ?? ""}>{d}</span>{" "}
                      <span className="text-zinc-500">{decisionCounts[d]}</span>
                    </span>
                  ))}
              </div>
              <table className="list w-full text-[11px]">
                <thead>
                  <tr className="text-zinc-500">
                    <th className="text-left">Time</th>
                    <th className="text-left">Symbol</th>
                    <th className="text-right">Score</th>
                    <th className="text-right">Sized</th>
                    <th className="text-left">Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {recentDecisions.map((d) => (
                    <tr key={d.id}>
                      <td className="font-mono text-zinc-400">{d.ts.slice(11, 19)}Z</td>
                      <td className="text-zinc-400">
                        {d.symbol.slice(0, 12)} <span className="text-zinc-600">{d.side}</span>
                      </td>
                      <td
                        className={`text-right tabular-nums ${
                          d.approval_score > 0.8
                            ? "text-accent-green"
                            : d.approval_score > 0.5
                              ? "text-accent-amber"
                              : "text-accent-red"
                        }`}
                      >
                        {d.approval_score.toFixed(2)}
                      </td>
                      <td className="text-right text-zinc-400 tabular-nums">
                        ${d.proposed_size_usd.toFixed(2)}
                        {d.approved_size_usd !== d.proposed_size_usd && (
                          <span
                            className={
                              d.approved_size_usd === 0 ? "text-accent-red" : "text-accent-amber"
                            }
                          >
                            {" "}
                            → ${d.approved_size_usd.toFixed(2)}
                          </span>
                        )}
                      </td>
                      <td className={DECISION_COLOR[d.decision] ?? "text-zinc-400"}>{d.decision}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}

      {/* Calibration */}
      {calibrationReport && calibrationReport.total_labeled > 0 && (
        <div className="mb-4">
          <div className="flex items-baseline justify-between mb-1">
            <h3 className="text-xs uppercase text-zinc-500">
              Calibration{" "}
              <span className="text-zinc-600 normal-case">
                ({calibrationReport.total_labeled} labeled · last 30d)
              </span>
            </h3>
            <Link
              href={`/calibration?strategy=${strategyKind}`}
              className="text-[10px] text-accent-blue hover:underline"
            >
              view diagram →
            </Link>
          </div>
          <table className="list w-full text-[11px]">
            <thead>
              <tr className="text-zinc-500">
                <th className="text-left">Bucket</th>
                <th className="text-right">n</th>
                <th className="text-right">Expected</th>
                <th className="text-right">Actual</th>
                <th className="text-left">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {calibrationReport.buckets
                .filter((b) => b.n > 0)
                .map((b) => {
                  const v = bucketVerdict(b);
                  const vColor =
                    v === "well_calibrated"
                      ? "text-accent-green"
                      : v === "over_confident"
                        ? "text-accent-red"
                        : v === "under_confident"
                          ? "text-accent-amber"
                          : "text-zinc-500";
                  return (
                    <tr key={`${b.lo}-${b.hi}`}>
                      <td className="font-mono text-zinc-400 tabular-nums">
                        [{b.lo.toFixed(2)}, {b.hi.toFixed(2)}
                        {b.hi === 1.0 ? "]" : ")"}
                      </td>
                      <td className="text-right text-zinc-300 tabular-nums">{b.n}</td>
                      <td className="text-right text-zinc-500 tabular-nums">
                        {(b.midpoint * 100).toFixed(0)}%
                      </td>
                      <td className="text-right text-zinc-300 tabular-nums">
                        {b.actual_win_rate === null ? "—" : `${(b.actual_win_rate * 100).toFixed(0)}%`}
                      </td>
                      <td className={`text-[10px] ${vColor}`}>{v.replace(/_/g, " ")}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}

      {/* Recent governor / killswitch events */}
      {governorEvents.length > 0 && (
        <div>
          <h3 className="text-xs uppercase text-zinc-500 mb-1">Recent governor / cluster events (last 7d)</h3>
          <ul className="text-[11px] space-y-1">
            {governorEvents.map((ev) => (
              <li key={ev.id} className="flex gap-2">
                <span className="font-mono text-zinc-500 tabular-nums">
                  {ev.ts.slice(5, 16).replace("T", " ")}Z
                </span>
                <span className={`font-mono text-[10px] ${EVENT_COLOR[ev.event_type] ?? "text-zinc-400"}`}>
                  {ev.event_type}
                </span>
                <span className="text-zinc-400 truncate">{ev.summary}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
