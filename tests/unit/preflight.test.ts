import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  assessPreflight, renderPreflight, DEFAULT_PREFLIGHT_THRESHOLDS,
  isDecisionPipelineArmed, resetDecisionPipelineArmedCache, type JournaledDecision,
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

describe("isDecisionPipelineArmed — runtime arming guard", () => {
  const ENV = ["DECISION_PIPELINE_ENABLED", "ARENA_PREFLIGHT_BYPASS"];
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => { saved = {}; for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; } resetDecisionPipelineArmedCache(); });
  afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } resetDecisionPipelineArmedCache(); });

  it("NOT armed when DECISION_PIPELINE_ENABLED is unset (journal never read)", () => {
    let calls = 0;
    expect(isDecisionPipelineArmed(() => { calls++; return rows(15); })).toBe(false);
    expect(calls).toBe(0);
  });

  it("armed when ENABLED=1 and the shadow journal is READY", () => {
    process.env.DECISION_PIPELINE_ENABLED = "1";
    expect(isDecisionPipelineArmed(() => rows(15))).toBe(true);
  });

  it("NOT armed (fail-safe to shadow) when ENABLED=1 but the pre-flight is NOT_READY; onBlock fires", () => {
    process.env.DECISION_PIPELINE_ENABLED = "1";
    let blocked: { ready: boolean; blockers: string[] } | null = null;
    expect(isDecisionPipelineArmed(() => rows(3), undefined, (r) => { blocked = r; })).toBe(false);
    expect(blocked!.ready).toBe(false);
    expect(blocked!.blockers.length).toBeGreaterThan(0);
  });

  it("ARENA_PREFLIGHT_BYPASS=1 arms without touching the journal", () => {
    process.env.DECISION_PIPELINE_ENABLED = "1";
    process.env.ARENA_PREFLIGHT_BYPASS = "1";
    let calls = 0;
    expect(isDecisionPipelineArmed(() => { calls++; return rows(3); })).toBe(true);
    expect(calls).toBe(0); // bypass short-circuits before the journal scan
  });

  it("is load-once cached — the journal scan runs at most once per process", () => {
    process.env.DECISION_PIPELINE_ENABLED = "1";
    let calls = 0;
    const load = () => { calls++; return rows(15); };
    isDecisionPipelineArmed(load); isDecisionPipelineArmed(load); isDecisionPipelineArmed(load);
    expect(calls).toBe(1);
  });

  it("fail-safe: a journal read error → NOT armed", () => {
    process.env.DECISION_PIPELINE_ENABLED = "1";
    expect(isDecisionPipelineArmed(() => { throw new Error("db down"); })).toBe(false);
  });
});
