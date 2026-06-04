import { describe, it, expect } from "vitest";
import { parseBinanceKlines, parseBinanceFunding } from "@/lib/data/binance";

describe("parseBinanceKlines", () => {
  const row = (openMs: number, closeMs: number, o = 100, h = 110, l = 90, c = 105, v = 5) =>
    [openMs, String(o), String(h), String(l), String(c), String(v), closeMs, "0", 0, "0", "0", "0"];

  it("maps [openTime, o,h,l,c,v, closeTime] with ms→s and sanitizes/sorts", () => {
    const out = parseBinanceKlines([
      row(1_700_000_000_000, 1_700_086_399_999),
      row(1_699_000_000_000, 1_699_086_399_999, 50, 60, 40, 55, 9),
    ], { nowSec: 2_000_000_000 });
    expect(out.map((c) => c.start_unix)).toEqual([1_699_000_000, 1_700_000_000]);
    expect(out[1]).toMatchObject({ open: 100, high: 110, low: 90, close: 105, volume: 5 });
  });

  it("drops the in-progress candle (closeTime in the future)", () => {
    const now = 1_700_050_000;
    const out = parseBinanceKlines([
      row(1_700_000_000_000, 1_700_086_399_999), // closes after `now` → in-progress
    ], { nowSec: now });
    expect(out).toHaveLength(0);
  });

  it("drops structurally bad rows via the shared sanitizer", () => {
    const out = parseBinanceKlines([[1_700_000_000_000, "0", "1", "1", "1", "1", 1_700_086_399_999]], { nowSec: 2e9 });
    expect(out).toHaveLength(0); // open 0 → invalid
  });
});

describe("parseBinanceFunding", () => {
  it("maps fundingTime ms→s + fundingRate to number, ascending", () => {
    const out = parseBinanceFunding([
      { fundingTime: 1_700_086_400_000, fundingRate: "0.0001" },
      { fundingTime: 1_700_000_000_000, fundingRate: "-0.00005229" },
    ]);
    expect(out).toEqual([
      { time: 1_700_000_000, rate: -0.00005229 },
      { time: 1_700_086_400, rate: 0.0001 },
    ]);
  });

  it("drops rows with non-finite fields", () => {
    const out = parseBinanceFunding([
      { fundingTime: 1_700_000_000_000, fundingRate: "not-a-number" },
      { fundingTime: 1_700_086_400_000, fundingRate: "0.0002" },
    ]);
    expect(out).toEqual([{ time: 1_700_086_400, rate: 0.0002 }]);
  });

  it("handles an empty history", () => {
    expect(parseBinanceFunding([])).toEqual([]);
  });
});
