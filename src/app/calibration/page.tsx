/**
 * /calibration — does the decision pipeline tell the truth?
 *
 * Reads from decision_journal + paper_trades; buckets decisions by
 * approval_score; surfaces per-bucket actual vs expected win-rate.
 *
 * A perfectly calibrated pipeline shows actual_win_rate ≈ midpoint for
 * every bucket. Buckets where actual is well above midpoint mean we're
 * being too cautious (under-confident). Below midpoint means too confident
 * (over-confident).
 */
import Link from "next/link";
import { AutoRefresh } from "@/components/AutoRefresh";
import { buildCalibrationReport, bucketVerdict } from "@/lib/decision/calibration";
import { loadLabeledDecisions } from "@/lib/decision/calibration-loader";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{ strategy?: string; capsule?: string; days?: string }>;
};

const VERDICT_COLOR: Record<string, string> = {
  well_calibrated: "text-accent-green",
  over_confident: "text-accent-red",
  under_confident: "text-accent-amber",
  insufficient_data: "text-zinc-500",
};

const VERDICT_LABEL: Record<string, string> = {
  well_calibrated: "✓ calibrated",
  over_confident: "↓ overconfident",
  under_confident: "↑ underconfident",
  insufficient_data: "— more data needed",
};

export default async function CalibrationPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const strategy = params.strategy;
  const capsule = params.capsule;
  const days = Math.min(Math.max(1, Number(params.days) || 30), 365);
  const sinceTs = new Date(Date.now() - days * 86_400_000).toISOString();

  const labeled = loadLabeledDecisions({
    sinceTs,
    strategyKind: strategy,
    capsuleId: capsule,
    limit: 5000,
  });
  const report = buildCalibrationReport(labeled);

  // For the simple reliability "diagram" we'll render an ASCII-ish bar per bucket.
  function bar(value: number, max: number, width = 20): string {
    const filled = Math.round((value / Math.max(0.0001, max)) * width);
    return "█".repeat(filled).padEnd(width, "·");
  }

  return (
    <main className="space-y-6">
      <AutoRefresh intervalMs={60_000} label="calibration refresh" />

      <section className="card border-accent-blue/30">
        <h1 className="text-xl font-medium text-zinc-100 mb-1">Calibration</h1>
        <p className="text-xs text-zinc-400">
          Does the decision pipeline tell the truth? Each bucket plots actual win-rate against
          the score band&apos;s expected win-rate (midpoint). A perfectly calibrated pipeline
          shows actual ≈ expected for every bucket.
        </p>
        <div className="grid grid-cols-4 gap-3 mt-3 text-sm">
          <div>
            <div className="text-[10px] uppercase text-zinc-500">Labeled decisions</div>
            <div className="text-xl text-zinc-100 tabular-nums">{report.total_labeled}</div>
            <div className="text-[10px] text-zinc-500">in last {days}d</div>
          </div>
          <div>
            <div className="text-[10px] uppercase text-zinc-500">Weighted error</div>
            <div
              className={`text-xl tabular-nums ${
                report.weighted_calibration_error < 0.05
                  ? "text-accent-green"
                  : report.weighted_calibration_error < 0.10
                    ? "text-accent-amber"
                    : "text-accent-red"
              }`}
            >
              {(report.weighted_calibration_error * 100).toFixed(1)}%
            </div>
            <div className="text-[10px] text-zinc-500">0% = perfect</div>
          </div>
          <div>
            <div className="text-[10px] uppercase text-zinc-500">Problem buckets</div>
            <div
              className={`text-xl tabular-nums ${report.has_problem_bucket ? "text-accent-red" : "text-accent-green"}`}
            >
              {report.buckets.filter((b) => b.calibration_error !== null && b.calibration_error > 0.10).length}
            </div>
            <div className="text-[10px] text-zinc-500">error &gt; 10pp</div>
          </div>
          <div>
            <div className="text-[10px] uppercase text-zinc-500">Filter</div>
            <div className="text-xs text-zinc-300">
              {strategy ? <code>{strategy}</code> : <span className="text-zinc-500">all strategies</span>}
              {capsule ? <code className="ml-1">{capsule.slice(0, 8)}</code> : null}
            </div>
            {(strategy || capsule) && (
              <Link href="/calibration" className="text-[10px] text-accent-blue hover:underline">
                clear filters
              </Link>
            )}
          </div>
        </div>
      </section>

      <section className="card">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="card-title m-0">Reliability diagram</h2>
          <Link href="/api/calibration" className="text-xs text-zinc-500 hover:text-accent-blue">
            JSON →
          </Link>
        </div>

        {report.total_labeled === 0 ? (
          <p className="text-xs text-zinc-500 italic">
            No labeled decisions yet.{" "}
            {process.env.DECISION_PIPELINE_SHADOW !== "1" && process.env.DECISION_PIPELINE_ENABLED !== "1"
              ? "Set DECISION_PIPELINE_SHADOW=1 in .env.local to start journaling decisions."
              : "Waiting for trades to fill + exit so we have outcomes to calibrate against."}
          </p>
        ) : (
          <table className="list w-full">
            <thead>
              <tr className="text-xs text-zinc-500">
                <th className="text-left">Bucket</th>
                <th className="text-right">n</th>
                <th className="text-right">Wins</th>
                <th className="text-right">Expected</th>
                <th className="text-right">Actual</th>
                <th className="text-right">Error</th>
                <th className="text-left w-1/3">Reliability</th>
                <th className="text-left">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {report.buckets.map((b) => {
                const verdict = bucketVerdict(b);
                return (
                  <tr key={`${b.lo}-${b.hi}`} className="text-xs">
                    <td className="text-zinc-400 font-mono tabular-nums">
                      [{b.lo.toFixed(2)}, {b.hi.toFixed(2)}{b.hi === 1.0 ? "]" : ")"}
                    </td>
                    <td className="text-right text-zinc-300 tabular-nums">{b.n}</td>
                    <td className="text-right text-zinc-400 tabular-nums">{b.wins}</td>
                    <td className="text-right text-zinc-500 tabular-nums">{(b.midpoint * 100).toFixed(0)}%</td>
                    <td className="text-right text-zinc-300 tabular-nums">
                      {b.actual_win_rate === null ? "—" : `${(b.actual_win_rate * 100).toFixed(0)}%`}
                    </td>
                    <td
                      className={`text-right tabular-nums ${
                        b.calibration_error === null
                          ? "text-zinc-600"
                          : b.calibration_error < 0.05
                            ? "text-accent-green"
                            : b.calibration_error < 0.10
                              ? "text-accent-amber"
                              : "text-accent-red"
                      }`}
                    >
                      {b.calibration_error === null ? "—" : `${(b.calibration_error * 100).toFixed(0)}pp`}
                    </td>
                    <td className="text-zinc-500 font-mono text-[10px]">
                      {b.actual_win_rate === null ? "—" : bar(b.actual_win_rate, 1)}
                    </td>
                    <td className={`text-xs ${VERDICT_COLOR[verdict]}`}>{VERDICT_LABEL[verdict]}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card border-zinc-700/50">
        <h3 className="text-sm text-zinc-300 mb-2">How to read this page</h3>
        <ul className="text-xs text-zinc-400 space-y-1">
          <li>
            <span className="text-accent-green">well_calibrated</span> — pipeline&apos;s confidence matches reality.
          </li>
          <li>
            <span className="text-accent-red">overconfident</span> — pipeline says 0.85, trades win 65%. Score formula
            is too optimistic in this band; lower the gate weights or tighten thresholds.
          </li>
          <li>
            <span className="text-accent-amber">underconfident</span> — pipeline says 0.55, trades win 90%. The pipeline
            is leaving good trades on the watchlist — could raise the APPROVED_REDUCED size_multiplier or move the
            watchlist band down.
          </li>
          <li>
            <span className="text-zinc-500">insufficient_data</span> — n &lt; 5. Wait for more shadow / live decisions
            to accumulate.
          </li>
        </ul>
      </section>
    </main>
  );
}
