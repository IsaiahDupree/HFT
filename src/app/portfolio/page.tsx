/**
 * /portfolio — operator surface for everything the capsule-portfolio-
 * governance PRD produced (Phases 6–9 + 11).
 *
 * One page, four sections:
 *   1. Reserve + envelope summary (total, reserve, deployable)
 *   2. Active capsules with diversity profiles
 *   3. Pair correlation matrix (from capsule_correlations daily snapshots)
 *   4. Loss-overlap ranking (which capsules' losses cluster with others')
 *
 * Read-only. Auto-refreshes every 30s.
 */
import Link from "next/link";
import { db } from "@/lib/db/client";
import { AutoRefresh } from "@/components/AutoRefresh";
import { lossOverlapScore, type LossOverlapResult } from "@/lib/portfolio/loss-overlap";
import { readGovernorThresholdsFromEnv } from "@/lib/portfolio/governor";
import type { DailyPnlPoint } from "@/lib/portfolio/correlation";

export const dynamic = "force-dynamic";

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
  daily_pnl_usd: number;
  current_pnl_usd: number;
};

type CorrelationRow = {
  capsule_a: string;
  capsule_b: string;
  pnl_corr: number | null;
  asset_overlap: number;
  loss_overlap: number;
  sample_days: number;
  verdict: string;
  low_confidence: number;
  snapshot_date: string;
};

type PnlSeriesRow = {
  capsule_id: string;
  pnl_date: string;
  daily_pnl_usd: number;
};

function fmtPct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}
function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

const VERDICT_COLOR: Record<string, string> = {
  diversified: "text-accent-green",
  correlated_safe: "text-accent-amber",
  too_similar: "text-accent-red",
};

/** Heatmap cell color from correlation value (-1..1). */
function corrColor(c: number | null): string {
  if (c === null) return "bg-zinc-800";
  if (c > 0.55) return "bg-accent-red/40";
  if (c > 0.3) return "bg-accent-amber/30";
  if (c > 0) return "bg-zinc-700";
  if (c > -0.3) return "bg-zinc-700/50";
  return "bg-accent-blue/30";
}

