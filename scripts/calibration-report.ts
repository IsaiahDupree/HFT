/**
 * calibration-report — grade the decision gates against realized PnL.
 *
 * Joins shadow-gated entries (decision_journal → paper_trades entry → exit) and
 * draws a reliability diagram: when the gates said "0.8", did those trades win
 * ~80%? Flags over/under-confident buckets. Logs a summary to evolution_log so
 * the live loop has a running calibration record. Wired into arena-cron every
 * RESEARCH_EVERY cycles.
 *
 *   npm run calibration:report [-- --days 30 --strategy poly_fade_spike]
 */
import "./_env.ts";
import { loadLabeledDecisions } from "../src/lib/decision/calibration-loader.ts";
import { buildCalibrationReport, bucketVerdict } from "../src/lib/decision/calibration.ts";
import { insertEvolutionEvent } from "../src/lib/db/queries.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const days = Number(arg("--days") ?? 30);
const strategyKind = arg("--strategy");
const since = new Date(Date.now() - days * 86_400_000).toISOString();

const decisions = loadLabeledDecisions({ sinceTs: since, strategyKind });
const report = buildCalibrationReport(decisions);

console.log(`\ncalibration-report — gates graded against realized PnL · last ${days}d${strategyKind ? ` · ${strategyKind}` : ""}\n`);

if (report.total_labeled === 0) {
  console.log("  0 labeled decisions yet — accruing.");
  console.log("  Needs shadow-gated ENTRIES (ARENA_SHADOW_GATES=1) that have since EXITED with realized PnL.");
  console.log("  Calibration fills in as the live arena resolves positions.\n");
  insertEvolutionEvent({
    event_type: "calibration-report",
    summary: `calibration: 0 labeled decisions (last ${days}d) — accruing`,
    payload_json: JSON.stringify({ days, total_labeled: 0 }),
  });
  process.exit(0);
}

console.log(`  ${"bucket".padEnd(10)} ${"n".padEnd(5)} ${"win%".padEnd(6)} ${"err".padEnd(6)} verdict`);
for (const b of report.buckets) {
  if (b.n === 0) continue;
  const v = bucketVerdict(b, { minN: 5 });
  const win = b.actual_win_rate === null ? "—" : (b.actual_win_rate * 100).toFixed(0);
  const err = b.calibration_error === null ? "—" : b.calibration_error.toFixed(3);
  console.log(`  ${`${(b.lo * 100).toFixed(0)}-${(b.hi * 100).toFixed(0)}%`.padEnd(10)} ${String(b.n).padEnd(5)} ${win.padEnd(6)} ${err.padEnd(6)} ${v}`);
}
const verdict = report.has_problem_bucket ? "⚠ PROBLEM BUCKET — a gate band is over/under-confident" : "✓ well-calibrated";
console.log(`\n  labeled=${report.total_labeled}  weighted-error=${report.weighted_calibration_error.toFixed(3)}  ${verdict}\n`);

insertEvolutionEvent({
  event_type: "calibration-report",
  summary: `calibration: ${report.total_labeled} labeled, weighted-error ${report.weighted_calibration_error.toFixed(3)}${report.has_problem_bucket ? " ⚠ problem bucket" : " ✓"}`,
  payload_json: JSON.stringify({ days, strategyKind, total_labeled: report.total_labeled, weighted_calibration_error: report.weighted_calibration_error, has_problem_bucket: report.has_problem_bucket, buckets: report.buckets.filter((b) => b.n > 0) }),
});
process.exit(0);
