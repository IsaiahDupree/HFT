/**
 * Robustness / invariant / edge-case tests for the golden-signal → order intake
 * (the 2dollar-bot → HFT-work execution bridge). Complements signal-intake.test.ts
 * with adversarial malformed inputs, gate-ordering invariants, normalization edges,
 * dedup identity, and full determinism. This is a real-money path: rejection must be
 * total (never throws), the per-trade cap must never be exceeded, and the allowlist
 * must be a hard wall against every non-listed coin+window.
 *
 * Pure: no DB, no network, no files, no wall-clock, no entropy. All pseudo-randomness
 * comes from a fixed-seed LCG so the file is byte-for-byte deterministic.
 */
import { describe, expect, it } from "vitest";
import { planFromSignal, regimeOf, dedupKey, type GoldenSignal } from "@/lib/signal/intake";

function sig(over: Partial<GoldenSignal> = {}): GoldenSignal {
  return {
    source: "golden-window", asset: "SOL", recurrence: "5m", side: "UP",
    size_usd: 2, token_id: "0xTOK", entry_price: 0.84, est_win_prob: 0.96,
    edge: 0.12, readiness_ok: true, ...over,
  };
}

const OPTS = { maxTradeUsd: 2 };

/** Tiny seeded LCG (Numerical Recipes constants) — deterministic, no entropy. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000; // [0,1)
  };
}

describe("planFromSignal — malformed bodies never throw, always reject", () => {
  it("rejects a null body with a stable reason", () => {
    const d = planFromSignal(null as unknown as GoldenSignal, OPTS);
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe("no signal body");
    expect(d.order).toBeUndefined();
  });

  it("rejects non-object bodies (string / number) without throwing", () => {
    for (const bad of ["{}", 7, true, NaN]) {
      const d = planFromSignal(bad as unknown as GoldenSignal, OPTS);
      expect(d.accepted).toBe(false);
      expect(d.reason).toBe("no signal body");
    }
  });

  it("a rejected decision NEVER carries an order field", () => {
    const rejects = [
      sig({ readiness_ok: false }),
      sig({ side: "SIDEWAYS" }),
      sig({ token_id: undefined }),
      sig({ entry_price: 1 }),
      sig({ size_usd: 0 }),
    ];
    for (const s of rejects) {
      const d = planFromSignal(s, OPTS);
      expect(d.accepted).toBe(false);
      expect(d.order).toBeUndefined();
      expect(typeof d.reason).toBe("string");
      expect(d.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("planFromSignal — gate ordering invariants", () => {
  it("readiness gate fires BEFORE side/token/price validation", () => {
    // Everything else is also broken, but readiness is checked first.
    const d = planFromSignal(
      sig({ readiness_ok: false, side: "SIDEWAYS", token_id: undefined, entry_price: 9 }),
      OPTS,
    );
    expect(d.accepted).toBe(false);
    expect(d.reason).toContain("readiness");
  });

  it("falsy readiness variants (undefined / 0 / empty) all fail the gate", () => {
    for (const r of [undefined, false, 0, "", null]) {
      const d = planFromSignal(sig({ readiness_ok: r as unknown as boolean }), OPTS);
      expect(d.accepted).toBe(false);
      expect(d.reason).toContain("readiness");
    }
  });

  it("allowlist rejection fires BEFORE side validation", () => {
    // bad side too, but a non-listed regime is rejected with the allowlist reason.
    const d = planFromSignal(
      sig({ asset: "ETH", recurrence: "5m", side: "SIDEWAYS" }),
      { maxTradeUsd: 2, allow: ["SOL:5m"] },
    );
    expect(d.accepted).toBe(false);
    expect(d.reason).toContain("not in allowlist");
  });

  it("side validation fires BEFORE token_id check", () => {
    const d = planFromSignal(sig({ side: "SIDEWAYS", token_id: undefined }), OPTS);
    expect(d.accepted).toBe(false);
    expect(d.reason).toContain("bad side");
  });

  it("token_id check fires BEFORE entry_price validation", () => {
    const d = planFromSignal(sig({ token_id: undefined, entry_price: 9 }), OPTS);
    expect(d.accepted).toBe(false);
    expect(d.reason).toContain("token_id");
  });

  it("entry_price validation fires BEFORE size check", () => {
    const d = planFromSignal(sig({ entry_price: 1.5, size_usd: 0 }), OPTS);
    expect(d.accepted).toBe(false);
    expect(d.reason).toContain("entry_price");
  });
});

describe("planFromSignal — entry_price boundary is the open interval (0,1)", () => {
  it("rejects both endpoints 0 and 1 (strictly between)", () => {
    expect(planFromSignal(sig({ entry_price: 0 }), OPTS).accepted).toBe(false);
    expect(planFromSignal(sig({ entry_price: 1 }), OPTS).accepted).toBe(false);
  });

  it("rejects negative, NaN, and non-finite prices without throwing", () => {
    for (const p of [-0.5, NaN, Infinity, -Infinity]) {
      const d = planFromSignal(sig({ entry_price: p as number }), OPTS);
      expect(d.accepted).toBe(false);
      expect(d.reason).toContain("entry_price");
    }
  });

  it("accepts prices strictly inside (0,1) and echoes them as refPrice exactly", () => {
    for (const p of [0.0001, 0.5, 0.84, 0.9999]) {
      const d = planFromSignal(sig({ entry_price: p }), OPTS);
      expect(d.accepted).toBe(true);
      expect(d.order!.refPrice).toBe(p);
    }
  });

  it("coerces numeric-string entry_price via Number() and accepts in-range", () => {
    const d = planFromSignal(sig({ entry_price: "0.42" as unknown as number }), OPTS);
    expect(d.accepted).toBe(true);
    expect(d.order!.refPrice).toBe(0.42);
  });
});

describe("planFromSignal — side normalization (case-insensitive allowlist of 4)", () => {
  it("accepts all four canonical sides in any letter case", () => {
    for (const s of ["UP", "down", "Yes", "nO"]) {
      expect(planFromSignal(sig({ side: s }), OPTS).accepted).toBe(true);
    }
  });

  it("rejects anything outside {UP,DOWN,YES,NO} including empty / whitespace", () => {
    for (const s of ["", "  ", "BUY", "SELL", "LONG", "u p"]) {
      const d = planFromSignal(sig({ side: s }), OPTS);
      expect(d.accepted).toBe(false);
      expect(d.reason).toContain("side");
    }
  });

  it("the accepted order's rationale carries the UPPERCASED side", () => {
    const d = planFromSignal(sig({ side: "down" }), OPTS);
    expect(d.accepted).toBe(true);
    expect(d.order!.rationale).toContain(" DOWN ");
  });
});

describe("planFromSignal — per-trade USD cap is an inviolable ceiling", () => {
  it("output sizeUsd is min(requested, cap) and never exceeds the cap", () => {
    const rng = lcg(0xC0FFEE);
    for (let i = 0; i < 64; i++) {
      const requested = +(rng() * 200 + 0.01).toFixed(4); // (0.01, 200.01)
      const cap = +(rng() * 50 + 0.01).toFixed(4);
      const d = planFromSignal(sig({ size_usd: requested }), { maxTradeUsd: cap });
      expect(d.accepted).toBe(true);
      expect(d.order!.sizeUsd).toBeLessThanOrEqual(cap);
      expect(d.order!.sizeUsd).toBe(Math.min(requested, cap));
    }
  });

  it("when requested < cap the full requested size passes through untouched", () => {
    const d = planFromSignal(sig({ size_usd: 1.25 }), { maxTradeUsd: 10 });
    expect(d.order!.sizeUsd).toBe(1.25);
  });

  it("exactly-at-cap requests are kept (min is inclusive)", () => {
    const d = planFromSignal(sig({ size_usd: 2 }), { maxTradeUsd: 2 });
    expect(d.order!.sizeUsd).toBe(2);
  });

  it("a zero or negative cap clamps any accepted size down to <= 0", () => {
    // size_usd>0 passes the size gate, but Math.min with a 0 cap yields 0.
    const d = planFromSignal(sig({ size_usd: 5 }), { maxTradeUsd: 0 });
    expect(d.accepted).toBe(true);
    expect(d.order!.sizeUsd).toBe(0);
  });
});

describe("planFromSignal — size_usd gate", () => {
  it("missing size_usd defaults to 0 and is rejected", () => {
    const d = planFromSignal(sig({ size_usd: undefined }), OPTS);
    expect(d.accepted).toBe(false);
    expect(d.reason).toContain("size_usd");
  });

  it("rejects negative and NaN sizes", () => {
    expect(planFromSignal(sig({ size_usd: -3 }), OPTS).accepted).toBe(false);
    expect(planFromSignal(sig({ size_usd: NaN as number }), OPTS).accepted).toBe(false);
  });
});

describe("regimeOf — normalization", () => {
  it("uppercases asset, lowercases recurrence, joined by ':'", () => {
    expect(regimeOf(sig({ asset: "sol", recurrence: "5M" }))).toBe("SOL:5m");
    expect(regimeOf(sig({ asset: "BtC", recurrence: "15M" }))).toBe("BTC:15m");
  });

  it("missing asset/recurrence degrade to empty halves, never throws", () => {
    expect(regimeOf(sig({ asset: undefined, recurrence: undefined }))).toBe(":");
    expect(regimeOf(sig({ asset: "eth", recurrence: undefined }))).toBe("ETH:");
    expect(regimeOf({ side: "UP" } as GoldenSignal)).toBe(":");
  });

  it("is idempotent — normalizing an already-normalized regime is a fixed point", () => {
    const once = regimeOf(sig({ asset: "sol", recurrence: "5M" }));
    const [a, r] = once.split(":");
    const twice = regimeOf(sig({ asset: a, recurrence: r }));
    expect(twice).toBe(once);
  });
});

describe("allowlist — hard wall semantics", () => {
  it("entries are trimmed + uppercased before comparison", () => {
    const d = planFromSignal(
      sig({ asset: "sol", recurrence: "5m" }),
      { maxTradeUsd: 2, allow: ["  sol:5m  "] },
    );
    expect(d.accepted).toBe(true);
  });

  it("an allowlist of only blank/whitespace entries collapses to disabled (allow all)", () => {
    const d = planFromSignal(
      sig({ asset: "BTC", recurrence: "99m" }),
      { maxTradeUsd: 2, allow: ["", "   "] },
    );
    expect(d.accepted).toBe(true); // filter(Boolean) drops them → length 0 → no restriction
  });

  it("rejects EVERY non-listed regime drawn pseudo-randomly (seeded)", () => {
    const rng = lcg(42);
    const assets = ["BTC", "ETH", "SOL", "DOGE", "AVAX"];
    const recs = ["5m", "15m", "1h", "4h"];
    let rejected = 0;
    for (let i = 0; i < 40; i++) {
      const asset = assets[Math.floor(rng() * assets.length)];
      const rec = recs[Math.floor(rng() * recs.length)];
      const regime = `${asset}:${rec}`;
      const d = planFromSignal(sig({ asset, recurrence: rec }), { maxTradeUsd: 2, allow: ["LTC:30m"] });
      if (regime !== "LTC:30M") {
        expect(d.accepted).toBe(false);
        expect(d.reason).toContain("not in allowlist");
        rejected++;
      }
    }
    expect(rejected).toBe(40); // none of the drawn regimes is the single allowed one
  });

  it("only the listed regime among many is accepted", () => {
    const allow = { maxTradeUsd: 2, allow: ["SOL:5m", "ETH:15m"] };
    expect(planFromSignal(sig({ asset: "SOL", recurrence: "5m" }), allow).accepted).toBe(true);
    expect(planFromSignal(sig({ asset: "ETH", recurrence: "15m" }), allow).accepted).toBe(true);
    expect(planFromSignal(sig({ asset: "ETH", recurrence: "5m" }), allow).accepted).toBe(false);
    expect(planFromSignal(sig({ asset: "BTC", recurrence: "15m" }), allow).accepted).toBe(false);
  });
});

describe("dedupKey — per-window identity", () => {
  it("composes regimeOf + '@' + window_end_ts", () => {
    expect(dedupKey(sig({ asset: "sol", recurrence: "5M", window_end_ts: 1780242300 })))
      .toBe("SOL:5m@1780242300");
  });

  it("null only when window_end_ts is null/undefined (0 is a real, dedupable window)", () => {
    expect(dedupKey(sig({ window_end_ts: undefined }))).toBeNull();
    expect(dedupKey(sig({ window_end_ts: null as unknown as number }))).toBeNull();
    expect(dedupKey(sig({ window_end_ts: 0 }))).toBe("SOL:5m@0"); // 0 != null → dedupable
  });

  it("distinct (regime, window) pairs map to distinct keys; same pair collides", () => {
    const a = dedupKey(sig({ asset: "SOL", recurrence: "5m", window_end_ts: 100 }));
    const b = dedupKey(sig({ asset: "SOL", recurrence: "5m", window_end_ts: 100 }));
    const c = dedupKey(sig({ asset: "ETH", recurrence: "5m", window_end_ts: 100 }));
    const e = dedupKey(sig({ asset: "SOL", recurrence: "5m", window_end_ts: 200 }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(e);
  });
});

describe("determinism — pure function, no hidden state", () => {
  it("planFromSignal is referentially transparent across repeated identical calls", () => {
    const base = sig({ size_usd: 37 });
    const first = JSON.stringify(planFromSignal(base, { maxTradeUsd: 5 }));
    for (let i = 0; i < 25; i++) {
      expect(JSON.stringify(planFromSignal(base, { maxTradeUsd: 5 }))).toBe(first);
    }
  });

  it("randomized but seeded inputs are reproducible and never throw", () => {
    const rng = lcg(0xBADC0DE);
    const sides = ["UP", "DOWN", "YES", "NO", "BOGUS", ""];
    const out: string[] = [];
    for (let i = 0; i < 50; i++) {
      const s = sig({
        side: sides[Math.floor(rng() * sides.length)],
        entry_price: +(rng() * 1.4 - 0.2).toFixed(4), // spans below 0 and above 1
        size_usd: +(rng() * 10 - 1).toFixed(4),
        readiness_ok: rng() > 0.2,
      });
      out.push(JSON.stringify(planFromSignal(s, { maxTradeUsd: 3 })));
    }
    // Re-run with the SAME seed → identical transcript (fully deterministic).
    const rng2 = lcg(0xBADC0DE);
    const out2: string[] = [];
    for (let i = 0; i < 50; i++) {
      const s = sig({
        side: sides[Math.floor(rng2() * sides.length)],
        entry_price: +(rng2() * 1.4 - 0.2).toFixed(4),
        size_usd: +(rng2() * 10 - 1).toFixed(4),
        readiness_ok: rng2() > 0.2,
      });
      out2.push(JSON.stringify(planFromSignal(s, { maxTradeUsd: 3 })));
    }
    expect(out2).toEqual(out);
  });

  it("does not mutate its input signal or opts", () => {
    const input = sig({ size_usd: 99 });
    const snapshot = JSON.stringify(input);
    const opts = { maxTradeUsd: 2, allow: ["SOL:5m"] };
    const optsSnapshot = JSON.stringify(opts);
    planFromSignal(input, opts);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(JSON.stringify(opts)).toBe(optsSnapshot);
  });
});

describe("accepted order — structural invariants", () => {
  it("always BUYs the supplied token_id with a string rationale", () => {
    const d = planFromSignal(sig({ token_id: "0xDEADBEEF" }), OPTS);
    expect(d.accepted).toBe(true);
    expect(d.order!.side).toBe("BUY");
    expect(d.order!.tokenId).toBe("0xDEADBEEF");
    expect(typeof d.order!.rationale).toBe("string");
    expect(d.reason).toBe("ok");
  });

  it("rationale embeds asset:recurrence, side, and prob/edge markers", () => {
    const d = planFromSignal(sig({ asset: "ETH", recurrence: "15m", side: "no", est_win_prob: 0.7, edge: 0.05 }), OPTS);
    expect(d.order!.rationale).toContain("ETH:15m");
    expect(d.order!.rationale).toContain("NO");
    expect(d.order!.rationale).toContain("p=0.7");
    expect(d.order!.rationale).toContain("edge=0.05");
  });

  it("missing optional prob/edge fall back to '?' placeholders, still accepts", () => {
    const d = planFromSignal(sig({ est_win_prob: undefined, edge: undefined }), OPTS);
    expect(d.accepted).toBe(true);
    expect(d.order!.rationale).toContain("p=?");
    expect(d.order!.rationale).toContain("edge=?");
  });
});