export default async function PortfolioPage() {
  const dbHandle = db();
  const thresholds = readGovernorThresholdsFromEnv();
  const totalAccountUsd = Number(process.env.ARENA_TOTAL_ACCOUNT_USD ?? "0");

  // 1. Capsules + reserve
  const capsules = dbHandle
    .prepare(
      `SELECT id, name, status, strategy_family, asset_class,
              regime_dependency, time_horizon, directional_bias,
              capital_allocated_usd, daily_pnl_usd, current_pnl_usd
         FROM capsules
        WHERE status IN ('live', 'paper', 'paused')
        ORDER BY status, capital_allocated_usd DESC`,
    )
    .all() as CapsuleRow[];

  const reserveCapsule = capsules.find((c) => c.strategy_family === "reserve");
  const activeCapsules = capsules.filter(
    (c) => c.strategy_family !== "reserve" && c.status !== "paused" && c.status !== "stopped",
  );
  const allocatedActive = activeCapsules.reduce((s, c) => s + c.capital_allocated_usd, 0);
  const reserveUsd = reserveCapsule?.capital_allocated_usd ?? 0;
  const totalAllocated = capsules.reduce((s, c) => s + c.capital_allocated_usd, 0);
  const deployable = Math.max(0, totalAccountUsd - reserveUsd);

  // 2. Most recent correlation snapshot
  const latestSnapshot = (dbHandle
    .prepare("SELECT MAX(snapshot_date) AS d FROM capsule_correlations")
    .get() as { d: string | null })?.d;
  const correlations: CorrelationRow[] = latestSnapshot
    ? (dbHandle
        .prepare(
          `SELECT capsule_a, capsule_b, pnl_corr, asset_overlap, loss_overlap,
                  sample_days, verdict, low_confidence, snapshot_date
             FROM capsule_correlations
            WHERE snapshot_date = ?`,
        )
        .all(latestSnapshot) as CorrelationRow[])
    : [];

  // 3. Loss-overlap per capsule (computed live from capsule_pnl_daily)
  const pnlRows = dbHandle
    .prepare(
      `SELECT capsule_id, pnl_date, daily_pnl_usd
         FROM capsule_pnl_daily
        WHERE pnl_date >= date('now', '-30 days')
        ORDER BY pnl_date ASC`,
    )
    .all() as PnlSeriesRow[];
  const seriesByCapsule = new Map<string, DailyPnlPoint[]>();
  for (const r of pnlRows) {
    const list = seriesByCapsule.get(r.capsule_id) ?? [];
    list.push({ date: r.pnl_date, pnl: r.daily_pnl_usd });
    seriesByCapsule.set(r.capsule_id, list);
  }
  const overlapByCapsule = new Map<string, LossOverlapResult>();
  for (const cap of activeCapsules) {
    const target = seriesByCapsule.get(cap.id) ?? [];
    const others = activeCapsules
      .filter((c) => c.id !== cap.id)
      .map((c) => ({ capsuleId: c.id, series: seriesByCapsule.get(c.id) ?? [] }));
    overlapByCapsule.set(cap.id, lossOverlapScore({ targetSeries: target, others, windowDays: 30 }));
  }

  // 4. Build correlation matrix lookup
  const corrLookup = new Map<string, CorrelationRow>();
  for (const r of correlations) {
    corrLookup.set(`${r.capsule_a}|${r.capsule_b}`, r);
    corrLookup.set(`${r.capsule_b}|${r.capsule_a}`, r);
  }
  const matrixCapsules = activeCapsules; // exclude reserve

  return (
    <main className="space-y-6">
      <AutoRefresh intervalMs={30_000} label="portfolio refresh" />

      {/* ─── 1. Reserve + envelope summary ──────────────────────────── */}
      <section className="card border-accent-blue/30">
        <h1 className="text-xl font-medium text-zinc-100 mb-3">Portfolio governance</h1>
        <div className="grid grid-cols-4 gap-3 text-sm">
          <div>
            <div className="text-[10px] uppercase text-zinc-500">Total account</div>
            <div className="text-xl text-zinc-100 tabular-nums">{fmtUsd(totalAccountUsd)}</div>
            <div className="text-[10px] text-zinc-500">ARENA_TOTAL_ACCOUNT_USD</div>
          </div>
          <div>
            <div className="text-[10px] uppercase text-zinc-500">Reserve (un-deployable)</div>
            <div className="text-xl text-accent-blue tabular-nums">
              {fmtUsd(reserveUsd)}
              <span className="text-xs text-zinc-500 ml-1">
                {totalAccountUsd > 0 ? fmtPct(reserveUsd / totalAccountUsd) : ""}
              </span>
            </div>
            <div className="text-[10px] text-zinc-500">
              floor {fmtPct(thresholds.reservePct)} (min 25%)
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase text-zinc-500">Allocated to active</div>
            <div className="text-xl text-accent-green tabular-nums">
              {fmtUsd(allocatedActive)}
              <span className="text-xs text-zinc-500 ml-1">
                {totalAccountUsd > 0 ? fmtPct(allocatedActive / totalAccountUsd) : ""}
              </span>
            </div>
            <div className="text-[10px] text-zinc-500">{activeCapsules.length} live/paper capsule(s)</div>
          </div>
          <div>
            <div className="text-[10px] uppercase text-zinc-500">Headroom</div>
            <div className="text-xl text-zinc-300 tabular-nums">
              {fmtUsd(Math.max(0, deployable - allocatedActive))}
            </div>
            <div className="text-[10px] text-zinc-500">deployable not yet allocated</div>
          </div>
        </div>
      </section>

      {/* ─── 2. Active capsules ──────────────────────────────────────── */}
      <section className="card">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="card-title m-0">Active capsules ({activeCapsules.length})</h2>
          <span className="text-[10px] text-zinc-500">diversity profile · today PnL · loss-overlap</span>
        </div>
        {activeCapsules.length === 0 ? (
          <p className="text-xs text-zinc-500 italic">No active capsules.</p>
        ) : (
          <table className="list w-full">
            <thead>
              <tr className="text-xs text-zinc-500">
                <th className="text-left">Capsule</th>
                <th className="text-left">Family</th>
                <th className="text-left">Regime</th>
                <th className="text-left">Horizon</th>
                <th className="text-right">Capital</th>
                <th className="text-right">Today PnL</th>
                <th className="text-right">Loss-overlap</th>
              </tr>
            </thead>
            <tbody>
              {activeCapsules.map((c) => {
                const overlap = overlapByCapsule.get(c.id);
                const overlapScore = overlap?.score ?? 0;
                return (
                  <tr key={c.id} className="text-xs">
                    <td className="font-mono text-zinc-400">
                      {c.id.slice(0, 8)} <span className="text-zinc-500 ml-1">{c.name.slice(0, 28)}</span>
                    </td>
                    <td className="text-zinc-300 font-mono">{c.strategy_family ?? "—"}</td>
                    <td className="text-zinc-400">{c.regime_dependency ?? "—"}</td>
                    <td className="text-zinc-400">{c.time_horizon ?? "—"}</td>
                    <td className="text-right tabular-nums text-zinc-300">{fmtUsd(c.capital_allocated_usd)}</td>
                    <td
                      className={`text-right tabular-nums ${c.daily_pnl_usd < 0 ? "text-accent-red" : c.daily_pnl_usd > 0 ? "text-accent-green" : "text-zinc-500"}`}
                    >
                      {fmtUsd(c.daily_pnl_usd)}
                    </td>
                    <td
                      className={`text-right tabular-nums ${overlapScore > 0.70 ? "text-accent-red" : overlapScore > 0.40 ? "text-accent-amber" : "text-zinc-400"}`}
                      title={`${overlap?.targetLossDays ?? 0} loss-days in ${overlap?.targetSampleDays ?? 0}-day window`}
                    >
                      {overlap && overlap.targetLossDays > 0 ? fmtPct(overlapScore, 0) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* ─── 3. Correlation matrix ───────────────────────────────────── */}
      <section className="card">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="card-title m-0">
            Pair correlations{" "}
            <span className="text-xs text-zinc-500 font-normal">
              {latestSnapshot ? `(snapshot ${latestSnapshot})` : "(no snapshots yet)"}
            </span>
          </h2>
          <span className="text-[10px] text-zinc-500">
            cell = pnl_corr · red &gt;0.55 (too similar) · amber &gt;0.3 · blue &lt;0 (anti-correlated)
          </span>
        </div>
        {matrixCapsules.length < 2 ? (
          <p className="text-xs text-zinc-500 italic">Need ≥2 active capsules to compute correlations.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr>
                  <th></th>
                  {matrixCapsules.map((c) => (
                    <th key={c.id} className="px-2 py-1 text-zinc-400 font-mono font-normal" title={c.name}>
                      {c.id.slice(0, 6)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrixCapsules.map((row) => (
                  <tr key={row.id}>
                    <td className="px-2 py-1 text-zinc-400 font-mono text-right" title={row.name}>
                      {row.id.slice(0, 6)}
                    </td>
                    {matrixCapsules.map((col) => {
                      if (row.id === col.id) {
                        return (
                          <td key={col.id} className="text-center p-1 bg-zinc-800 text-zinc-600">
                            —
                          </td>
                        );
                      }
                      const c = corrLookup.get(`${row.id}|${col.id}`);
                      const corr = c?.pnl_corr ?? null;
                      return (
                        <td
                          key={col.id}
                          className={`text-center p-1 ${corrColor(corr)} tabular-nums`}
                          title={
                            c
                              ? `n=${c.sample_days} · asset_overlap=${c.asset_overlap.toFixed(2)} · loss_overlap=${c.loss_overlap.toFixed(2)} · ${c.verdict}${c.low_confidence ? " (low-conf)" : ""}`
                              : "no snapshot"
                          }
                        >
                          {corr === null ? "—" : corr.toFixed(2)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {correlations.length > 0 && (
          <div className="mt-3 text-[11px] text-zinc-400">
            verdict counts:{" "}
            {(["diversified", "correlated_safe", "too_similar"] as const).map((v, i) => {
              const n = correlations.filter((c) => c.verdict === v).length;
              return (
                <span key={v} className={`${VERDICT_COLOR[v]} ${i > 0 ? "ml-3" : ""}`}>
                  {v}: {n}
                </span>
              );
            })}
          </div>
        )}
      </section>

      {/* ─── 4. Quick links + run worker prompt ──────────────────────── */}
      <section className="card border-zinc-700/50">
        <h3 className="text-sm text-zinc-300 mb-2">Tools</h3>
        <ul className="text-xs text-zinc-400 space-y-1">
          <li>
            <code className="text-zinc-300">npm run worker:portfolio-snapshot</code> — capture today&apos;s capsule
            PnL + recompute pair correlations
          </li>
          <li>
            <code className="text-zinc-300">npm run infer:capsule-diversity</code> — refresh diversity profiles
          </li>
          <li>
            <code className="text-zinc-300">npm run init:reserve-capsule</code> — rebalance the reserve floor
          </li>
          <li>
            <Link href="/decisions" className="text-accent-blue hover:underline">
              → /decisions
            </Link>{" "}
            — per-trade gate audit (decision journal)
          </li>
          <li>
            <Link href="/api/portfolio" className="text-accent-blue hover:underline">
              → /api/portfolio
            </Link>{" "}
            — JSON snapshot for offline analysis
          </li>
        </ul>
      </section>
    </main>
  );
}
