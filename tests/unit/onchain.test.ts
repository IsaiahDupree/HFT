import { describe, expect, it } from "vitest";
import { impliedPriceFromFill } from "@/lib/polymarket/onchain";
import { fill } from "../helpers/fixtures";

describe("impliedPriceFromFill — BUY (maker pays USDC)", () => {
  it.each([
    { usdcMicros: 1_000_000, shareMicros: 2_000_000, price: 0.5, shares: 2 },
    { usdcMicros: 500_000, shareMicros: 1_000_000, price: 0.5, shares: 1 },
    { usdcMicros: 270_000, shareMicros: 1_000_000, price: 0.27, shares: 1 },
    { usdcMicros: 990_000, shareMicros: 1_000_000, price: 0.99, shares: 1 },
    { usdcMicros: 10_000, shareMicros: 1_000_000, price: 0.01, shares: 1 },
    { usdcMicros: 30_000_000, shareMicros: 100_000_000, price: 0.30, shares: 100 },
    { usdcMicros: 75_000_000, shareMicros: 100_000_000, price: 0.75, shares: 100 },
  ])("USDC=$usdcMicros shares=$shareMicros → price=$price shares=$shares", ({ usdcMicros, shareMicros, price, shares }) => {
    const f = fill({ side: "BUY", makerAmountFilled: String(usdcMicros), takerAmountFilled: String(shareMicros) });
    const r = impliedPriceFromFill(f);
    expect(r).not.toBeNull();
    expect(r!.pricePerShare).toBeCloseTo(price, 4);
    expect(r!.sizeShares).toBeCloseTo(shares, 4);
    expect(r!.makerSide).toBe("BUY");
  });
});

describe("impliedPriceFromFill — SELL (maker delivers shares)", () => {
  it.each([
    { shareMicros: 2_000_000, usdcMicros: 1_000_000, price: 0.5, shares: 2 },
    { shareMicros: 100_000_000, usdcMicros: 30_000_000, price: 0.30, shares: 100 },
    { shareMicros: 100_000_000, usdcMicros: 70_000_000, price: 0.70, shares: 100 },
  ])("shares=$shareMicros USDC=$usdcMicros → price=$price shares=$shares", ({ shareMicros, usdcMicros, price, shares }) => {
    const f = fill({ side: "SELL", makerAmountFilled: String(shareMicros), takerAmountFilled: String(usdcMicros) });
    const r = impliedPriceFromFill(f);
    expect(r).not.toBeNull();
    expect(r!.pricePerShare).toBeCloseTo(price, 4);
    expect(r!.sizeShares).toBeCloseTo(shares, 4);
    expect(r!.makerSide).toBe("SELL");
  });
});

describe("impliedPriceFromFill — edge cases", () => {
  it("returns null when makerAmount is 0", () => {
    expect(impliedPriceFromFill(fill({ makerAmountFilled: "0" }))).toBeNull();
  });

  it("returns null when takerAmount is 0", () => {
    expect(impliedPriceFromFill(fill({ takerAmountFilled: "0" }))).toBeNull();
  });

  it.each([
    { side: "BUY" as const },
    { side: "SELL" as const },
  ])("propagates token id ($side)", ({ side }) => {
    const f = fill({ side, tokenId: "12345" });
    expect(impliedPriceFromFill(f)!.tokenId).toBe("12345");
  });
});
