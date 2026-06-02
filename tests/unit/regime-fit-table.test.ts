import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRegimeFitTableFromRows, lookupLearnedFit, saveRegimeFitTable, loadRegimeFitTable,
  activeRegimeFitTable, type RegimeFitTable,
} from "@/lib/decision/regime-fit-table";
import { betaLowerBound } from "@/lib/meta/strategy-allocator";
import type { LabeledDecision } from "@/lib/decision/calibration";

const PRIOR = { z: 1.96, priorAlpha: 2, priorBeta: 2 };
const row = (kind: string, regime: string, won: boolean, i: number): LabeledDecision =>
  ({ id: i, approval_score: 0.5, decision: "X", won, strategy_kind: kind, regime });
const rows = (kind: string, regime: string, wins: number, total: number, start = 0): LabeledDecision[] =>
  Array.from({ length: total }, (_, i) => row(kind, regime, i < wins, start + i));

describe("regime-fit-table — build (parity-drop + betaLowerBound reuse)", () => {
  it("aggregates genome-kind cells and DROPS venue-vocabulary rows", () => {
    const t = buildRegimeFitTableFromRows([
      ...rows("poly_fade_spike", "trending", 30, 40),       // genome kind → kept
      ...rows("sim-poly", "trending", 5, 10, 100),          // venue vocab → dropped
      ...rows("cb_momentum_burst", "chop", 12, 20, 200),    // genome kind → kept
    ], { minTrades: 30 });
    expect(Object.keys(t.cells).sort()).toEqual(["cb_momentum_burst|chop", "poly_fade_spike|trending"]);
    expect(t.dropped).toBe(10);                              // the 10 venue rows
    // LCB is computed via the build-3 betaLowerBound, NOT a re-implementation
    expect(t.cells["poly_fade_spike|trending"]).toEqual({ n: 40, wins: 30, lcb: betaLowerBound(30, 10, PRIOR) });
  });

  it("LCB is conservative (reuse semantics): 0/10 ≈ 0, 6/10 < raw 0.6", () => {
    const t = buildRegimeFitTableFromRows([
      ...rows("poly_fade_spike", "unknown", 0, 10),
      ...rows("cb_momentum_burst", "unknown", 6, 10, 50),
    ]);
    expect(t.cells["poly_fade_spike|unknown"].lcb).toBeLessThan(0.2);
    expect(t.cells["cb_momentum_burst|unknown"].lcb).toBeLessThan(0.6);   // shrunk below raw 0.6
    expect(t.cells["cb_momentum_burst|unknown"].lcb).toBeGreaterThan(0.2);
  });

  it("drops rows with no regime / no strategy_kind", () => {
    const t = buildRegimeFitTableFromRows([
      ...rows("poly_fade_spike", "trending", 1, 1),
      { id: 99, approval_score: 0.5, decision: "X", won: true, strategy_kind: "poly_fade_spike" }, // no regime
      { id: 98, approval_score: 0.5, decision: "X", won: true, regime: "trending" },               // no kind
    ]);
    expect(t.dropped).toBe(2);
    expect(Object.keys(t.cells)).toEqual(["poly_fade_spike|trending"]);
  });
});

describe("regime-fit-table — lookupLearnedFit (gates)", () => {
  const table = buildRegimeFitTableFromRows([
    ...rows("poly_fade_spike", "trending", 30, 40),     // dense, in-vocab
    ...rows("cb_momentum_burst", "chop", 6, 10, 100),   // thin (n=10 < 30)
  ], { minTrades: 30 });

  it("returns the LCB for a dense, in-vocab cell", () => {
    const r = lookupLearnedFit(table, "poly_fade_spike", "trending");
    expect(r).not.toBeNull();
    expect(r!.n).toBe(40);
    expect(r!.score).toBe(table.cells["poly_fade_spike|trending"].lcb);
  });
  it("returns null for a thin cell (n < minTrades) → caller falls back", () => {
    expect(lookupLearnedFit(table, "cb_momentum_burst", "chop")).toBeNull();
  });
  it("returns null for a strategy_kind NOT in SUB_GENOME_KINDS (parity guard) even if a cell exists", () => {
    const t2: RegimeFitTable = { ...table, cells: { ...table.cells, "sim-poly|trending": { n: 99, wins: 80, lcb: 0.7 } } };
    expect(lookupLearnedFit(t2, "sim-poly", "trending")).toBeNull();
  });
  it("returns null for a missing cell", () => {
    expect(lookupLearnedFit(table, "poly_fade_spike", "chop")).toBeNull();
  });
});

