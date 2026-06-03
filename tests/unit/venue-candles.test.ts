import { describe, it, expect } from "vitest";
import { sanitizeCandles, parseCoinbaseExchangeCandles, parseCoinbaseAdvancedCandles, type VenueCandle } from "@/lib/data/venue-candles";

const c = (start_unix: number, o: number, h: number, l: number, cl: number, v = 1): VenueCandle => ({ start_unix, open: o, high: h, low: l, close: cl, volume: v });

describe("sanitizeCandles", () => {
  it("sorts ascending by time", () => {
    expect(sanitizeCandles([c(30, 1, 1, 1, 1), c(10, 1, 1, 1, 1), c(20, 1, 1, 1, 1)]).map((x) => x.start_unix)).toEqual([10, 20, 30]);
  });
  it("dedupes by start_unix keeping the first (post-sort) occurrence", () => {
    const out = sanitizeCandles([c(10, 1, 1, 1, 1, 5), c(10, 2, 2, 2, 2, 9)]);
    expect(out).toHaveLength(1);
    expect(out[0].open).toBe(1);
  });
  it("drops non-positive OHLC and non-finite rows", () => {
    expect(sanitizeCandles([c(10, 0, 1, 1, 1)])).toHaveLength(0);       // open 0
    expect(sanitizeCandles([c(10, 1, 1, -1, 1)])).toHaveLength(0);      // low <0
    expect(sanitizeCandles([c(10, 1, NaN, 1, 1)])).toHaveLength(0);     // high NaN
    expect(sanitizeCandles([{ start_unix: NaN, open: 1, high: 1, low: 1, close: 1, volume: 1 }])).toHaveLength(0);
  });
  it("drops structurally impossible bars (high < low)", () => {
    expect(sanitizeCandles([c(10, 5, 4, 6, 5)])).toHaveLength(0);
  });
  it("drops negative volume but keeps zero volume", () => {
    expect(sanitizeCandles([c(10, 1, 1, 1, 1, -1)])).toHaveLength(0);
    expect(sanitizeCandles([c(10, 1, 1, 1, 1, 0)])).toHaveLength(1);
  });
});

describe("parseCoinbaseExchangeCandles — [time, low, high, open, close, volume]", () => {
  it("maps the Coinbase column order correctly (low before high, open third)", () => {
    const out = parseCoinbaseExchangeCandles([[1700000000, 90, 110, 95, 105, 42]]);
    expect(out[0]).toEqual({ start_unix: 1700000000, low: 90, high: 110, open: 95, close: 105, volume: 42 });
  });
  it("coerces string fields and sanitizes", () => {
    const out = parseCoinbaseExchangeCandles([["1700000000", "90", "110", "95", "105", "42"], [1700000000, 1, 1, 1, 1, 1]]);
    expect(out).toHaveLength(1); // dup time deduped
    expect(out[0].close).toBe(105);
  });
});

describe("parseCoinbaseAdvancedCandles — object form", () => {
  it("maps { start, low, high, open, close, volume } strings", () => {
    const out = parseCoinbaseAdvancedCandles([{ start: "1700000000", low: "90", high: "110", open: "95", close: "105", volume: "42" }]);
    expect(out[0]).toEqual({ start_unix: 1700000000, low: 90, high: 110, open: 95, close: 105, volume: 42 });
  });
  it("defaults missing volume to 0", () => {
    expect(parseCoinbaseAdvancedCandles([{ start: 1, low: 1, high: 1, open: 1, close: 1 }])[0].volume).toBe(0);
  });
});
