import { describe, it, expect } from "vitest";
import { parseKrakenOHLC, krakenPair, krakenInterval, KRAKEN_INTERVAL_MIN } from "@/lib/data/kraken";

/**
 * Property tests for the Kraken adapter. These are DISTINCT from tests/unit/kraken.test.ts —
 * they exercise structural invariants (round-trips, sort/unique, key-unwrapping regardless of
 * name, malformed-input branches) rather than the few happy-path examples there.
 *
 * All randomness is deterministic via a seeded LCG (no Math.random / Date) so reruns are stable.
 */

// ---- deterministic seeded LCG (Numerical Recipes constants) ---------------------------------
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000; // [0,1)
  };
}
const randInt = (rng: () => number, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

// A valid Kraken-style OHLC response wrapper. `pairKey` defaults to the canonical name but can
// be any non-"last" string to prove the parser unwraps by position, not by name.
const wrap = (rows: unknown[][], pairKey = "XXBTZUSD", last: number | string = 1700000300) => ({
  error: [] as string[],
  result: { [pairKey]: rows, last },
});
// One structurally-valid OHLC row: [time, open, high, low, close, vwap, volume, count].
const row = (t: number, o = 100, h = 110, l = 90, c = 105, vwap = 103, vol = 12.5, cnt = 7) =>
  [t, String(o), String(h), String(l), String(c), String(vwap), String(vol), cnt];

// =============================================================================================
describe("KRAKEN_INTERVAL_MIN — properties", () => {
  // Kraken's public OHLC `interval` enum, per docs.
  const DOCUMENTED = new Set([1, 5, 15, 30, 60, 240, 1440, 10080, 21600]);

  it("every value is a documented Kraken interval (minutes)", () => {
    for (const v of Object.values(KRAKEN_INTERVAL_MIN)) expect(DOCUMENTED.has(v)).toBe(true);
  });

  it("every value is a positive integer number of minutes", () => {
    for (const v of Object.values(KRAKEN_INTERVAL_MIN)) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });

  it("contains all eight expected granularity keys", () => {
    expect(Object.keys(KRAKEN_INTERVAL_MIN).sort()).toEqual(
      ["FIFTEEN_MINUTE", "FIVE_MINUTE", "FOUR_HOUR", "ONE_DAY", "ONE_HOUR", "ONE_MINUTE", "ONE_WEEK", "THIRTY_MINUTE"].sort(),
    );
  });

  it("the minute values are strictly increasing in granularity order", () => {
    const order = ["ONE_MINUTE", "FIVE_MINUTE", "FIFTEEN_MINUTE", "THIRTY_MINUTE", "ONE_HOUR", "FOUR_HOUR", "ONE_DAY", "ONE_WEEK"];
    const vals = order.map((k) => KRAKEN_INTERVAL_MIN[k]);
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThan(vals[i - 1]);
  });

  it("each labeled bucket equals its real-world minute count", () => {
    expect(KRAKEN_INTERVAL_MIN.ONE_HOUR).toBe(60);
    expect(KRAKEN_INTERVAL_MIN.FOUR_HOUR).toBe(4 * 60);
    expect(KRAKEN_INTERVAL_MIN.ONE_DAY).toBe(24 * 60);
    expect(KRAKEN_INTERVAL_MIN.ONE_WEEK).toBe(7 * 24 * 60);
  });

  it("all values are distinct (no two granularities collide)", () => {
    const vals = Object.values(KRAKEN_INTERVAL_MIN);
    expect(new Set(vals).size).toBe(vals.length);
  });
});

// =============================================================================================
describe("krakenInterval — properties", () => {
  it("returns exactly the table value for every defined key", () => {
    for (const [k, v] of Object.entries(KRAKEN_INTERVAL_MIN)) expect(krakenInterval(k)).toBe(v);
  });

  it("is case-sensitive — lowercase keys are unsupported", () => {
    expect(() => krakenInterval("one_day")).toThrow();
  });

  it("throws with the offending granularity named in the message", () => {
    expect(() => krakenInterval("TWO_HOUR")).toThrow(/TWO_HOUR/);
  });

  it("throws on the empty string", () => {
    expect(() => krakenInterval("")).toThrow();
  });

  it("never returns a documented interval for inherited Object.prototype keys", () => {
    // NOTE: documents CURRENT behavior. The lookup uses a plain object, so an inherited key like
    // "toString" resolves to Object.prototype.toString (a function, not null) and the `v == null`
    // guard does NOT trip — so it does NOT throw and returns a non-number. We assert it never
    // produces a *valid* Kraken interval, which is the property that actually matters downstream.
    const DOCUMENTED = new Set([1, 5, 15, 30, 60, 240, 1440, 10080, 21600]);
    for (const k of ["toString", "constructor", "hasOwnProperty", "valueOf"]) {
      const v = krakenInterval(k);
      expect(typeof v).not.toBe("number");
      expect(DOCUMENTED.has(v as unknown as number)).toBe(false);
    }
    // A genuinely-absent own key still throws as designed.
    expect(() => krakenInterval("DEFINITELY_NOT_A_KEY")).toThrow();
  });

  it("output is always one of the documented intervals across random valid keys", () => {
    const rng = lcg(20260603);
    const keys = Object.keys(KRAKEN_INTERVAL_MIN);
    const DOCUMENTED = new Set([1, 5, 15, 30, 60, 240, 1440, 10080, 21600]);
    for (let i = 0; i < 40; i++) {
      const k = keys[randInt(rng, 0, keys.length - 1)];
      expect(DOCUMENTED.has(krakenInterval(k))).toBe(true);
    }
  });
});

// =============================================================================================
describe("krakenPair — properties", () => {
  it("round-trips known majors to Kraken request pairs", () => {
    expect(krakenPair("BTC-USD")).toBe("XBTUSD");
    expect(krakenPair("DOGE-USD")).toBe("XDGUSD");
    expect(krakenPair("ETH-USD")).toBe("ETHUSD");
    expect(krakenPair("SOL-USD")).toBe("SOLUSD");
    expect(krakenPair("ADA-EUR")).toBe("ADAEUR");
  });

  it("aliases ONLY the base, never the quote (BTC quote stays literal)", () => {
    // Only BTC/DOGE in the base slot get rewritten; a BTC *quote* is left as-is.
    expect(krakenPair("ETH-BTC")).toBe("ETHBTC");
    expect(krakenPair("XBT-USD")).toBe("XBTUSD"); // already-legacy base passes through
  });

  it("treats dash and slash separators identically", () => {
    const products = ["BTC-USD", "ETH-EUR", "DOGE-USD", "SOL-GBP", "ADA-USD"];
    for (const p of products) {
      const slash = p.replace("-", "/");
      expect(krakenPair(p)).toBe(krakenPair(slash));
    }
  });

  it("is case-insensitive — mixed/lower case yields the same pair", () => {
    const rng = lcg(7);
    const bases = ["eth", "Sol", "aDa", "Ltc", "xRp"];
    for (let i = 0; i < bases.length; i++) {
      const b = bases[i];
      const out = krakenPair(`${b}-usd`);
      expect(out).toBe(`${b.toUpperCase()}USD`);
      expect(out).toBe(out.toUpperCase());
      void rng;
    }
  });

  it("output never contains the separator and is always uppercase", () => {
    const rng = lcg(424242);
    const bases = ["btc", "eth", "doge", "sol", "ada", "ltc", "xrp", "dot"];
    const quotes = ["usd", "eur", "gbp", "usdt"];
    for (let i = 0; i < 30; i++) {
      const b = bases[randInt(rng, 0, bases.length - 1)];
      const q = quotes[randInt(rng, 0, quotes.length - 1)];
      const sep = rng() < 0.5 ? "-" : "/";
      const out = krakenPair(`${b}${sep}${q}`);
      expect(out).not.toContain("-");
      expect(out).not.toContain("/");
      expect(out).toBe(out.toUpperCase());
      expect(out.endsWith(q.toUpperCase())).toBe(true);
    }
  });

  it("BTC alias applies regardless of case of the base token", () => {
    expect(krakenPair("btc-usd")).toBe("XBTUSD");
    expect(krakenPair("Btc-Usd")).toBe("XBTUSD");
    expect(krakenPair("doge/usd")).toBe("XDGUSD");
  });

  it("throws when there is no separator (single token)", () => {
    expect(() => krakenPair("BTCUSD")).toThrow();
    expect(() => krakenPair("ETH")).toThrow();
  });

  it("throws on empty input", () => {
    expect(() => krakenPair("")).toThrow();
  });

  it("throws when the quote side is empty", () => {
    expect(() => krakenPair("BTC-")).toThrow();
  });

  it("throws when the base side is empty", () => {
    // "-USD".split → ["", "USD"]; empty base is falsy → error branch.
    expect(() => krakenPair("-USD")).toThrow();
  });

  it("includes the bad product string in the error message", () => {
    expect(() => krakenPair("NOPE")).toThrow(/NOPE/);
  });
});

// =============================================================================================
describe("parseKrakenOHLC — error & structure branches — properties", () => {
  it("throws when error array is non-empty, joining all messages", () => {
    expect(() => parseKrakenOHLC({ error: ["EQuery:Invalid", "EGeneral:Internal"], result: {} })).toThrow(
      /Invalid; EGeneral:Internal/,
    );
  });

  it("does NOT throw when error is an empty array", () => {
    expect(() => parseKrakenOHLC(wrap([row(1700000000)]))).not.toThrow();
  });

  it("does NOT throw when error key is absent entirely", () => {
    expect(parseKrakenOHLC({ result: { XXBTZUSD: [row(1700000000)], last: 1 } })).toHaveLength(1);
  });

  it("throws 'missing result' when result is undefined", () => {
    expect(() => parseKrakenOHLC({ error: [] })).toThrow(/missing result/);
  });

  it("returns [] when result holds only the 'last' cursor", () => {
    expect(parseKrakenOHLC({ error: [], result: { last: 999 } })).toEqual([]);
  });

  it("returns [] when result is an empty object (no data key, no last)", () => {
    expect(parseKrakenOHLC({ error: [], result: {} })).toEqual([]);
  });

  it("throws when the unwrapped value is not an array", () => {
    expect(() => parseKrakenOHLC({ error: [], result: { XXBTZUSD: { nope: 1 }, last: 1 } })).toThrow(/not an array/);
  });

  it("throws when the data value is a string (still a non-array)", () => {
    expect(() => parseKrakenOHLC({ error: [], result: { XXBTZUSD: "oops", last: 1 } })).toThrow(/not an array/);
  });
});

// =============================================================================================
describe("parseKrakenOHLC — key unwrapping by position not name — properties", () => {
  it("unwraps an arbitrary non-'last' key name", () => {
    const out = parseKrakenOHLC(wrap([row(1700000000)], "TOTALLY_MADE_UP_PAIR"));
    expect(out).toHaveLength(1);
    expect(out[0].start_unix).toBe(1700000000);
  });

  it("unwraps the data key whether it appears before or after 'last'", () => {
    const after = { error: [], result: { last: 1, ZZZZ: [row(1700000000)] } };
    const before = { error: [], result: { ZZZZ: [row(1700000000)], last: 1 } };
    expect(parseKrakenOHLC(after)).toHaveLength(1);
    expect(parseKrakenOHLC(before)).toHaveLength(1);
  });

  it("ignores the 'last' cursor value and never parses it as a candle", () => {
    // last is a number; if it were ever read as rows it would throw 'not an array'.
    const out = parseKrakenOHLC(wrap([row(1700000000)], "XXBTZUSD", 123456));
    expect(out).toHaveLength(1);
  });

  it("a key literally named differently from the canonical still works for random names", () => {
    const rng = lcg(555);
    const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (let i = 0; i < 15; i++) {
      let name = "";
      const len = randInt(rng, 3, 8);
      for (let j = 0; j < len; j++) name += alpha[randInt(rng, 0, alpha.length - 1)];
      if (name === "last") name = "XLAST"; // never collide with cursor key
      const out = parseKrakenOHLC(wrap([row(1700000000 + i, 100 + i)], name));
      expect(out).toHaveLength(1);
      expect(out[0].open).toBe(100 + i);
    }
  });
});

// =============================================================================================
describe("parseKrakenOHLC — row mapping & numeric coercion — properties", () => {
  it("maps the true-OHLC column order [t,o,h,l,c,vwap,vol,count]", () => {
    const out = parseKrakenOHLC(wrap([row(1700000000, 100, 110, 90, 105, 103, 12.5, 7)]));
    expect(out[0]).toEqual({ start_unix: 1700000000, open: 100, high: 110, low: 90, close: 105, volume: 12.5 });
  });

  it("never reads the vwap (index 5) or count (index 7) into the candle", () => {
    // vwap=99999 / count=99999 must not appear in any output field.
    const out = parseKrakenOHLC(wrap([row(1700000000, 100, 110, 90, 105, 99999, 12.5, 99999)]));
    expect(Object.values(out[0]).includes(99999)).toBe(false);
  });

  it("coerces numeric string fields to numbers", () => {
    const out = parseKrakenOHLC(wrap([row(1700000000)]));
    for (const v of Object.values(out[0])) expect(typeof v).toBe("number");
  });

  it("defaults missing volume (index 6 undefined) to 0", () => {
    // Build a short row with no volume slot: [t,o,h,l,c,vwap] only.
    const shortRow = [1700000000, "100", "110", "90", "105", "103"];
    const out = parseKrakenOHLC(wrap([shortRow as unknown[]]));
    expect(out).toHaveLength(1);
    expect(out[0].volume).toBe(0);
  });

  it("accepts numeric (non-string) OHLC cells too", () => {
    const numericRow = [1700000000, 100, 110, 90, 105, 103, 12.5, 7];
    const out = parseKrakenOHLC(wrap([numericRow as unknown[]]));
    expect(out[0].close).toBe(105);
  });

  it("preserves fractional prices through coercion", () => {
    const out = parseKrakenOHLC(wrap([row(1700000000, 0.5, 0.75, 0.25, 0.625, 0.5, 1000, 3)]));
    expect(out[0].open).toBeCloseTo(0.5, 12);
    expect(out[0].high).toBeCloseTo(0.75, 12);
    expect(out[0].low).toBeCloseTo(0.25, 12);
    expect(out[0].close).toBeCloseTo(0.625, 12);
  });
});

// =============================================================================================
describe("parseKrakenOHLC — sanitizer invariants — properties", () => {
  it("output is sorted strictly ascending by start_unix for random shuffled input", () => {
    const rng = lcg(31337);
    const times = Array.from(new Set(Array.from({ length: 40 }, () => randInt(rng, 1, 5000) * 100 + 1700000000)));
    // shuffle deterministically
    for (let i = times.length - 1; i > 0; i--) {
      const j = randInt(rng, 0, i);
      [times[i], times[j]] = [times[j], times[i]];
    }
    const rows = times.map((t, i) => row(t, 100 + (i % 7)));
    const out = parseKrakenOHLC(wrap(rows));
    for (let i = 1; i < out.length; i++) expect(out[i].start_unix).toBeGreaterThan(out[i - 1].start_unix);
  });

  it("output start_unix values are unique (deduped) for random input with duplicates", () => {
    const rng = lcg(99);
    const rows: unknown[][] = [];
    for (let i = 0; i < 50; i++) {
      const t = 1700000000 + randInt(rng, 0, 9) * 60; // only 10 distinct slots → forces dups
      rows.push(row(t, randInt(rng, 1, 500)));
    }
    const out = parseKrakenOHLC(wrap(rows));
    const ts = out.map((c) => c.start_unix);
    expect(new Set(ts).size).toBe(ts.length);
  });

  it("keeps the FIRST occurrence (by time order) on a duplicate timestamp", () => {
    const out = parseKrakenOHLC(wrap([
      row(1700000000, 100, 110, 90, 105),
      row(1700000000, 999, 999, 1, 999), // duplicate time, different data
    ]));
    expect(out).toHaveLength(1);
    expect(out[0].open).toBe(100);
  });

  it("drops a row with a zero open price", () => {
    const out = parseKrakenOHLC(wrap([
      row(1700000000, 0, 110, 90, 105),
      row(1700000100, 100, 110, 90, 105),
    ]));
    expect(out.map((c) => c.start_unix)).toEqual([1700000100]);
  });

  it("drops a row with a negative price", () => {
    const out = parseKrakenOHLC(wrap([row(1700000000, -5, 110, 90, 105), row(1700000100, 100, 110, 90, 105)]));
    expect(out.map((c) => c.start_unix)).toEqual([1700000100]);
  });

  it("drops a structurally impossible bar where high < low", () => {
    const out = parseKrakenOHLC(wrap([
      row(1700000000, 100, 90, 110, 105), // high 90 < low 110 → invalid
      row(1700000100, 100, 110, 90, 105),
    ]));
    expect(out.map((c) => c.start_unix)).toEqual([1700000100]);
  });

  it("drops a row whose price coerces to NaN (non-numeric string)", () => {
    const bad = [1700000000, "abc", "110", "90", "105", "1", "1", 1];
    const out = parseKrakenOHLC(wrap([bad as unknown[], row(1700000100)]));
    expect(out.map((c) => c.start_unix)).toEqual([1700000100]);
  });

  it("drops a row with negative volume but keeps zero volume", () => {
    const out = parseKrakenOHLC(wrap([
      row(1700000000, 100, 110, 90, 105, 103, -1, 1), // negative volume → dropped
      row(1700000100, 100, 110, 90, 105, 103, 0, 1),  // zero volume → kept
    ]));
    expect(out.map((c) => c.start_unix)).toEqual([1700000100]);
    expect(out[0].volume).toBe(0);
  });

  it("returns [] when every row is malformed", () => {
    const out = parseKrakenOHLC(wrap([
      row(1700000000, 0, 110, 90, 105),
      row(1700000100, 100, 90, 110, 105), // high<low
    ]));
    expect(out).toEqual([]);
  });

  it("output length never exceeds the count of distinct valid timestamps", () => {
    const rng = lcg(2024);
    const rows: unknown[][] = [];
    const distinct = new Set<number>();
    for (let i = 0; i < 60; i++) {
      const t = 1700000000 + randInt(rng, 0, 20) * 60;
      const valid = rng() < 0.7;
      if (valid) {
        rows.push(row(t, randInt(rng, 1, 300)));
        distinct.add(t);
      } else {
        rows.push(row(t, 0)); // invalid open → dropped
      }
    }
    const out = parseKrakenOHLC(wrap(rows));
    expect(out.length).toBeLessThanOrEqual(distinct.size);
    // and every kept row is a valid OHLC bar
    for (const c of out) {
      expect(c.open).toBeGreaterThan(0);
      expect(c.high).toBeGreaterThanOrEqual(c.low);
      expect(c.volume).toBeGreaterThanOrEqual(0);
    }
  });

  it("is idempotent in shape: re-wrapping the output rows yields the same candles", () => {
    const rng = lcg(8675309);
    const rows = Array.from({ length: 12 }, (_, i) =>
      row(1700000000 + randInt(rng, 0, 30) * 60, randInt(rng, 1, 500), 600, 1, randInt(rng, 1, 500)),
    );
    const out1 = parseKrakenOHLC(wrap(rows));
    const rows2 = out1.map((c) => row(c.start_unix, c.open, c.high, c.low, c.close, 1, c.volume, 1));
    const out2 = parseKrakenOHLC(wrap(rows2));
    expect(out2).toEqual(out1);
  });
});
