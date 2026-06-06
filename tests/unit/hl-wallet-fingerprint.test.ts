import { describe, it, expect } from "vitest";
import { buildFingerprint, deterministicWinnerGuess, accuracy, permutationPValue, type Fill, type Fingerprint } from "@/lib/exec/wallet-fingerprint";

const f = (over: Partial<Fill>): Fill => ({ coin: "BTC", dir: "Open Long", sz: 1, px: 60000, closedPnl: 0, time: 1, ...over });

describe("buildFingerprint — behavioral only, no label leak", () => {
  it("does NOT expose realizedPnl or profitFactor (only behavioral fields)", () => {
    const fp = buildFingerprint([f({})]);
    expect(Object.keys(fp).sort()).toEqual(["avgNotional", "longBias", "nCoins", "nFills", "openRatio", "topCoinShare", "tradesPerDay", "winRate"].sort());
  });
  it("computes winRate from CLOSED trades, longBias from OPENs, concentration + notional", () => {
    const fills: Fill[] = [
      f({ coin: "BTC", dir: "Open Long", sz: 1, px: 100, time: 0 }),
      f({ coin: "BTC", dir: "Close Long", sz: 1, px: 110, closedPnl: 10, time: 86_400_000 }),
      f({ coin: "BTC", dir: "Open Short", sz: 1, px: 110, time: 2 * 86_400_000 }),
      f({ coin: "ETH", dir: "Close Short", sz: 1, px: 100, closedPnl: -5, time: 3 * 86_400_000 }),
    ];
    const fp = buildFingerprint(fills);
    expect(fp.winRate).toBeCloseTo(0.5, 6);     // 1 of 2 closes green
    expect(fp.longBias).toBeCloseTo(0.5, 6);    // 1 of 2 opens long
    expect(fp.openRatio).toBeCloseTo(0.5, 6);
    expect(fp.nCoins).toBe(2);
    expect(fp.topCoinShare).toBeCloseTo(3 / 4, 6); // BTC in 3 of 4
    expect(fp.tradesPerDay).toBeCloseTo(4 / 3, 4);
  });
  it("empty fills is safe", () => {
    expect(buildFingerprint([])).toMatchObject({ nFills: 0, winRate: 0, longBias: 0.5 });
  });
});

describe("deterministicWinnerGuess — encodes the steamroller-trap lesson", () => {
  const fp = (over: Partial<Fingerprint>): Fingerprint => ({ nFills: 100, tradesPerDay: 10, winRate: 0.55, longBias: 0.5, openRatio: 0.5, nCoins: 3, topCoinShare: 0.5, avgNotional: 1000, ...over });
  it("flags an EXTREME win rate (88%) as NOT trustworthy (the PF-0.54 fake)", () => {
    expect(deterministicWinnerGuess(fp({ winRate: 0.88 }))).toBe(false);
  });
  it("accepts a sustainable win rate, rejects pure HFT churn and too-few-trades", () => {
    expect(deterministicWinnerGuess(fp({ winRate: 0.55, tradesPerDay: 10 }))).toBe(true);
    expect(deterministicWinnerGuess(fp({ tradesPerDay: 500 }))).toBe(false);
    expect(deterministicWinnerGuess(fp({ nFills: 4 }))).toBe(false);
  });
});

describe("accuracy + permutationPValue", () => {
  it("accuracy is the exact-match rate", () => {
    expect(accuracy([true, false, true], [true, true, true])).toBeCloseTo(2 / 3, 6);
  });
  it("a PERFECT predictor on a balanced set is significant (low p)", () => {
    const truth = [true, false, true, false, true, false, true, false];
    const pred = [...truth];
    expect(permutationPValue(pred, truth, 2000, 1)).toBeLessThan(0.05);
  });
  it("a CHANCE predictor (constant guess) is NOT significant (high p)", () => {
    const truth = [true, false, true, false, true, false];
    const pred = truth.map(() => true); // always-winner
    expect(permutationPValue(pred, truth, 2000, 1)).toBeGreaterThan(0.2);
  });
  it("is deterministic for a fixed seed", () => {
    const truth = [true, false, true, true, false], pred = [true, true, true, false, false];
    expect(permutationPValue(pred, truth, 500, 42)).toBe(permutationPValue(pred, truth, 500, 42));
  });
});
