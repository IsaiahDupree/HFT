import { describe, it, expect } from "vitest";
import { capsulePreflightCouncil } from "@/lib/arena/championship";
import type { ReplayFitnessResult } from "@/lib/arena/replay-fitness";

// capsulePreflightCouncil is PURE (maps a replay → penny-lock Proof Council verdict);
// no DB needed even though it lives in championship.ts.
const replay = (over: Partial<ReplayFitnessResult> = {}): ReplayFitnessResult => ({
  pnl_pct: 0.04, max_dd_pct: 0.08, fitness: 1, trades_count: 60, win_rate: 0.62,
  starting_cash: 1000, ending_equity: 1040, ticks: 500, ...over,
});

describe("capsulePreflightCouncil — gating a capsule's pre-flight replay", () => {
  it("APPROVES a net-positive, adequately-traded, low-drawdown replay", () => {
    const r = capsulePreflightCouncil(replay());
    expect(r.verdict).toBe("ADVOCATE_APPROVED");
    expect(r.advocate.some((a) => /net ROI \+4\.0%/.test(a))).toBe(true);
    expect(r.advocate.some((a) => /max drawdown 8\.0% within the 25% ceiling/.test(a))).toBe(true);
  });

  it("does NOT require a high win rate (an edge can win < 50% with fat winners)", () => {
    // win rate 0.45 but net positive + controlled DD → still promotable
    expect(capsulePreflightCouncil(replay({ win_rate: 0.45 })).verdict).toBe("ADVOCATE_APPROVED");
  });

  it("BLOCKS a net-negative replay (fails the deploy objective)", () => {
    const r = capsulePreflightCouncil(replay({ pnl_pct: -0.03 }));
    expect(r.verdict).toBe("REPAIR_FIRST");
    expect(r.skeptic.some((s) => /fails its own objective/.test(s))).toBe(true);
  });

  it("BLOCKS a blown-drawdown replay even when PnL is positive", () => {
    const r = capsulePreflightCouncil(replay({ pnl_pct: 0.1, max_dd_pct: 0.5 }));
    expect(r.verdict).toBe("REPAIR_FIRST");
    expect(r.skeptic.some((s) => /max drawdown 50\.0% > 25% ceiling/.test(s))).toBe(true);
  });

  it("BLOCKS a too-thin sample (win rate not yet established)", () => {
    const r = capsulePreflightCouncil(replay({ trades_count: 5 }));
    expect(r.verdict).toBe("REPAIR_FIRST");
    expect(r.skeptic.some((s) => /sample only 5 trades/.test(s))).toBe(true);
  });

  it("honors a custom drawdown ceiling + min-trades", () => {
    expect(capsulePreflightCouncil(replay({ max_dd_pct: 0.3 })).verdict).toBe("REPAIR_FIRST");                 // 30% > default 25%
    expect(capsulePreflightCouncil(replay({ max_dd_pct: 0.3 }), { ddCeil: 0.4 }).verdict).toBe("ADVOCATE_APPROVED");
    expect(capsulePreflightCouncil(replay({ trades_count: 15 })).verdict).toBe("REPAIR_FIRST");                 // 15 < default 20
    expect(capsulePreflightCouncil(replay({ trades_count: 15 }), { minTrades: 10 }).verdict).toBe("ADVOCATE_APPROVED");
  });

  it("is deterministic", () => {
    expect(capsulePreflightCouncil(replay())).toEqual(capsulePreflightCouncil(replay()));
  });
});
