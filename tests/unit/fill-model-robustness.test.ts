import { describe, expect, it } from "vitest";
import {
  applyLatency,
  getFillFn,
  latencyMsToSnapshots,
  midpointFill,
  walkBookFill,
} from "@/lib/backtest/fill-model";
import type { FillContext, FillResult } from "@/lib/backtest/fill-model";
import type { SnapshotPoint } from "@/lib/backtest/types";

/**
 * Complementary robustness / invariant tests for the backtest fill model.
 * These are NEW cases (the existing fill-model.test.ts covers the happy
 * paths). Here we hammer on bounds, monotonicity, determinism, symmetry,
 * and edge/empty inputs. Everything is constructed from pure synthetic
 * inputs — no IO, no clock, no entropy. A tiny seeded LCG provides any
 * pseudo-randomness so the file is fully deterministic.
 */

// ----- deterministic helpers ---------------------------------------------

/** Minimal seeded LCG (Numerical Recipes constants) — fully deterministic. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000; // in [0,1)
  };
}

function snap(
  midpoint: number | null,
  yes: number | null,
  no: number | null,
  spread: number | null,
  captured_at = "2026-01-01T00:00:00Z",
): SnapshotPoint {
  return {
    token_id: "t",
    question: "q",
    midpoint,
    yes_price: yes,
    no_price: no,
    spread,
    volume_24h: 100,
    captured_at,
  };
}

const SIDES: Array<"YES" | "NO"> = ["YES", "NO"];
const ACTIONS: Array<"open" | "close"> = ["open", "close"];

// ----- midpointFill -------------------------------------------------------

describe("midpointFill — bounds & invariants", () => {
  it("price always equals the snapshot midpoint when it fills", () => {
    const rng = lcg(12345);
    for (let i = 0; i < 40; i++) {
      const mid = 0.01 + rng() * 0.98; // strictly positive, in (0,1)
      const size = 1 + Math.floor(rng() * 1000);
      const r = midpointFill({ side: "YES", snapshot: snap(mid, mid - 0.01, mid + 0.01, 0.02), size });
      expect(r.price).toBe(mid);
      expect(r.filledSize).toBe(size);
    }
  });

  it("fills the full requested size whenever a price exists (no partials)", () => {
    const rng = lcg(999);
    for (let i = 0; i < 30; i++) {
      const size = 1 + Math.floor(rng() * 5000);
      const r = midpointFill({ side: "NO", snapshot: snap(0.5, 0.5, 0.5, 0), size });
      expect(r.filledSize).toBe(size);
    }
  });

  it("rejects non-positive midpoints (zero, negative) with null price and zero size", () => {
    for (const bad of [0, -0.01, -1]) {
      const r = midpointFill({ side: "YES", snapshot: snap(bad, 0.5, 0.5, 0), size: 10 });
      expect(r.price).toBeNull();
      expect(r.filledSize).toBe(0);
    }
  });

  it("rejects a null midpoint regardless of side", () => {
    for (const side of SIDES) {
      const r = midpointFill({ side, snapshot: snap(null, 0.5, 0.5, 0), size: 7 });
      expect(r.price).toBeNull();
      expect(r.filledSize).toBe(0);
    }
  });

  it("is independent of side — YES and NO yield identical fills", () => {
    const s = snap(0.42, 0.4, 0.6, 0.02);
    const y = midpointFill({ side: "YES", snapshot: s, size: 13 });
    const n = midpointFill({ side: "NO", snapshot: s, size: 13 });
    expect(y).toEqual(n);
  });

  it("is deterministic — same input gives the same result twice", () => {
    const ctx: FillContext = { side: "YES", snapshot: snap(0.33, 0.3, 0.7, 0.02), size: 21 };
    expect(midpointFill(ctx)).toEqual(midpointFill(ctx));
  });

  it("size=0 still fills price but with zero filledSize", () => {
    const r = midpointFill({ side: "YES", snapshot: snap(0.5, 0.5, 0.5, 0), size: 0 });
    expect(r.price).toBe(0.5);
    expect(r.filledSize).toBe(0);
  });
});

// ----- walkBookFill -------------------------------------------------------

describe("walkBookFill — bounds & cost invariants", () => {
  it("open price is never below the close price for the same side (you pay the spread)", () => {
    // With yes_ask & no_ask both >= 0.5 (positive implied spread), the ask you
    // pay on open must be >= the bid you receive on close.
    const rng = lcg(7);
    for (let i = 0; i < 30; i++) {
      const half = rng() * 0.05; // half-spread up to 5¢
      const mid = 0.1 + rng() * 0.8;
      const yesAsk = Math.min(0.99, mid + half);
      const noAsk = Math.min(0.99, 1 - mid + half);
      const s = snap(mid, yesAsk, noAsk, half * 2);
      for (const side of SIDES) {
        const open = walkBookFill({ side, action: "open", snapshot: s, size: 10 });
        const close = walkBookFill({ side, action: "close", snapshot: s, size: 10 });
        expect(open.price).not.toBeNull();
        expect(close.price).not.toBeNull();
        expect(open.price as number).toBeGreaterThanOrEqual((close.price as number) - 1e-9);
      }
    }
  });

  it("open YES uses yes_price and open NO uses no_price exactly", () => {
    const s = snap(0.5, 0.57, 0.49, 0.06);
    expect(walkBookFill({ side: "YES", action: "open", snapshot: s, size: 1 }).price).toBe(0.57);
    expect(walkBookFill({ side: "NO", action: "open", snapshot: s, size: 1 }).price).toBe(0.49);
  });

  it("close YES = 1 − no_price and close NO = 1 − yes_price (the implied bids)", () => {
    const s = snap(0.5, 0.57, 0.49, 0.06);
    expect(walkBookFill({ side: "YES", action: "close", snapshot: s, size: 1 }).price).toBeCloseTo(0.51, 9);
    expect(walkBookFill({ side: "NO", action: "close", snapshot: s, size: 1 }).price).toBeCloseTo(0.43, 9);
  });

  it("defaults action to 'open' when omitted (BUY-side semantics)", () => {
    const s = snap(0.5, 0.55, 0.5, 0.05);
    const noAction = walkBookFill({ side: "YES", snapshot: s, size: 10 });
    const explicitOpen = walkBookFill({ side: "YES", action: "open", snapshot: s, size: 10 });
    expect(noAction.price).toBe(explicitOpen.price);
    expect(noAction.price).toBe(0.55);
  });

  it("preserves the requested size whenever it fills (full fill, no partials)", () => {
    const rng = lcg(31337);
    for (let i = 0; i < 24; i++) {
      const size = 1 + Math.floor(rng() * 2000);
      const r = walkBookFill({ side: "YES", action: "open", snapshot: snap(0.5, 0.55, 0.5, 0.05), size });
      expect(r.filledSize).toBe(size);
    }
  });

  it("falls back to midpoint ± half-spread when explicit ask is missing", () => {
    const s = snap(0.5, null, null, 0.1);
    expect(walkBookFill({ side: "YES", action: "open", snapshot: s, size: 1 }).price).toBeCloseTo(0.55, 9);
    expect(walkBookFill({ side: "YES", action: "close", snapshot: s, size: 1 }).price).toBeCloseTo(0.45, 9);
    expect(walkBookFill({ side: "NO", action: "open", snapshot: s, size: 1 }).price).toBeCloseTo(0.55, 9);
    expect(walkBookFill({ side: "NO", action: "close", snapshot: s, size: 1 }).price).toBeCloseTo(0.45, 9);
  });

  it("treats a null spread as zero half-spread in the fallback path", () => {
    const s = snap(0.5, null, null, null);
    // halfSpread = (null ?? 0)/2 = 0, so open = close = midpoint
    expect(walkBookFill({ side: "YES", action: "open", snapshot: s, size: 1 }).price).toBeCloseTo(0.5, 9);
    expect(walkBookFill({ side: "YES", action: "close", snapshot: s, size: 1 }).price).toBeCloseTo(0.5, 9);
  });

  it("returns null when there is neither an explicit ask nor a midpoint", () => {
    const s = snap(null, null, null, 0.1);
    for (const side of SIDES) {
      for (const action of ACTIONS) {
        const r = walkBookFill({ side, action, snapshot: s, size: 10 });
        expect(r.price).toBeNull();
        expect(r.filledSize).toBe(0);
      }
    }
  });

  it("rejects a non-positive derived price (close into a no_price of 1)", () => {
    // close YES = 1 − no_price; with no_price = 1, price = 0 → rejected.
    const s = snap(0.5, 0.5, 1, 0);
    const r = walkBookFill({ side: "YES", action: "close", snapshot: s, size: 10 });
    expect(r.price).toBeNull();
    expect(r.filledSize).toBe(0);
  });

  it("rejects a non-positive explicit ask on open", () => {
    // yes_price = 0 is non-positive → rejected even though it is non-null.
    const s = snap(0.5, 0, 0.5, 0);
    const r = walkBookFill({ side: "YES", action: "open", snapshot: s, size: 10 });
    expect(r.price).toBeNull();
    expect(r.filledSize).toBe(0);
  });

  it("YES↔NO open prices swap when the snapshot's asks are swapped (symmetry)", () => {
    const a = snap(0.5, 0.6, 0.45, 0.05);
    const b = snap(0.5, 0.45, 0.6, 0.05); // asks swapped
    const yesA = walkBookFill({ side: "YES", action: "open", snapshot: a, size: 1 }).price;
    const noB = walkBookFill({ side: "NO", action: "open", snapshot: b, size: 1 }).price;
    expect(yesA).toBe(noB);
  });

  it("close price is monotonic decreasing in the opposite-side ask", () => {
    // close YES = 1 − no_price, so a larger no_price → a smaller fill price.
    let prev = Infinity;
    for (const noAsk of [0.3, 0.4, 0.5, 0.6, 0.7]) {
      const p = walkBookFill({ side: "YES", action: "close", snapshot: snap(0.5, 0.5, noAsk, 0), size: 1 }).price as number;
      expect(p).toBeLessThan(prev);
      prev = p;
    }
  });

  it("open price is monotonic increasing in the same-side ask", () => {
    let prev = -Infinity;
    for (const yesAsk of [0.2, 0.3, 0.4, 0.5, 0.6]) {
      const p = walkBookFill({ side: "YES", action: "open", snapshot: snap(0.5, yesAsk, 0.5, 0), size: 1 }).price as number;
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  it("is deterministic across repeated calls for every side/action combo", () => {
    const s = snap(0.48, 0.52, 0.51, 0.03);
    for (const side of SIDES) {
      for (const action of ACTIONS) {
        const ctx: FillContext = { side, action, snapshot: s, size: 17 };
        const first: FillResult = walkBookFill(ctx);
        const second: FillResult = walkBookFill(ctx);
        expect(first).toEqual(second);
      }
    }
  });

  it("a wider spread makes the open fallback strictly more expensive", () => {
    let prev = -Infinity;
    for (const spread of [0, 0.02, 0.06, 0.1, 0.2]) {
      const p = walkBookFill({
        side: "YES",
        action: "open",
        snapshot: snap(0.5, null, null, spread),
        size: 1,
      }).price as number;
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });
});

// ----- getFillFn ----------------------------------------------------------

describe("getFillFn — resolution & behavioral equivalence", () => {
  it("walk_book resolves to a function that matches walkBookFill on synthetic input", () => {
    const fn = getFillFn("walk_book");
    const ctx: FillContext = { side: "YES", action: "open", snapshot: snap(0.5, 0.55, 0.5, 0.05), size: 10 };
    expect(fn(ctx)).toEqual(walkBookFill(ctx));
  });

  it("midpoint resolves to a function that matches midpointFill on synthetic input", () => {
    const fn = getFillFn("midpoint");
    const ctx: FillContext = { side: "NO", snapshot: snap(0.4, 0.4, 0.6, 0.02), size: 5 };
    expect(fn(ctx)).toEqual(midpointFill(ctx));
  });
});

// ----- applyLatency -------------------------------------------------------

describe("applyLatency — index clamping invariants", () => {
  const snaps = [
    snap(0.4, 0.4, 0.6, 0),
    snap(0.5, 0.5, 0.5, 0),
    snap(0.6, 0.6, 0.4, 0),
    snap(0.7, 0.7, 0.3, 0),
  ];

  it("never returns a snapshot before the decision index (delay >= 0 monotone)", () => {
    const rng = lcg(2024);
    for (let i = 0; i < 30; i++) {
      const decisionIndex = Math.floor(rng() * snaps.length);
      const delay = Math.floor(rng() * 10);
      const out = applyLatency(snaps, decisionIndex, delay);
      const outIdx = snaps.indexOf(out);
      expect(outIdx).toBeGreaterThanOrEqual(decisionIndex);
    }
  });

  it("clamps any over-large delay to exactly the last snapshot", () => {
    expect(applyLatency(snaps, 0, 1000)).toBe(snaps[snaps.length - 1]);
    expect(applyLatency(snaps, 2, 1000)).toBe(snaps[snaps.length - 1]);
  });

  it("treats negative delays as zero (clamped, no underflow)", () => {
    expect(applyLatency(snaps, 2, -5)).toBe(snaps[2]);
    expect(applyLatency(snaps, 0, -100)).toBe(snaps[0]);
  });

  it("is monotonic non-decreasing in delay for a fixed decision index", () => {
    let prevIdx = -1;
    for (const delay of [0, 1, 2, 3, 5, 50]) {
      const idx = snaps.indexOf(applyLatency(snaps, 0, delay));
      expect(idx).toBeGreaterThanOrEqual(prevIdx);
      prevIdx = idx;
    }
  });

  it("returns the decision snapshot itself when delay is 0", () => {
    for (let i = 0; i < snaps.length; i++) {
      expect(applyLatency(snaps, i, 0)).toBe(snaps[i]);
    }
  });
});

// ----- latencyMsToSnapshots ----------------------------------------------

describe("latencyMsToSnapshots — guards & estimation", () => {
  const evenSnaps = [
    snap(0.5, 0.5, 0.5, 0, "2026-01-01T00:00:00Z"),
    snap(0.5, 0.5, 0.5, 0, "2026-01-01T00:01:00Z"), // 60s gap
    snap(0.5, 0.5, 0.5, 0, "2026-01-01T00:02:00Z"), // 60s gap
  ];

  it("returns 0 for fewer than two snapshots", () => {
    expect(latencyMsToSnapshots([], 60_000)).toBe(0);
    expect(latencyMsToSnapshots([evenSnaps[0]], 60_000)).toBe(0);
  });

  it("returns 0 for non-positive latency", () => {
    expect(latencyMsToSnapshots(evenSnaps, 0)).toBe(0);
    expect(latencyMsToSnapshots(evenSnaps, -1000)).toBe(0);
  });

  it("returns 0 when timestamps are unparseable", () => {
    const bad = [snap(0.5, 0.5, 0.5, 0, "not-a-date"), snap(0.5, 0.5, 0.5, 0, "also-bad")];
    expect(latencyMsToSnapshots(bad, 60_000)).toBe(0);
  });

  it("returns 0 when the last timestamp is not after the first (non-positive span)", () => {
    const flat = [
      snap(0.5, 0.5, 0.5, 0, "2026-01-01T00:01:00Z"),
      snap(0.5, 0.5, 0.5, 0, "2026-01-01T00:00:00Z"), // earlier than the first
    ];
    expect(latencyMsToSnapshots(flat, 60_000)).toBe(0);
  });

  it("floors a small positive latency to at least one snapshot", () => {
    // 60s avg gap, 1ms latency rounds to 0 then is bumped up to 1.
    expect(latencyMsToSnapshots(evenSnaps, 1)).toBe(1);
  });

  it("rounds latency to the nearest snapshot count by average gap", () => {
    // 60s gap. 30s → round(0.5)=1 (banker rounding aside, JS round → 1).
    expect(latencyMsToSnapshots(evenSnaps, 30_000)).toBe(1);
    expect(latencyMsToSnapshots(evenSnaps, 90_000)).toBe(2); // round(1.5)=2
    expect(latencyMsToSnapshots(evenSnaps, 120_000)).toBe(2);
    expect(latencyMsToSnapshots(evenSnaps, 180_000)).toBe(3);
  });

  it("is monotonic non-decreasing in latencyMs", () => {
    let prev = -1;
    for (const ms of [1, 30_000, 60_000, 120_000, 240_000, 600_000]) {
      const n = latencyMsToSnapshots(evenSnaps, ms);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });

  it("is deterministic for a fixed snapshot series and latency", () => {
    expect(latencyMsToSnapshots(evenSnaps, 90_000)).toBe(latencyMsToSnapshots(evenSnaps, 90_000));
  });

  it("uses the average gap so uneven spacing still yields a positive count", () => {
    // Total span 0→240s over 3 gaps → avg 80s. 80s latency → ~1 snapshot.
    const uneven = [
      snap(0.5, 0.5, 0.5, 0, "2026-01-01T00:00:00Z"),
      snap(0.5, 0.5, 0.5, 0, "2026-01-01T00:00:10Z"), // 10s
      snap(0.5, 0.5, 0.5, 0, "2026-01-01T00:01:00Z"), // 50s
      snap(0.5, 0.5, 0.5, 0, "2026-01-01T00:04:00Z"), // 180s
    ];
    expect(latencyMsToSnapshots(uneven, 80_000)).toBe(1);
  });
});
