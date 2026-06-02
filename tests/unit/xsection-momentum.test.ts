import { describe, it, expect } from "vitest";
import { crossSectionalMomentumWeights, isMarketTrending, momentumSignal, type CoinCloses } from "@/lib/strategies/xsection-momentum";

const flat21 = (last: number): number[] => [...Array(20).fill(100), last]; // 21 closes; 20d return = last/100 - 1

describe("crossSectionalMomentumWeights", () => {
  it("market-neutral: longs winners, shorts losers, Σw≈0, Σ|w|=1", () => {
    const bars: CoinCloses[] = [
      { coin: "WIN", closes: flat21(130) },   // +30%
      { coin: "MID", closes: Array(21).fill(100) },
      { coin: "LOSE", closes: flat21(70) },    // −30%
      { coin: "MID2", closes: Array(21).fill(100) },
    ];
    const w = crossSectionalMomentumWeights(bars, { lookback: 20, minCoins: 4 });
    expect(w.WIN).toBeGreaterThan(0);  // momentum longs the winner
    expect(w.LOSE).toBeLessThan(0);    // shorts the loser
    expect(Math.abs(Object.values(w).reduce((a, b) => a + b, 0))).toBeLessThan(1e-9); // dollar-neutral
    expect(Object.values(w).reduce((a, b) => a + Math.abs(b), 0)).toBeCloseTo(1, 9);  // gross-normalized
  });

  it("reversal flips the sign (it's the crypto loser)", () => {
    const bars: CoinCloses[] = [
      { coin: "WIN", closes: flat21(130) }, { coin: "LOSE", closes: flat21(70) },
      { coin: "A", closes: flat21(110) }, { coin: "B", closes: flat21(90) },
    ];
    const mom = crossSectionalMomentumWeights(bars, { lookback: 20 });
    const rev = crossSectionalMomentumWeights(bars, { lookback: 20, reversal: true });
    expect(Math.sign(mom.WIN)).toBe(-Math.sign(rev.WIN));
  });

  it("returns {} below minCoins", () => {
    expect(crossSectionalMomentumWeights([{ coin: "A", closes: flat21(110) }], { minCoins: 4 })).toEqual({});
  });
});

describe("isMarketTrending / momentumSignal", () => {
  it("trending BTC → true; choppy → false", () => {
    const up = Array.from({ length: 21 }, (_, i) => 100 * 1.01 ** i);
    const chop = Array.from({ length: 21 }, (_, i) => 100 + (i % 2 === 0 ? 5 : -5));
    expect(isMarketTrending(up, 20, 0.3)).toBe(true);
    expect(isMarketTrending(chop, 20, 0.3)).toBe(false);
  });

  it("momentumSignal goes flat in chop (the trend gate)", () => {
    const chop = Array.from({ length: 21 }, (_, i) => 100 + (i % 2 === 0 ? 5 : -5));
    const bars: CoinCloses[] = [
      { coin: "A", closes: flat21(110) }, { coin: "B", closes: flat21(90) },
      { coin: "C", closes: flat21(105) }, { coin: "D", closes: flat21(95) },
    ];
    const sig = momentumSignal(bars, chop, {});
    expect(sig.trending).toBe(false);
    expect(sig.weights).toEqual({});
  });
});
