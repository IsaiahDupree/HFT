import { describe, it, expect } from "vitest";
import {
  assessPreflight, DEFAULT_PREFLIGHT_THRESHOLDS,
  type JournaledDecision, type PreflightThresholds,
} from "@/lib/decision/preflight";

// ── deterministic helpers ──────────────────────────────────────────────────
// Seeded LCG (numerical recipes constants). No Math.random / Date.now anywhere,
// so every randomized property is fully reproducible across runs.
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000; // [0,1)
  };
}

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);
const BUCKETS = ["APPROVED_FULL", "APPROVED_REDUCED", "WATCHLIST", "REJECTED"];

/** Healthy default journal: n rows over `spanHours`, varied scores, several buckets. */
function rows(
  n: number,
  over: Partial<{ spanHours: number; score: number | null; gates: string | null; decision: string }> = {},
): JournaledDecision[] {
  const spanH = over.spanHours ?? 30;
  return Array.from({ length: n }, (_, i) => ({
    ts: new Date(BASE + (n > 1 ? (i * spanH) / (n - 1) : 0) * 3_600_000).toISOString(),
    decision: over.decision ?? BUCKETS[i % 3],
    approval_score: over.score !== undefined ? over.score : 0.3 + (i % 6) * 0.1, // 0.3..0.8
    gate_results_json: over.gates !== undefined ? over.gates : '[{"gate":"regime","score":0.7}]',
  }));
}

/** A row at hour `h` from BASE with explicit fields. */
function row(h: number, decision: string, score: number | null, gates: string | null = '[{"g":1}]'): JournaledDecision {
  return { ts: new Date(BASE + h * 3_600_000).toISOString(), decision, approval_score: score, gate_results_json: gates };
}

const loose: PreflightThresholds = { minDecisions: 1, minHours: 0, minScoreStd: 0, maxBucketShare: 1 };

describe("assessPreflight structural invariants — properties", () => {
  it("ready is always a boolean", () => {
    for (const rs of [[], rows(1), rows(5), rows(15), rows(30)]) {
      expect(typeof assessPreflight(rs).ready).toBe("boolean");
    }
  });

  it("ready === true implies zero blockers (the contract)", () => {
    const r = assessPreflight(rows(15));
    if (r.ready) expect(r.blockers).toHaveLength(0);
    expect(r.ready).toBe(r.blockers.length === 0);
  });

  it("ready === false implies at least one blocker", () => {
    const r = assessPreflight(rows(2));
    expect(r.ready).toBe(false);
    expect(r.blockers.length).toBeGreaterThan(0);
  });

  it("ready is exactly (blockers.length === 0) across many random journals", () => {
    const rnd = lcg(12345);
    for (let t = 0; t < 40; t++) {
      const n = 1 + Math.floor(rnd() * 25);
      const rs = Array.from({ length: n }, (_, i) =>
        row(rnd() * 60, BUCKETS[Math.floor(rnd() * BUCKETS.length)], rnd() < 0.1 ? null : rnd()),
      );
      const r = assessPreflight(rs);
      expect(r.ready).toBe(r.blockers.length === 0);
    }
  });

  it("passed and blockers are disjoint and total exactly 5 gates", () => {
    const rnd = lcg(999);
    for (let t = 0; t < 30; t++) {
      const n = 1 + Math.floor(rnd() * 20);
      const rs = rows(n, n % 2 ? {} : { decision: "REJECTED" });
      const r = assessPreflight(rs);
      expect(r.passed.length + r.blockers.length).toBe(5);
      for (const p of r.passed) expect(r.blockers).not.toContain(p);
    }
  });

  it("returns the full {ready, passed, blockers, stats} shape", () => {
    const r = assessPreflight(rows(15));
    expect(Object.keys(r).sort()).toEqual(["blockers", "passed", "ready", "stats"]);
    expect(Array.isArray(r.passed)).toBe(true);
    expect(Array.isArray(r.blockers)).toBe(true);
    expect(Object.keys(r.stats).sort()).toEqual(
      ["buckets", "incomplete", "invalidScore", "n", "scoreStd", "spanHours", "topBucketShare"].sort(),
    );
  });
});

