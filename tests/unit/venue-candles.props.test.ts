import { describe, it, expect } from "vitest";
import {
  sanitizeCandles,
  parseCoinbaseExchangeCandles,
  parseCoinbaseAdvancedCandles,
  type VenueCandle,
} from "@/lib/data/venue-candles";

/**
 * Property-based companion to venue-candles.test.ts. Every randomized input is built from a
 * deterministic seeded LCG (no Math.random, no Date) so failures are reproducible. These assert
 * structural invariants of the real exports — sorted+unique output, idempotence, OHLC positivity,
 * high>=low — plus parser column-order correctness on extra shapes. Cases here are DISTINCT from
 * the sibling file's example-based tests.
 */

// --- deterministic seeded LCG (Numerical Recipes constants) -------------------------------------
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000; // [0,1)
  };
}
const randInt = (rng: () => number, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
// Fisher-Yates shuffle driven by the seeded rng (pure, deterministic for a fixed seed).
function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const c = (start_unix: number, o: number, h: number, l: number, cl: number, v = 1): VenueCandle => ({
  start_unix, open: o, high: h, low: l, close: cl, volume: v,
});

// A "clean" candle the sanitizer must always keep (positive OHLC, high>=low, finite vol>=0).
function cleanCandle(start_unix: number, rng: () => number): VenueCandle {
  const low = randInt(rng, 1, 500);
  const high = low + randInt(rng, 0, 500); // guarantees high >= low
  const open = randInt(rng, low, high);
  const close = randInt(rng, low, high);
  const volume = randInt(rng, 0, 10_000);
  return { start_unix, open, high, low, close, volume };
}

const ascByTime = (xs: readonly VenueCandle[]): boolean =>
  xs.every((x, i) => i === 0 || x.start_unix >= xs[i - 1].start_unix);
const uniqueTimes = (xs: readonly VenueCandle[]): boolean =>
  new Set(xs.map((x) => x.start_unix)).size === xs.length;

// =================================================================================================
describe("sanitizeCandles invariants — properties", () => {
  it("output is strictly time-sorted for every one of many seeded random orders", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = lcg(seed);
      const n = randInt(rng, 0, 30);
      const cands = Array.from({ length: n }, () => cleanCandle(randInt(rng, 1, 200), rng));
      const out = sanitizeCandles(cands);
      expect(ascByTime(out)).toBe(true);
    }
  });

  it("output start_unix values are unique across every seeded random order", () => {
    for (let seed = 101; seed <= 140; seed++) {
      const rng = lcg(seed);
      const n = randInt(rng, 0, 30);
      // Deliberately small time range so duplicates are common and dedup is exercised.
      const cands = Array.from({ length: n }, () => cleanCandle(randInt(rng, 1, 8), rng));
      const out = sanitizeCandles(cands);
      expect(uniqueTimes(out)).toBe(true);
    }
  });

  it("the SET of surviving timestamps is permutation-invariant (order of input never changes which times survive)", () => {
    for (let seed = 201; seed <= 230; seed++) {
      const rng = lcg(seed);
      const cands = Array.from({ length: randInt(rng, 0, 25) }, () => cleanCandle(randInt(rng, 1, 12), rng));
      const base = new Set(sanitizeCandles(cands).map((x) => x.start_unix));
      for (let k = 0; k < 4; k++) {
        const perm = shuffle(cands, lcg(seed * 31 + k + 1));
        const got = new Set(sanitizeCandles(perm).map((x) => x.start_unix));
        expect([...got].sort((a, b) => a - b)).toEqual([...base].sort((a, b) => a - b));
      }
    }
  });

  it("is idempotent — sanitize(sanitize(x)) deep-equals sanitize(x) for many seeds", () => {
    for (let seed = 301; seed <= 345; seed++) {
      const rng = lcg(seed);
      const cands = Array.from({ length: randInt(rng, 0, 30) }, () =>
        cleanCandle(randInt(rng, 1, 40), rng));
      const once = sanitizeCandles(cands);
      const twice = sanitizeCandles(once);
      expect(twice).toEqual(once);
    }
  });

  it("a second sanitize is a fixed point even after re-shuffling the first output", () => {
    for (let seed = 401; seed <= 430; seed++) {
      const rng = lcg(seed);
      const cands = Array.from({ length: randInt(rng, 0, 25) }, () =>
        cleanCandle(randInt(rng, 1, 40), rng));
      const once = sanitizeCandles(cands);
      const reshuffled = shuffle(once, lcg(seed + 7));
      // sanitize is already sorted+unique, so re-sanitizing any permutation returns the canonical form.
      expect(sanitizeCandles(reshuffled)).toEqual(once);
    }
  });

  it("every surviving bar has positive open/high/low/close", () => {
    for (let seed = 501; seed <= 540; seed++) {
      const rng = lcg(seed);
      const cands = Array.from({ length: randInt(rng, 1, 30) }, () =>
        cleanCandle(randInt(rng, 1, 60), rng));
      for (const b of sanitizeCandles(cands)) {
        expect(b.open).toBeGreaterThan(0);
        expect(b.high).toBeGreaterThan(0);
        expect(b.low).toBeGreaterThan(0);
        expect(b.close).toBeGreaterThan(0);
      }
    }
  });

  it("every surviving bar satisfies high >= low", () => {
    for (let seed = 601; seed <= 640; seed++) {
      const rng = lcg(seed);
      const cands = Array.from({ length: randInt(rng, 1, 30) }, () =>
        cleanCandle(randInt(rng, 1, 60), rng));
      for (const b of sanitizeCandles(cands)) expect(b.high).toBeGreaterThanOrEqual(b.low);
    }
  });

  it("every surviving bar has finite volume >= 0", () => {
    for (let seed = 701; seed <= 730; seed++) {
      const rng = lcg(seed);
      const cands = Array.from({ length: randInt(rng, 1, 30) }, () =>
        cleanCandle(randInt(rng, 1, 60), rng));
      for (const b of sanitizeCandles(cands)) {
        expect(Number.isFinite(b.volume)).toBe(true);
        expect(b.volume).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("every surviving start_unix is finite", () => {
    for (let seed = 731; seed <= 760; seed++) {
      const rng = lcg(seed);
      const cands = Array.from({ length: randInt(rng, 1, 30) }, () =>
        cleanCandle(randInt(rng, 1, 60), rng));
      for (const b of sanitizeCandles(cands)) expect(Number.isFinite(b.start_unix)).toBe(true);
    }
  });

  it("dropping corrupt rows never changes which clean rows survive (corruption is independent)", () => {
    for (let seed = 801; seed <= 830; seed++) {
      const rng = lcg(seed);
      // Build clean rows at UNIQUE times, then inject corrupt rows at NEW unique times.
      const cleanTimes = Array.from({ length: randInt(rng, 1, 12) }, (_, i) => (i + 1) * 100);
      const clean = cleanTimes.map((t) => cleanCandle(t, rng));
      const corruptTimes = Array.from({ length: randInt(rng, 0, 8) }, (_, i) => (i + 1) * 100 + 50);
      const corrupt = corruptTimes.map((t) => c(t, -1, 1, 1, 1)); // open<0 → always dropped
      const withCorrupt = shuffle([...clean, ...corrupt], lcg(seed + 3));
      const a = sanitizeCandles(clean).map((x) => x.start_unix);
      const b = sanitizeCandles(withCorrupt).map((x) => x.start_unix);
      expect(b).toEqual(a);
    }
  });

  it("output length is monotonically <= input length for every seed", () => {
    for (let seed = 831; seed <= 870; seed++) {
      const rng = lcg(seed);
      const cands = Array.from({ length: randInt(rng, 0, 40) }, () =>
        cleanCandle(randInt(rng, 1, 15), rng));
      expect(sanitizeCandles(cands).length).toBeLessThanOrEqual(cands.length);
    }
  });

  it("output length equals the count of DISTINCT clean timestamps in the input", () => {
    for (let seed = 901; seed <= 935; seed++) {
      const rng = lcg(seed);
      const cands = Array.from({ length: randInt(rng, 0, 30) }, () =>
        cleanCandle(randInt(rng, 1, 10), rng));
      const distinct = new Set(cands.map((x) => x.start_unix)).size;
      expect(sanitizeCandles(cands).length).toBe(distinct);
    }
  });

  it("dedup keeps the FIRST occurrence after the stable sort (lowest-index tie-break)", () => {
    // Several candles share one timestamp; the earliest in input order must win after stable sort.
    for (let seed = 1001; seed <= 1020; seed++) {
      const rng = lcg(seed);
      const T = 555;
      const dupes = Array.from({ length: randInt(rng, 2, 6) }, (_, i) => c(T, i + 1, i + 1, i + 1, i + 1, i + 1));
      const out = sanitizeCandles(dupes);
      expect(out).toHaveLength(1);
      expect(out[0].open).toBe(1); // first in input order (index 0) survives
    }
  });

  it("does not mutate the input array (length and element identity preserved)", () => {
    const rng = lcg(2024);
    const cands = Array.from({ length: 20 }, () => cleanCandle(randInt(rng, 1, 5), rng));
    const snapshotLen = cands.length;
    const firstRef = cands[0];
    const lastRef = cands[cands.length - 1];
    sanitizeCandles(cands);
    expect(cands.length).toBe(snapshotLen);
    expect(cands[0]).toBe(firstRef);
    expect(cands[cands.length - 1]).toBe(lastRef);
  });

  it("empty input yields empty output", () => {
    expect(sanitizeCandles([])).toEqual([]);
  });

  it("an all-corrupt batch sanitizes to empty for many seeds", () => {
    for (let seed = 1101; seed <= 1120; seed++) {
      const rng = lcg(seed);
      const bad = Array.from({ length: randInt(rng, 1, 15) }, (_, i) => {
        const kind = randInt(rng, 0, 3);
        const t = i + 1;
        if (kind === 0) return c(t, 0, 1, 1, 1);        // open 0
        if (kind === 1) return c(t, 1, 1, 1, -1);       // close < 0
        if (kind === 2) return c(t, 1, 4, 5, 3);        // high < low
        return c(t, 1, 1, 1, 1, -1);                    // negative volume
      });
      expect(sanitizeCandles(bad)).toHaveLength(0);
    }
  });

  it("Infinity / -Infinity OHLC are rejected (pos() requires Number.isFinite)", () => {
    expect(sanitizeCandles([c(10, Infinity, 1, 1, 1)])).toHaveLength(0);
    expect(sanitizeCandles([c(10, 1, Infinity, 1, 1)])).toHaveLength(0);
    expect(sanitizeCandles([c(10, 1, 1, 1, -Infinity)])).toHaveLength(0);
    expect(sanitizeCandles([{ start_unix: Infinity, open: 1, high: 1, low: 1, close: 1, volume: 1 }])).toHaveLength(0);
  });

  it("non-finite volume (NaN/Infinity) is rejected even with valid OHLC", () => {
    expect(sanitizeCandles([c(10, 1, 1, 1, 1, NaN)])).toHaveLength(0);
    expect(sanitizeCandles([c(10, 1, 1, 1, 1, Infinity)])).toHaveLength(0);
  });

  it("a single equal-OHLC bar (high === low) survives — boundary of the high<low drop", () => {
    expect(sanitizeCandles([c(10, 7, 7, 7, 7, 3)])).toEqual([c(10, 7, 7, 7, 7, 3)]);
  });

  it("concatenating two clean disjoint-time batches then sanitizing == merge-sort of both", () => {
    for (let seed = 1201; seed <= 1225; seed++) {
      const rng = lcg(seed);
      const aTimes = [10, 30, 50, 70];
      const bTimes = [20, 40, 60, 80];
      const a = aTimes.map((t) => cleanCandle(t, rng));
      const b = bTimes.map((t) => cleanCandle(t, rng));
      const merged = sanitizeCandles(shuffle([...a, ...b], lcg(seed + 9)));
      expect(merged.map((x) => x.start_unix)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
    }
  });

  it("zero-volume clean bars are always retained (boundary: volume === 0)", () => {
    for (let seed = 1301; seed <= 1320; seed++) {
      const rng = lcg(seed);
      const times = Array.from({ length: randInt(rng, 1, 8) }, (_, i) => (i + 1) * 11);
      const bars = times.map((t) => ({ ...cleanCandle(t, rng), volume: 0 }));
      const out = sanitizeCandles(shuffle(bars, lcg(seed)));
      expect(out).toHaveLength(times.length);
      expect(out.every((b) => b.volume === 0)).toBe(true);
    }
  });
});

// =================================================================================================
describe("parseCoinbaseExchangeCandles column order — properties", () => {
  it("maps [time, low, high, open, close, volume] field-by-field for many seeded rows", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = lcg(seed);
      const time = randInt(rng, 1, 2_000_000_000);
      const low = randInt(rng, 1, 100);
      const high = low + randInt(rng, 0, 100);
      const open = randInt(rng, low, high);
      const close = randInt(rng, low, high);
      const volume = randInt(rng, 0, 5000);
      const out = parseCoinbaseExchangeCandles([[time, low, high, open, close, volume]]);
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual({ start_unix: time, low, high, open, close, volume });
    }
  });

  it("string and numeric cells coerce to the same parsed candle (column 1=low, 2=high, 3=open, 4=close)", () => {
    for (let seed = 41; seed <= 70; seed++) {
      const rng = lcg(seed);
      const row = [randInt(rng, 1, 1e9), randInt(rng, 1, 50), 0, 0, 0, randInt(rng, 0, 100)];
      row[2] = row[1] + randInt(rng, 0, 50);                 // high >= low
      row[3] = randInt(rng, row[1], row[2]);                 // open in [low,high]
      row[4] = randInt(rng, row[1], row[2]);                 // close in [low,high]
      const numeric = parseCoinbaseExchangeCandles([row]);
      const stringy = parseCoinbaseExchangeCandles([row.map((x) => String(x))]);
      expect(stringy).toEqual(numeric);
    }
  });

  it("missing volume cell (length-5 row) defaults to 0 and the row survives", () => {
    const out = parseCoinbaseExchangeCandles([[100, 5, 9, 6, 8]]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ start_unix: 100, low: 5, high: 9, open: 6, close: 8, volume: 0 });
  });

  it("inherits sanitize: duplicate timestamps dedup keeping the first row in input order", () => {
    const out = parseCoinbaseExchangeCandles([
      [100, 5, 9, 6, 8, 1],
      [100, 1, 1, 1, 1, 2],
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].low).toBe(5); // first row wins
  });

  it("inherits sanitize: a row with low>high (cols 1,2 swapped) is dropped", () => {
    // low column = 9, high column = 4 → high(4) < low(9) → structurally impossible → dropped.
    expect(parseCoinbaseExchangeCandles([[100, 9, 4, 5, 6, 1]])).toHaveLength(0);
  });

  it("inherits sanitize: a non-positive open (col 3) drops the row", () => {
    expect(parseCoinbaseExchangeCandles([[100, 5, 9, 0, 8, 1]])).toHaveLength(0);
  });

  it("output of the parser is itself sorted+unique for shuffled multi-row input", () => {
    for (let seed = 71; seed <= 95; seed++) {
      const rng = lcg(seed);
      const times = [500, 100, 300, 200, 400];
      const rows = shuffle(times, lcg(seed)).map((t) => {
        const low = randInt(rng, 1, 50);
        const high = low + randInt(rng, 0, 50);
        return [t, low, high, randInt(rng, low, high), randInt(rng, low, high), randInt(rng, 0, 9)];
      });
      const out = parseCoinbaseExchangeCandles(rows);
      expect(out.map((x) => x.start_unix)).toEqual([100, 200, 300, 400, 500]);
      expect(uniqueTimes(out)).toBe(true);
      expect(ascByTime(out)).toBe(true);
    }
  });
});

// =================================================================================================
describe("parseCoinbaseAdvancedCandles object form — properties", () => {
  it("maps { start, low, high, open, close, volume } field-by-field across seeded rows", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = lcg(seed);
      const start = randInt(rng, 1, 2_000_000_000);
      const low = randInt(rng, 1, 100);
      const high = low + randInt(rng, 0, 100);
      const open = randInt(rng, low, high);
      const close = randInt(rng, low, high);
      const volume = randInt(rng, 0, 5000);
      const out = parseCoinbaseAdvancedCandles([{ start, low, high, open, close, volume }]);
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual({ start_unix: start, low, high, open, close, volume });
    }
  });

  it("string-valued fields parse identically to numeric fields", () => {
    for (let seed = 41; seed <= 70; seed++) {
      const rng = lcg(seed);
      const low = randInt(rng, 1, 50);
      const high = low + randInt(rng, 0, 50);
      const o = { start: randInt(rng, 1, 1e9), low, high, open: randInt(rng, low, high), close: randInt(rng, low, high), volume: randInt(rng, 0, 99) };
      const numeric = parseCoinbaseAdvancedCandles([o]);
      const stringy = parseCoinbaseAdvancedCandles([{
        start: String(o.start), low: String(o.low), high: String(o.high),
        open: String(o.open), close: String(o.close), volume: String(o.volume),
      }]);
      expect(stringy).toEqual(numeric);
    }
  });

  it("omitting the volume key defaults volume to 0 and keeps the row", () => {
    const out = parseCoinbaseAdvancedCandles([{ start: 42, low: 3, high: 9, open: 4, close: 8 }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ start_unix: 42, low: 3, high: 9, open: 4, close: 8, volume: 0 });
  });

  it("inherits sanitize: duplicate start dedups keeping the first object", () => {
    const out = parseCoinbaseAdvancedCandles([
      { start: "7", low: 3, high: 9, open: 4, close: 8, volume: 1 },
      { start: 7, low: 1, high: 1, open: 1, close: 1, volume: 2 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].low).toBe(3);
  });

  it("inherits sanitize: high<low object is dropped", () => {
    expect(parseCoinbaseAdvancedCandles([{ start: 1, low: 9, high: 4, open: 5, close: 6 }])).toHaveLength(0);
  });

  it("inherits sanitize: non-positive close drops the row", () => {
    expect(parseCoinbaseAdvancedCandles([{ start: 1, low: 1, high: 9, open: 5, close: 0 }])).toHaveLength(0);
  });

  it("produces sorted+unique output for shuffled multi-object input", () => {
    for (let seed = 71; seed <= 95; seed++) {
      const rng = lcg(seed);
      const starts = [9, 1, 7, 3, 5];
      const objs = shuffle(starts, lcg(seed)).map((start) => {
        const low = randInt(rng, 1, 40);
        const high = low + randInt(rng, 0, 40);
        return { start, low, high, open: randInt(rng, low, high), close: randInt(rng, low, high), volume: randInt(rng, 0, 9) };
      });
      const out = parseCoinbaseAdvancedCandles(objs);
      expect(out.map((x) => x.start_unix)).toEqual([1, 3, 5, 7, 9]);
      expect(uniqueTimes(out)).toBe(true);
    }
  });

  it("agrees with parseCoinbaseExchangeCandles when the SAME data is fed in each venue's shape", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rng = lcg(seed);
      const time = randInt(rng, 1, 1e9);
      const low = randInt(rng, 1, 100);
      const high = low + randInt(rng, 0, 100);
      const open = randInt(rng, low, high);
      const close = randInt(rng, low, high);
      const volume = randInt(rng, 0, 1000);
      const ex = parseCoinbaseExchangeCandles([[time, low, high, open, close, volume]]);
      const adv = parseCoinbaseAdvancedCandles([{ start: time, low, high, open, close, volume }]);
      expect(adv).toEqual(ex);
    }
  });
});
