import { describe, it, expect } from "vitest";
import { gradeForwardSignal, forwardTrackRecord, type RecordedSignal, type GradedSignal } from "@/lib/wallets/consensus-paper";

const rec = (over: Partial<RecordedSignal> = {}): RecordedSignal => ({ conditionId: "c", dirIdx: 0, entryPrice: 0.5, walletCount: 3, detectedTs: 1000, ...over });

describe("gradeForwardSignal — independent resolution breaks the survivorship loop", () => {
  it("WIN pays (1−entry)/entry per $1; LOSS pays −1", () => {
    const win = gradeForwardSignal(rec({ dirIdx: 0, entryPrice: 0.4 }), 0, 2000, 0); // bet outcome 0, it won, no slippage
    expect(win.won).toBe(true);
    expect(win.copyReturn).toBeCloseTo((1 - 0.4) / 0.4, 6); // +1.5
    const loss = gradeForwardSignal(rec({ dirIdx: 0, entryPrice: 0.4 }), 1, 2000, 0); // outcome 1 won → bet lost
    expect(loss.won).toBe(false);
    expect(loss.copyReturn).toBe(-1);
  });
  it("applies slippage to the entry price", () => {
    const g = gradeForwardSignal(rec({ dirIdx: 0, entryPrice: 0.5 }), 0, 2000, 100); // 1% slip
    expect(g.copyReturn).toBeCloseTo((1 - 0.505) / 0.505, 6);
  });
});

const graded = (entryPrice: number, dirIdx: 0 | 1, winningIndex: number): GradedSignal => gradeForwardSignal(rec({ entryPrice, dirIdx }), winningIndex, 2000, 0);

describe("forwardTrackRecord — the accumulating OOS verdict", () => {
  it("accumulating until minN resolved", () => {
    const g = Array.from({ length: 10 }, () => graded(0.4, 0, 0)); // all wins but only 10
    expect(forwardTrackRecord(g, { minN: 30 }).verdict).toBe("accumulating");
  });
  it("FORWARD-CONFIRMS a held high win rate + real edge over enough signals", () => {
    // 30 signals at 0.4 entry, 90% win → edge = 0.90 − 0.40 = +50pts
    const g = Array.from({ length: 30 }, (_, i) => graded(0.4, 0, i < 27 ? 0 : 1));
    const t = forwardTrackRecord(g, { minN: 30 });
    expect(t.winRate).toBeCloseTo(0.9, 5);
    expect(t.edgeVsImplied).toBeCloseTo(0.5, 5);
    expect(t.verdict).toBe("forward_confirmed");
  });
  it("REJECTS when forward win rate collapses (the survivorship was the whole edge)", () => {
    // 30 signals at 0.5 entry, 50% win → no edge vs price
    const g = Array.from({ length: 30 }, (_, i) => graded(0.5, 0, i % 2));
    expect(forwardTrackRecord(g, { minN: 30 }).verdict).toBe("rejected");
  });
  it("impliedWinRate = mean entry price; edge = winRate − implied; cumReturn compounds", () => {
    const g = [graded(0.5, 0, 0), graded(0.5, 0, 1)]; // 1 win 1 loss at 0.5
    const t = forwardTrackRecord(g, { minN: 1 });
    expect(t.impliedWinRate).toBeCloseTo(0.5, 6);
    expect(t.winRate).toBeCloseTo(0.5, 6);
    expect(t.edgeVsImplied).toBeCloseTo(0, 6);
    expect(t.cumReturn).toBeCloseTo((1 + 1) * (1 - 1) - 1, 6); // win +100% then loss −100% → −100%
  });
  it("empty track is safe", () => {
    expect(forwardTrackRecord([])).toMatchObject({ n: 0, verdict: "accumulating" });
  });
});
