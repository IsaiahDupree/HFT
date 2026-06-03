import { describe, it, expect } from "vitest";
import {
  assessPreflight, renderPreflight, DEFAULT_PREFLIGHT_THRESHOLDS, type JournaledDecision,
} from "@/lib/decision/preflight";

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);
const BUCKETS = ["APPROVED_FULL", "APPROVED_REDUCED", "REJECTED"];

/** Healthy default: n decisions spread over `spanHours`, varied scores, 3 buckets. */
function rows(n: number, over: Partial<{ spanHours: number; score: number | null; gates: string | null; decision: string }> = {}): JournaledDecision[] {
  const spanH = over.spanHours ?? 30;
  return Array.from({ length: n }, (_, i) => ({
    ts: new Date(BASE + (n > 1 ? (i * spanH) / (n - 1) : 0) * 3_600_000).toISOString(),
    decision: over.decision ?? BUCKETS[i % 3],
    approval_score: over.score !== undefined ? over.score : 0.4 + (i % 5) * 0.1, // 0.4..0.8 → std ≈ 0.14
    gate_results_json: over.gates !== undefined ? over.gates : '[{"gate":"regime","score":0.7}]',
  }));
}

describe("assessPreflight — go-live readiness", () => {
  it("READY when enough complete, discriminating decisions span the window", () => {
    const r = assessPreflight(rows(15));
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.passed.length).toBe(5);
    expect(r.stats.n).toBe(15);
    expect(r.stats.spanHours).toBeCloseTo(30, 5);
  });

  it("NOT_READY with too few decisions", () => {
    const r = assessPreflight(rows(5));
    expect(r.ready).toBe(false);
    expect(r.blockers.some((b) => /only 5 journaled decisions/.test(b))).toBe(true);
  });

  it("NOT_READY when the shadow span is too short", () => {
    const r = assessPreflight(rows(15, { spanHours: 3 }));
    expect(r.ready).toBe(false);
    expect(r.blockers.some((b) => /spanned only 3\.0h/.test(b))).toBe(true);
  });

  it("NOT_READY when a row has NULL approval_score (broken journaling)", () => {
    const rs = rows(15); rs[0].approval_score = null;
    const r = assessPreflight(rs);
    expect(r.ready).toBe(false);
    expect(r.blockers.some((b) => /journaling is broken/.test(b))).toBe(true);
  });

  it("NOT_READY when a row has empty gate_results_json", () => {
    const rs = rows(15); rs[3].gate_results_json = "";
    expect(assessPreflight(rs).blockers.some((b) => /journaling is broken/.test(b))).toBe(true);
  });

  it("NOT_READY on an out-of-range approval_score", () => {
    const rs = rows(15); rs[2].approval_score = 1.5;
    const r = assessPreflight(rs);
    expect(r.ready).toBe(false);
    expect(r.blockers.some((b) => /out-of-range approval_score/.test(b))).toBe(true);
  });

  it("NOT_READY when the scorer is stuck (zero variance) — gates don't discriminate", () => {
    const r = assessPreflight(rows(15, { score: 0.6 }));
    expect(r.ready).toBe(false);
    expect(r.blockers.some((b) => /don't discriminate/.test(b))).toBe(true);
  });

  it("NOT_READY when ~everything lands in one decision bucket", () => {
    const r = assessPreflight(rows(15, { decision: "REJECTED" })); // varied scores but one bucket
    expect(r.ready).toBe(false);
    expect(r.blockers.some((b) => /in one bucket/.test(b))).toBe(true);
  });

  it("thresholds are configurable", () => {
    expect(assessPreflight(rows(8)).ready).toBe(false);                                            // < default 10
    expect(assessPreflight(rows(8), { ...DEFAULT_PREFLIGHT_THRESHOLDS, minDecisions: 5 }).ready).toBe(true);
  });

  it("is deterministic", () => {
    expect(assessPreflight(rows(12))).toEqual(assessPreflight(rows(12)));
  });
});

describe("renderPreflight", () => {
  it("renders a READY block with the stats line + passed/blockers", () => {
    const text = renderPreflight(assessPreflight(rows(15)));
    expect(text).toMatch(/^GO-LIVE PRE-FLIGHT: READY\n/);
    expect(text).toContain("15 decisions over 30.0h");
    expect(text).toContain("\npassed:\n+ ");
    expect(text).toMatch(/blockers:\n- none/);
  });
  it("renders NOT_READY with the blocker lines", () => {
    const text = renderPreflight(assessPreflight(rows(3)));
    expect(text).toMatch(/^GO-LIVE PRE-FLIGHT: NOT_READY\n/);
    expect(text).toMatch(/blockers:\n- only 3 journaled decisions/);
  });
});
