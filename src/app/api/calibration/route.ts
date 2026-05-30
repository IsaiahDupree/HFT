/**
 * JSON endpoint backing /calibration. Returns the labeled decisions +
 * report so external scripts can analyze pipeline calibration offline.
 *
 *   GET /api/calibration[?strategy=X&capsule=Y&days=30]
 */
import { NextResponse } from "next/server";
import { buildCalibrationReport } from "@/lib/decision/calibration";
import { loadLabeledDecisions } from "@/lib/decision/calibration-loader";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const strategy = url.searchParams.get("strategy") ?? undefined;
  const capsule = url.searchParams.get("capsule") ?? undefined;
  const days = Math.min(Math.max(1, Number(url.searchParams.get("days")) || 30), 365);
  const sinceTs = new Date(Date.now() - days * 86_400_000).toISOString();

  const labeled = loadLabeledDecisions({
    sinceTs,
    strategyKind: strategy ?? undefined,
    capsuleId: capsule ?? undefined,
    limit: 5000,
  });
  const report = buildCalibrationReport(labeled);

  return NextResponse.json({
    filters: { strategy, capsule, days, sinceTs },
    total_labeled: report.total_labeled,
    weighted_calibration_error: report.weighted_calibration_error,
    has_problem_bucket: report.has_problem_bucket,
    buckets: report.buckets,
  });
}
