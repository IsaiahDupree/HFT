/**
 * Tests for the gated decision system foundation (Phase 1):
 *   - Gate result envelope helpers (pass, reject, reduce, wait, killSwitch)
 *   - DEFAULT_GATE_WEIGHTS invariant (sums to 1.0)
 *   - decision_journal round-trip: insert via recordDecision, read via
 *     readRecentDecisions, with filters
 *   - attachOrderId post-submit patch
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMemoryDb } from "../helpers/db";

let memDb: ReturnType<typeof makeMemoryDb> | null = null;

vi.mock("@/lib/db/client", () => ({
  db: () => {
    if (!memDb) memDb = makeMemoryDb();
    return memDb;
  },
  closeDb: () => {
    memDb?.close();
    memDb = null;
  },
}));

import {
  DEFAULT_GATE_WEIGHTS,
  Gate,
  type DecisionContext,
  type DecisionResult,
  type GateResult,
} from "@/lib/decision/types";
import {
  attachOrderId,
  readRecentDecisions,
  recordDecision,
} from "@/lib/decision/journal";

beforeEach(() => {
  memDb?.close();
  memDb = null;
});

afterEach(() => {
  memDb?.close();
  memDb = null;
});

describe("Gate result helpers", () => {
  it("Gate.pass returns CONTINUE with clamped score", () => {
    const g = Gate.pass("regime", 0.85, "trending market");
    expect(g.gate).toBe("regime");
    expect(g.status).toBe("pass");
    expect(g.action).toBe("CONTINUE");
    expect(g.score).toBe(0.85);
    expect(g.reason).toBe("trending market");
  });

  it("Gate.pass clamps scores above 1 to 1 and below 0 to 0", () => {
    expect(Gate.pass("g", 1.5, "x").score).toBe(1);
    expect(Gate.pass("g", -0.2, "x").score).toBe(0);
    expect(Gate.pass("g", Number.NaN, "x").score).toBe(0);
  });

  it("Gate.reject always returns score 0 + REJECT", () => {
    const g = Gate.reject("risk", "daily cap breached");
    expect(g.status).toBe("fail");
    expect(g.score).toBe(0);
    expect(g.action).toBe("REJECT");
  });

  it("Gate.reduce returns partial + REDUCE_SIZE", () => {
    const g = Gate.reduce("risk", 0.6, "drawdown elevated", { drawdown_pct: 0.08 });
    expect(g.status).toBe("partial");
    expect(g.action).toBe("REDUCE_SIZE");
    expect(g.details).toEqual({ drawdown_pct: 0.08 });
  });

  it("Gate.wait returns partial + WAIT with score 0", () => {
    const g = Gate.wait("data_quality", "price feed stale");
    expect(g.status).toBe("partial");
    expect(g.action).toBe("WAIT");
    expect(g.score).toBe(0);
  });

  it("Gate.killSwitch returns fail + KILL_SWITCH", () => {
    const g = Gate.killSwitch("risk", "global drawdown 12%");
    expect(g.status).toBe("fail");
    expect(g.action).toBe("KILL_SWITCH");
  });
});

describe("DEFAULT_GATE_WEIGHTS invariant", () => {
  it("weights sum to 1.0 (within floating tolerance)", () => {
    const sum = Object.values(DEFAULT_GATE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 6);
  });
  it("every weight is non-negative", () => {
    for (const w of Object.values(DEFAULT_GATE_WEIGHTS)) {
      expect(w).toBeGreaterThanOrEqual(0);
    }
  });
});

function mkCtx(over: Partial<DecisionContext> = {}): DecisionContext {
  return {
    agentId: 42,
    capsuleId: "cap-test-001",
    strategyKind: "poly_short_binary_directional",
    strategyVersionId: 7,
    proposal: {
      venue: "polymarket",
      symbol: "0xCONDITION",
      side: "BUY",
      sizeUsd: 2.0,
      price: 0.52,
      conditionId: "0xCONDITION",
      metadata: { rationale: "test" },
    },
    snapshot: { midPrice: 0.52, liquidityUsd: 5000 },
    ts: "2026-05-27T13:00:00Z",
    ...over,
  };
}

function mkResult(
  decision: DecisionResult["decision"],
  approvalScore: number,
  sizeMultiplier: number,
  gateResults: GateResult[] = [Gate.pass("test", 0.9, "ok")],
): DecisionResult {
  return {
    decision,
    approval_score: approvalScore,
    size_multiplier: sizeMultiplier,
    gate_results: gateResults,
    decision_ts: "2026-05-27T13:00:00Z",
  };
}

describe("decision_journal round-trip", () => {
  it("recordDecision writes a row that readRecentDecisions returns", () => {
    const ctx = mkCtx();
    const r = mkResult("APPROVED_FULL", 0.87, 1.0);
    const id = recordDecision(ctx, r);
    expect(id).toBeGreaterThan(0);

    const rows = readRecentDecisions({ limit: 10 });
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.capsule_id).toBe("cap-test-001");
    expect(row.decision).toBe("APPROVED_FULL");
    expect(row.approval_score).toBeCloseTo(0.87, 6);
    expect(row.size_multiplier).toBe(1.0);
    expect(row.proposed_size_usd).toBe(2.0);
    expect(row.approved_size_usd).toBe(2.0); // 2.0 × 1.0
    expect(row.strategy_kind).toBe("poly_short_binary_directional");
    expect(row.venue).toBe("polymarket");
    expect(row.order_id).toBeNull();
  });

  it("approved_size_usd = proposed × size_multiplier for REDUCED decisions", () => {
    const ctx = mkCtx({ proposal: { ...mkCtx().proposal, sizeUsd: 5.0 } });
    const r = mkResult("APPROVED_REDUCED", 0.72, 0.5);
    recordDecision(ctx, r);

    const rows = readRecentDecisions({ limit: 1 });
    expect(rows[0]!.approved_size_usd).toBeCloseTo(2.5, 6);
    expect(rows[0]!.proposed_size_usd).toBeCloseTo(5.0, 6);
  });

  it("REJECTED decisions land with size_multiplier=0 and approved_size_usd=0", () => {
    const ctx = mkCtx();
    const r = mkResult("REJECTED", 0.32, 0.0, [
      Gate.reject("risk", "circuit breaker tripped"),
    ]);
    recordDecision(ctx, r);

    const rows = readRecentDecisions({ decision: "REJECTED" });
    expect(rows.length).toBe(1);
    expect(rows[0]!.approved_size_usd).toBe(0);
    const gateResults = JSON.parse(rows[0]!.gate_results_json) as GateResult[];
    expect(gateResults[0]!.gate).toBe("risk");
    expect(gateResults[0]!.action).toBe("REJECT");
  });

  it("proposal_json + snapshot_json + gate_results_json round-trip cleanly", () => {
    const ctx = mkCtx();
    const r = mkResult("APPROVED_FULL", 0.9, 1.0, [
      Gate.pass("regime", 1.0, "trending", { regime: "trending" }),
      Gate.pass("edge", 0.85, "edge 8pp"),
    ]);
    recordDecision(ctx, r);
    const row = readRecentDecisions({ limit: 1 })[0]!;

    const proposal = JSON.parse(row.proposal_json);
    expect(proposal.venue).toBe("polymarket");
    expect(proposal.sizeUsd).toBe(2.0);
    expect(proposal.metadata).toEqual({ rationale: "test" });

    const snap = JSON.parse(row.snapshot_json!);
    expect(snap.midPrice).toBe(0.52);

    const gates = JSON.parse(row.gate_results_json) as GateResult[];
    expect(gates).toHaveLength(2);
    expect(gates[0]!.details).toEqual({ regime: "trending" });
  });

  it("filters: by capsuleId, by decision, by strategyKind", () => {
    recordDecision(mkCtx({ capsuleId: "cap-A" }), mkResult("APPROVED_FULL", 0.9, 1.0));
    recordDecision(mkCtx({ capsuleId: "cap-B" }), mkResult("REJECTED", 0.3, 0.0));
    recordDecision(
      mkCtx({ capsuleId: "cap-A", strategyKind: "midwindow_trajectory" }),
      mkResult("APPROVED_REDUCED", 0.7, 0.5),
    );

    expect(readRecentDecisions({ capsuleId: "cap-A" }).length).toBe(2);
    expect(readRecentDecisions({ capsuleId: "cap-B" }).length).toBe(1);
    expect(readRecentDecisions({ decision: "REJECTED" }).length).toBe(1);
    expect(
      readRecentDecisions({ strategyKind: "midwindow_trajectory" }).length,
    ).toBe(1);
  });

  it("sinceTs filter respects ISO timestamp lower bound", () => {
    const r1 = mkResult("APPROVED_FULL", 0.9, 1.0);
    r1.decision_ts = "2026-05-27T10:00:00Z";
    recordDecision(mkCtx(), r1);

    const r2 = mkResult("APPROVED_FULL", 0.9, 1.0);
    r2.decision_ts = "2026-05-27T14:00:00Z";
    recordDecision(mkCtx(), r2);

    const recent = readRecentDecisions({ sinceTs: "2026-05-27T12:00:00Z" });
    expect(recent.length).toBe(1);
    expect(recent[0]!.ts).toBe("2026-05-27T14:00:00Z");
  });

  it("attachOrderId patches the order_id post-submit", () => {
    const id = recordDecision(mkCtx(), mkResult("APPROVED_FULL", 0.9, 1.0));
    attachOrderId(id, "order-abc-123");
    const row = readRecentDecisions({ limit: 1 })[0]!;
    expect(row.order_id).toBe("order-abc-123");
  });

  it("readRecentDecisions limit clamps at 500", () => {
    for (let i = 0; i < 3; i++) recordDecision(mkCtx(), mkResult("APPROVED_FULL", 0.9, 1.0));
    // Pass a huge limit; should not error, returns all 3.
    expect(readRecentDecisions({ limit: 100_000 }).length).toBe(3);
  });

  it("readRecentDecisions orders by ts DESC", () => {
    const r1 = mkResult("APPROVED_FULL", 0.9, 1.0);
    r1.decision_ts = "2026-05-27T10:00:00Z";
    recordDecision(mkCtx(), r1);

    const r2 = mkResult("APPROVED_FULL", 0.9, 1.0);
    r2.decision_ts = "2026-05-27T14:00:00Z";
    recordDecision(mkCtx(), r2);

    const rows = readRecentDecisions({});
    expect(rows[0]!.ts).toBe("2026-05-27T14:00:00Z");
    expect(rows[1]!.ts).toBe("2026-05-27T10:00:00Z");
  });
});