describe("regime-fit-table — scaffolding reality (the n=25 / minTrades=30 no-op)", () => {
  // Mirrors the real ledger: ~25 rows, all regime='unknown', mixed venue+genome kinds.
  const ledger = [
    ...rows("poly_fade_spike", "unknown", 0, 10),
    ...rows("poly_short_binary_directional", "unknown", 6, 10, 100),
    ...rows("random_walk_baseline", "unknown", 1, 4, 200),
    ...rows("sim-poly", "unknown", 2, 5, 300),           // venue rows → dropped
  ];
  it("at minTrades=30: 0 cells qualify (table is a deliberate no-op); venue rows dropped", () => {
    const t = buildRegimeFitTableFromRows(ledger, { minTrades: 30 });
    expect(t.dropped).toBe(5);
    expect(Object.keys(t.cells).filter((k) => t.cells[k].n >= 30)).toHaveLength(0);
  });
  it("at minTrades=5: the two n=10 cells qualify (the knob re-introduces noisy cells)", () => {
    const t = buildRegimeFitTableFromRows(ledger, { minTrades: 5 });
    const qualifying = Object.keys(t.cells).filter((k) => t.cells[k].n >= 5);
    expect(qualifying.sort()).toEqual(["poly_fade_spike|unknown", "poly_short_binary_directional|unknown"]);
  });
});

describe("regime-fit-table — activeRegimeFitTable env-gate (the production accessor)", () => {
  it("returns undefined (without touching the filesystem) unless ARENA_REGIME_FIT_TABLE=1", () => {
    const prev = process.env.ARENA_REGIME_FIT_TABLE;
    try {
      delete process.env.ARENA_REGIME_FIT_TABLE;
      expect(activeRegimeFitTable()).toBeUndefined();   // unset → off
      process.env.ARENA_REGIME_FIT_TABLE = "0";
      expect(activeRegimeFitTable()).toBeUndefined();   // any non-"1" → off (env checked before cache/fs)
    } finally {
      if (prev === undefined) delete process.env.ARENA_REGIME_FIT_TABLE;
      else process.env.ARENA_REGIME_FIT_TABLE = prev;
    }
  });
});

describe("regime-fit-table — store fail-safe", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rft-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("round-trips save/load", () => {
    const t = buildRegimeFitTableFromRows(rows("poly_fade_spike", "trending", 30, 40), { minTrades: 30 });
    const p = join(dir, "regime-fit-table.json");
    saveRegimeFitTable(t, p);
    expect(loadRegimeFitTable(p)?.cells["poly_fade_spike|trending"].n).toBe(40);
  });
  it("missing file → undefined (never throws)", () => {
    expect(loadRegimeFitTable(join(dir, "nope.json"))).toBeUndefined();
  });
  it("corrupt JSON → undefined (never throws)", () => {
    const p = join(dir, "bad.json"); writeFileSync(p, "{not json");
    expect(loadRegimeFitTable(p)).toBeUndefined();
  });
  it("wrong-shape JSON → undefined", () => {
    const p = join(dir, "wrong.json"); writeFileSync(p, JSON.stringify({ foo: 1 }));
    expect(loadRegimeFitTable(p)).toBeUndefined();
  });
});