describe("assessPreflight empty + degenerate inputs — properties", () => {
  it("empty journal is NOT ready", () => {
    expect(assessPreflight([]).ready).toBe(false);
  });

  it("empty journal reports zeroed stats", () => {
    const s = assessPreflight([]).stats;
    expect(s.n).toBe(0);
    expect(s.spanHours).toBe(0);
    expect(s.incomplete).toBe(0);
    expect(s.invalidScore).toBe(0);
    expect(s.scoreStd).toBe(0);
    expect(s.topBucketShare).toBe(0);
    expect(s.buckets).toEqual({});
  });

  it("empty journal blocks on too-few decisions", () => {
    expect(assessPreflight([]).blockers.some((b) => /only 0 journaled decisions/.test(b))).toBe(true);
  });

  it("a single row has spanHours 0 (need >=2 timestamps to span)", () => {
    expect(assessPreflight(rows(1)).stats.spanHours).toBe(0);
  });

  it("single row is never ready under default thresholds (too few + no span)", () => {
    expect(assessPreflight(rows(1)).ready).toBe(false);
  });
});

describe("assessPreflight too-few-rows gate — properties", () => {
  it("n below minDecisions always yields the too-few blocker", () => {
    for (const n of [1, 3, 5, 9]) {
      const r = assessPreflight(rows(n));
      expect(r.ready).toBe(false);
      expect(r.blockers.some((b) => new RegExp(`only ${n} journaled decisions`).test(b))).toBe(true);
    }
  });

  it("exactly minDecisions rows clears the too-few gate", () => {
    const r = assessPreflight(rows(DEFAULT_PREFLIGHT_THRESHOLDS.minDecisions));
    expect(r.blockers.some((b) => /journaled decisions \(</.test(b))).toBe(false);
    expect(r.passed.some((p) => /journaled decisions \(≥/.test(p))).toBe(true);
  });

  it("minDecisions - 1 rows does NOT clear the too-few gate", () => {
    const n = DEFAULT_PREFLIGHT_THRESHOLDS.minDecisions - 1;
    expect(assessPreflight(rows(n)).passed.some((p) => /journaled decisions \(≥/.test(p))).toBe(false);
  });

  it("stats.n equals the input length exactly", () => {
    for (const n of [0, 1, 7, 20]) expect(assessPreflight(rows(Math.max(n, 0)).slice(0, n)).stats.n).toBe(n);
  });
});

describe("assessPreflight score-range gate — properties", () => {
  it("a score > 1 is flagged invalid and blocks", () => {
    const rs = rows(15); rs[4].approval_score = 1.01;
    const r = assessPreflight(rs);
    expect(r.stats.invalidScore).toBeGreaterThanOrEqual(1);
    expect(r.blockers.some((b) => /out-of-range approval_score/.test(b))).toBe(true);
  });

  it("a score < 0 is flagged invalid and blocks", () => {
    const rs = rows(15); rs[7].approval_score = -0.001;
    expect(assessPreflight(rs).blockers.some((b) => /out-of-range approval_score/.test(b))).toBe(true);
  });

  it("NaN approval_score counts as invalid (not finite)", () => {
    const rs = rows(15); rs[2].approval_score = NaN;
    expect(assessPreflight(rs).stats.invalidScore).toBeGreaterThanOrEqual(1);
  });

  it("Infinity approval_score counts as invalid", () => {
    const rs = rows(15); rs[1].approval_score = Infinity;
    expect(assessPreflight(rs).stats.invalidScore).toBeGreaterThanOrEqual(1);
  });

  it("exactly 0 and exactly 1 are in-range (boundary inclusive)", () => {
    const rs = rows(15);
    rs[0].approval_score = 0; rs[1].approval_score = 1;
    // only set two boundaries; rest stay valid → invalidScore from these is 0
    const r = assessPreflight(rs);
    expect(r.stats.invalidScore).toBe(0);
  });

  it("invalidScore counts each out-of-range row", () => {
    const rs = rows(15);
    rs[0].approval_score = 2; rs[1].approval_score = -1; rs[2].approval_score = 9;
    expect(assessPreflight(rs).stats.invalidScore).toBe(3);
  });

  it("a null score is NOT counted as invalid (it is incomplete, not out-of-range)", () => {
    const rs = rows(15); rs[5].approval_score = null;
    const r = assessPreflight(rs);
    expect(r.stats.invalidScore).toBe(0);
    expect(r.stats.incomplete).toBeGreaterThanOrEqual(1);
  });
});

describe("assessPreflight completeness gate — properties", () => {
  it("any NULL approval_score makes the journal incomplete and blocks", () => {
    const rs = rows(15); rs[8].approval_score = null;
    const r = assessPreflight(rs);
    expect(r.stats.incomplete).toBeGreaterThanOrEqual(1);
    expect(r.blockers.some((b) => /journaling is broken/.test(b))).toBe(true);
  });

  it("an empty gate_results_json string makes the journal incomplete", () => {
    const rs = rows(15); rs[3].gate_results_json = "";
    expect(assessPreflight(rs).stats.incomplete).toBeGreaterThanOrEqual(1);
  });

  it("a NULL gate_results_json makes the journal incomplete", () => {
    const rs = rows(15); rs[3].gate_results_json = null;
    expect(assessPreflight(rs).stats.incomplete).toBeGreaterThanOrEqual(1);
  });

  it("incomplete counts every broken row (null score OR missing gates)", () => {
    const rs = rows(15);
    rs[0].approval_score = null; rs[1].gate_results_json = ""; rs[2].gate_results_json = null;
    expect(assessPreflight(rs).stats.incomplete).toBe(3);
  });

  it("a fully complete journal has incomplete === 0 and clears that gate", () => {
    const r = assessPreflight(rows(15));
    expect(r.stats.incomplete).toBe(0);
    expect(r.passed.some((p) => /score \+ gate results/.test(p))).toBe(true);
  });
});

describe("assessPreflight discrimination gate — properties", () => {
  it("a stuck (zero-variance) scorer blocks even with many buckets", () => {
    const r = assessPreflight(rows(15, { score: 0.6 }));
    // constant scores → std is ~0 (tiny float residue from the variance subtraction), well below threshold
    expect(r.stats.scoreStd).toBeLessThan(DEFAULT_PREFLIGHT_THRESHOLDS.minScoreStd);
    expect(r.stats.scoreStd).toBeCloseTo(0, 12);
    expect(r.blockers.some((b) => /don't discriminate/.test(b))).toBe(true);
  });

  it("everything in one decision bucket blocks (topBucketShare === 1)", () => {
    const r = assessPreflight(rows(15, { decision: "REJECTED" }));
    expect(r.stats.topBucketShare).toBe(1);
    expect(r.blockers.some((b) => /one bucket|discriminate/.test(b))).toBe(true);
  });

  it("topBucketShare is the largest bucket count over n", () => {
    // 12 REJECTED + 3 spread → top share = 12/15
    const rs = [
      ...Array.from({ length: 12 }, (_, i) => row(i * 2, "REJECTED", 0.2 + i * 0.05)),
      row(25, "APPROVED_FULL", 0.9),
      row(26, "WATCHLIST", 0.5),
      row(27, "APPROVED_REDUCED", 0.7),
    ];
    expect(assessPreflight(rs).stats.topBucketShare).toBeCloseTo(12 / 15, 9);
  });

  it("a one-sided journal just over maxBucketShare blocks", () => {
    // 99 in one bucket, 1 in another → share 0.99 > default 0.97
    const rs = [
      ...Array.from({ length: 99 }, (_, i) => row(i * 0.5, "REJECTED", 0.1 + (i % 8) * 0.1)),
      row(60, "APPROVED_FULL", 0.95),
    ];
    const r = assessPreflight(rs);
    expect(r.stats.topBucketShare).toBeCloseTo(0.99, 9);
    expect(r.blockers.some((b) => /discriminate/.test(b))).toBe(true);
  });

  it("a balanced, varied journal clears the discrimination gate", () => {
    const r = assessPreflight(rows(30));
    expect(r.stats.scoreStd).toBeGreaterThanOrEqual(DEFAULT_PREFLIGHT_THRESHOLDS.minScoreStd);
    expect(r.stats.topBucketShare).toBeLessThanOrEqual(DEFAULT_PREFLIGHT_THRESHOLDS.maxBucketShare);
    expect(r.passed.some((p) => /gates discriminate/.test(p))).toBe(true);
  });

  it("scoreStd below threshold blocks even with multiple buckets", () => {
    // tiny variation: scores 0.50,0.51 alternating → std ≈ 0.005 < 0.05
    const rs = Array.from({ length: 20 }, (_, i) => row(i * 1.6, BUCKETS[i % 3], 0.5 + (i % 2) * 0.01));
    const r = assessPreflight(rs);
    expect(r.stats.scoreStd).toBeLessThan(DEFAULT_PREFLIGHT_THRESHOLDS.minScoreStd);
    expect(r.blockers.some((b) => /discriminate/.test(b))).toBe(true);
  });

  it("the discrimination gate also requires n >= minDecisions", () => {
    // varied + balanced but only 6 rows → fails too-few AND the discrimination n-guard
    const rs = Array.from({ length: 6 }, (_, i) => row(i * 5, BUCKETS[i % 3], 0.2 + i * 0.12));
    const r = assessPreflight(rs);
    expect(r.passed.some((p) => /gates discriminate/.test(p))).toBe(false);
  });

  it("null scores are excluded from the scoreStd computation", () => {
    // identical valid scores (std 0) + some nulls → still zero variance, still blocks
    const rs = rows(15, {}).map((r, i) => ({ ...r, approval_score: i < 3 ? null : 0.6 }));
    const r = assessPreflight(rs);
    // the remaining (non-null) scores are all identical → std ~0, blocks discrimination
    expect(r.stats.scoreStd).toBeLessThan(DEFAULT_PREFLIGHT_THRESHOLDS.minScoreStd);
    expect(r.stats.scoreStd).toBeCloseTo(0, 12);
    expect(r.blockers.some((b) => /discriminate/.test(b))).toBe(true);
  });

  it("scoreStd matches the sample standard deviation of in-range scores", () => {
    // scores 0.2,0.4,0.6,0.8 → mean 0.5, sample variance = 0.0667, std ≈ 0.2582
    const rs = [
      row(0, "REJECTED", 0.2), row(10, "WATCHLIST", 0.4),
      row(20, "APPROVED_REDUCED", 0.6), row(30, "APPROVED_FULL", 0.8),
    ];
    const expected = Math.sqrt(((0.3 ** 2) + (0.1 ** 2) + (0.1 ** 2) + (0.3 ** 2)) / 3);
    expect(assessPreflight(rs).stats.scoreStd).toBeCloseTo(expected, 9);
  });
});

describe("assessPreflight span computation — properties", () => {
  it("spanHours is (max - min) timestamp difference in hours", () => {
    const rs = [row(0, "REJECTED", 0.2), row(48, "APPROVED_FULL", 0.8), row(12, "WATCHLIST", 0.5)];
    expect(assessPreflight(rs).stats.spanHours).toBeCloseTo(48, 9);
  });

  it("span too short blocks; exactly minHours clears the gate", () => {
    const short = assessPreflight(rows(15, { spanHours: DEFAULT_PREFLIGHT_THRESHOLDS.minHours - 1 }));
    expect(short.blockers.some((b) => /spanned only/.test(b))).toBe(true);
    const exact = assessPreflight(rows(15, { spanHours: DEFAULT_PREFLIGHT_THRESHOLDS.minHours }));
    expect(exact.passed.some((p) => /shadow spanned/.test(p))).toBe(true);
  });

  it("unparseable timestamps are dropped; <2 valid → span 0", () => {
    const rs = rows(15).map((r) => ({ ...r, ts: "not-a-date" }));
    rs[0].ts = new Date(BASE).toISOString(); // one valid only
    const r = assessPreflight(rs);
    expect(r.stats.spanHours).toBe(0);
    expect(r.blockers.some((b) => /spanned only 0\.0h/.test(b))).toBe(true);
  });

  it("span ignores row order (uses min/max, not first/last)", () => {
    const a = [row(0, "R", 0.2), row(36, "A", 0.8)];
    const b = [row(36, "A", 0.8), row(0, "R", 0.2)];
    expect(assessPreflight(a).stats.spanHours).toBeCloseTo(assessPreflight(b).stats.spanHours, 9);
  });
});

describe("assessPreflight determinism + order-independence — properties", () => {
  it("is deterministic: same input → deeply equal result", () => {
    expect(assessPreflight(rows(18))).toEqual(assessPreflight(rows(18)));
  });

  it("permuting rows does not change ready/stats numbers", () => {
    const rnd = lcg(7);
    const base = Array.from({ length: 20 }, (_, i) =>
      row(i * 2, BUCKETS[i % 4], 0.1 + (i % 9) * 0.09),
    );
    const shuffled = [...base];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const a = assessPreflight(base), b = assessPreflight(shuffled);
    expect(b.ready).toBe(a.ready);
    expect(b.stats.n).toBe(a.stats.n);
    expect(b.stats.incomplete).toBe(a.stats.incomplete);
    expect(b.stats.invalidScore).toBe(a.stats.invalidScore);
    expect(b.stats.spanHours).toBeCloseTo(a.stats.spanHours, 9);
    expect(b.stats.scoreStd).toBeCloseTo(a.stats.scoreStd, 9);
    expect(b.stats.topBucketShare).toBeCloseTo(a.stats.topBucketShare, 9);
    expect(b.stats.buckets).toEqual(a.stats.buckets);
  });

  it("does not mutate the input rows array or its elements", () => {
    const rs = rows(12);
    const snapshot = JSON.stringify(rs);
    assessPreflight(rs);
    expect(JSON.stringify(rs)).toBe(snapshot);
  });
});

describe("assessPreflight threshold sensitivity — properties", () => {
  it("loosening every threshold turns a borderline journal ready", () => {
    // 6 rows, varied, 3 buckets, span ~30h: fails default minDecisions(10), passes under loose
    const rs = Array.from({ length: 6 }, (_, i) => row(i * 6, BUCKETS[i % 3], 0.2 + i * 0.12));
    expect(assessPreflight(rs).ready).toBe(false);
    expect(assessPreflight(rs, loose).ready).toBe(true);
  });

  it("raising minDecisions can only add blockers, never remove them", () => {
    const rs = rows(15);
    const easy = assessPreflight(rs, { ...DEFAULT_PREFLIGHT_THRESHOLDS, minDecisions: 5 });
    const hard = assessPreflight(rs, { ...DEFAULT_PREFLIGHT_THRESHOLDS, minDecisions: 50 });
    expect(hard.blockers.length).toBeGreaterThanOrEqual(easy.blockers.length);
  });

  it("tightening minScoreStd above the actual std introduces the discrimination blocker", () => {
    const rs = rows(15); // std ≈ 0.17
    const actual = assessPreflight(rs).stats.scoreStd;
    const tight = assessPreflight(rs, { ...DEFAULT_PREFLIGHT_THRESHOLDS, minScoreStd: actual + 0.5 });
    expect(tight.blockers.some((b) => /discriminate/.test(b))).toBe(true);
  });

  it("lowering maxBucketShare below the actual top share introduces the blocker", () => {
    const rs = rows(15);
    const share = assessPreflight(rs).stats.topBucketShare;
    const tight = assessPreflight(rs, { ...DEFAULT_PREFLIGHT_THRESHOLDS, maxBucketShare: Math.max(0, share - 0.01) });
    expect(tight.blockers.some((b) => /discriminate/.test(b))).toBe(true);
  });

  it("stats are independent of the thresholds used", () => {
    const rs = rows(15);
    const a = assessPreflight(rs, DEFAULT_PREFLIGHT_THRESHOLDS).stats;
    const b = assessPreflight(rs, loose).stats;
    expect(b).toEqual(a);
  });

  it("DEFAULT_PREFLIGHT_THRESHOLDS has the documented values", () => {
    expect(DEFAULT_PREFLIGHT_THRESHOLDS).toEqual({ minDecisions: 10, minHours: 24, minScoreStd: 0.05, maxBucketShare: 0.97 });
  });
});

describe("assessPreflight buckets accounting — properties", () => {
  it("bucket counts sum to n", () => {
    const rnd = lcg(424242);
    for (let t = 0; t < 20; t++) {
      const n = 1 + Math.floor(rnd() * 25);
      const rs = Array.from({ length: n }, (_, i) => row(i, BUCKETS[Math.floor(rnd() * BUCKETS.length)], rnd()));
      const s = assessPreflight(rs).stats;
      const total = Object.values(s.buckets).reduce((a, b) => a + b, 0);
      expect(total).toBe(n);
    }
  });

  it("each distinct decision string becomes a bucket key", () => {
    const rs = [row(0, "REJECTED", 0.2), row(10, "REJECTED", 0.4), row(20, "KILL_SWITCH", 0.9)];
    const b = assessPreflight(rs).stats.buckets;
    expect(b).toEqual({ REJECTED: 2, KILL_SWITCH: 1 });
  });

  it("topBucketShare is in [0,1]", () => {
    const rnd = lcg(2024);
    for (let t = 0; t < 15; t++) {
      const n = 1 + Math.floor(rnd() * 20);
      const rs = Array.from({ length: n }, (_, i) => row(i, BUCKETS[Math.floor(rnd() * BUCKETS.length)], rnd()));
      const share = assessPreflight(rs).stats.topBucketShare;
      expect(share).toBeGreaterThanOrEqual(0);
      expect(share).toBeLessThanOrEqual(1);
    }
  });
});
