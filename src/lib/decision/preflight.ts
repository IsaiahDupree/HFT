/**
 * Decision-pipeline GO-LIVE pre-flight — the automatable half of the checklist in
 * live-capsule.ts (the docstring lists it; nothing enforced it). Before an operator flips
 * DECISION_PIPELINE_ENABLED=1 (so the pipeline starts modulating REAL trades), the shadow
 * journal must show that the pipeline has actually been running, completely, and with gates
 * that DISCRIMINATE — not a stuck/degenerate scorer that would rubber-stamp everything.
 *
 * Pure + deterministic over the journaled rows; the DB query lives in scripts/go-live-check.
 * Manual items (eyeballing a sample of REJECTED / APPROVED reasons) stay with the operator.
 */

export type JournaledDecision = {
  ts: string;                      // ISO decision timestamp
  decision: string;               // APPROVED_FULL | APPROVED_REDUCED | WATCHLIST | REJECTED | KILL_SWITCH
  approval_score: number | null;
  gate_results_json: string | null;
};

export type PreflightThresholds = {
  minDecisions: number;   // enough journaled decisions to trust the shadow
  minHours: number;       // shadow must have spanned at least this long
  minScoreStd: number;    // approval_score must vary (a stuck scorer is useless)
  maxBucketShare: number; // not ~everything in one decision bucket (no discrimination)
};
export const DEFAULT_PREFLIGHT_THRESHOLDS: PreflightThresholds = {
  minDecisions: 10, minHours: 24, minScoreStd: 0.05, maxBucketShare: 0.97,
};

export type PreflightStats = {
  n: number; spanHours: number; incomplete: number; invalidScore: number;
  scoreStd: number; buckets: Record<string, number>; topBucketShare: number;
};
export type PreflightResult = { ready: boolean; passed: string[]; blockers: string[]; stats: PreflightStats };

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

export function assessPreflight(rows: JournaledDecision[], thr: PreflightThresholds = DEFAULT_PREFLIGHT_THRESHOLDS): PreflightResult {
  const n = rows.length;
  const times = rows.map((r) => Date.parse(r.ts)).filter((t) => Number.isFinite(t));
  const spanHours = times.length >= 2 ? (Math.max(...times) - Math.min(...times)) / 3_600_000 : 0;
  // "complete" mirrors the docstring's `approval_score IS NULL OR gate_results_json = ''`
  const incomplete = rows.filter((r) => r.approval_score == null || !r.gate_results_json).length;
  const invalidScore = rows.filter((r) => r.approval_score != null && (!(Number.isFinite(r.approval_score)) || r.approval_score < 0 || r.approval_score > 1)).length;
  const scores = rows.map((r) => r.approval_score).filter((s): s is number => s != null && Number.isFinite(s) && s >= 0 && s <= 1);
  const scoreStd = std(scores);
  const buckets: Record<string, number> = {};
  for (const r of rows) buckets[r.decision] = (buckets[r.decision] ?? 0) + 1;
  const topBucketShare = n > 0 ? Math.max(0, ...Object.values(buckets)) / n : 0;
  const stats: PreflightStats = { n, spanHours, incomplete, invalidScore, scoreStd, buckets, topBucketShare };

  const passed: string[] = [];
  const blockers: string[] = [];
  const gate = (ok: boolean, pass: string, block: string) => (ok ? passed : blockers).push(ok ? pass : block);

  gate(n >= thr.minDecisions, `${n} journaled decisions (≥ ${thr.minDecisions})`,
    `only ${n} journaled decisions (< ${thr.minDecisions}) — shadow hasn't run enough`);
  gate(spanHours >= thr.minHours, `shadow spanned ${spanHours.toFixed(1)}h (≥ ${thr.minHours}h)`,
    `shadow spanned only ${spanHours.toFixed(1)}h (< ${thr.minHours}h) — run it longer`);
  gate(incomplete === 0, `every decision has a score + gate results`,
    `${incomplete} decision(s) with NULL approval_score or empty gate_results_json — journaling is broken`);
  gate(invalidScore === 0, `all approval_scores in [0,1]`,
    `${invalidScore} decision(s) with an out-of-range approval_score — scorer bug`);
  // discrimination: the scorer must vary AND not dump everything in one bucket
  gate(n >= thr.minDecisions && scoreStd >= thr.minScoreStd && topBucketShare <= thr.maxBucketShare,
    `gates discriminate (score std ${scoreStd.toFixed(3)}, top bucket ${(topBucketShare * 100).toFixed(0)}%)`,
    `gates don't discriminate (score std ${scoreStd.toFixed(3)} < ${thr.minScoreStd}, or ${(topBucketShare * 100).toFixed(0)}% in one bucket) — a stuck scorer would rubber-stamp trades`);

  return { ready: blockers.length === 0, passed, blockers, stats };
}

export function renderPreflight(r: PreflightResult): string {
  const b = r.stats.buckets;
  const bucketStr = Object.keys(b).sort().map((k) => `${k}:${b[k]}`).join(" ") || "—";
  const lines = [
    `GO-LIVE PRE-FLIGHT: ${r.ready ? "READY" : "NOT_READY"}`,
    `${r.stats.n} decisions over ${r.stats.spanHours.toFixed(1)}h · score std ${r.stats.scoreStd.toFixed(3)} · buckets ${bucketStr}`,
    "",
    "passed:",
  ];
  for (const p of r.passed) lines.push(`+ ${p}`);
  if (!r.passed.length) lines.push("+ (nothing cleared)");
  lines.push("", "blockers:");
  if (r.blockers.length) for (const x of r.blockers) lines.push(`- ${x}`);
  else lines.push("- none — automatable checks pass; still eyeball a sample of REJECTED + APPROVED_FULL reasons before arming");
  return lines.join("\n");
}
