import { describe, it, expect } from "vitest";
import { parseKrakenOHLC, krakenPair, krakenInterval, KRAKEN_INTERVAL_MIN } from "@/lib/data/kraken";

describe("krakenPair", () => {
  it("aliases BTC→XBT and DOGE→XDG, drops the dash", () => {
    expect(krakenPair("BTC-USD")).toBe("XBTUSD");
    expect(krakenPair("DOGE-USD")).toBe("XDGUSD");
    expect(krakenPair("ETH-USD")).toBe("ETHUSD");
  });
  it("accepts slash form and is case-insensitive", () => {
    expect(krakenPair("eth/usd")).toBe("ETHUSD");
  });
  it("throws on a malformed product", () => {
    expect(() => krakenPair("BTCUSD")).toThrow();
  });
});

describe("krakenInterval", () => {
  it("maps granularity to Kraken minutes", () => {
    expect(krakenInterval("ONE_DAY")).toBe(1440);
    expect(krakenInterval("ONE_HOUR")).toBe(60);
    expect(krakenInterval("ONE_MINUTE")).toBe(1);
  });
  it("throws on an unsupported granularity", () => {
    expect(() => krakenInterval("TWO_HOUR")).toThrow();
  });
  it("every mapped interval is one of Kraken's documented values", () => {
    const valid = new Set([1, 5, 15, 30, 60, 240, 1440, 10080, 21600]);
    for (const v of Object.values(KRAKEN_INTERVAL_MIN)) expect(valid.has(v)).toBe(true);
  });
});

describe("parseKrakenOHLC — [time, open, high, low, close, vwap, volume, count]", () => {
  const ok = (rows: unknown[][]) => ({ error: [] as string[], result: { XXBTZUSD: rows, last: 1700000300 } });

  it("maps the true-OHLC row order and unwraps the non-'last' key", () => {
    const out = parseKrakenOHLC(ok([[1700000000, "100", "110", "90", "105", "103", "12.5", 7]]));
    expect(out[0]).toEqual({ start_unix: 1700000000, open: 100, high: 110, low: 90, close: 105, volume: 12.5 });
  });

  it("throws when the API reports an error", () => {
    expect(() => parseKrakenOHLC({ error: ["EQuery:Unknown asset pair"], result: {} })).toThrow(/Unknown asset pair/);
  });

  it("returns [] when result has only the 'last' cursor", () => {
    expect(parseKrakenOHLC({ error: [], result: { last: 123 } })).toEqual([]);
  });

  it("sanitizes: sorts, dedupes, drops bad rows", () => {
    const out = parseKrakenOHLC(ok([
      [1700000200, "1", "1", "1", "1", "1", "1", 1],
      [1700000000, "100", "110", "90", "105", "103", "5", 1],
      [1700000000, "999", "999", "999", "999", "999", "9", 1], // dup time
      [1700000100, "0", "1", "1", "1", "1", "1", 1],           // open 0 → dropped
    ]));
    expect(out.map((c) => c.start_unix)).toEqual([1700000000, 1700000200]);
    expect(out[0].open).toBe(100); // first dup kept
  });

  it("throws when result is missing", () => {
    expect(() => parseKrakenOHLC({ error: [] })).toThrow(/missing result/);
  });
});
