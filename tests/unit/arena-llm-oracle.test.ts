import { beforeEach, describe, expect, it, vi } from "vitest";
import { _clearOracleCache, _seedOracleCache, peekOracleCache } from "@/lib/arena/llm-oracle";

describe("oracle cache", () => {
  beforeEach(() => _clearOracleCache());

  it("peek returns null on cold cache", () => {
    expect(peekOracleCache("m1", "v1")).toBeNull();
  });

  it("peek returns hot entries", () => {
    _seedOracleCache("m1", "v1", { probability: 0.62, confidence: "medium", reasoning: "test" });
    const hit = peekOracleCache("m1", "v1");
    expect(hit).not.toBeNull();
    expect(hit?.probability).toBe(0.62);
    expect(hit?.confidence).toBe("medium");
  });

  it("peek respects prompt_version isolation", () => {
    _seedOracleCache("m1", "v1", { probability: 0.62, confidence: "medium", reasoning: "test" });
    expect(peekOracleCache("m1", "v2")).toBeNull(); // different version key
  });

  it("expires entries past TTL", () => {
    _seedOracleCache("m1", "v1", { probability: 0.5, confidence: "low", reasoning: "x" }, 0.001); // ~60ms TTL
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(peekOracleCache("m1", "v1")).toBeNull();
        resolve();
      }, 100);
    });
  });
});

describe("decideLlmProbabilityOracle (sync, cache-only)", () => {
  beforeEach(() => _clearOracleCache());

  it("returns hold when no cache entry exists", async () => {
    const { decide } = await import("@/lib/arena/sim");
    const agent = makeOracleAgent();
    const ctx = makePolyCtx("m1", 0.40);
    const sig = decide(agent, ctx, Math.random);
    expect(sig.kind).toBe("hold");
  });

  it("returns entry with pTrueEstimate when cache has a high-confidence prob", async () => {
    _seedOracleCache("m1", "v1", { probability: 0.62, confidence: "medium", reasoning: "test" });
    const { decide } = await import("@/lib/arena/sim");
    const agent = makeOracleAgent();
    const ctx = makePolyCtx("m1", 0.40);
    const sig = decide(agent, ctx, Math.random);
    expect(sig.kind).toBe("entry");
    if (sig.kind === "entry") {
      expect(sig.side).toBe("BUY");                   // pTrue 0.62 > pMarket 0.40
      expect(sig.pTrueEstimate?.pTrue).toBe(0.62);
      expect(sig.pTrueEstimate?.source).toBe("llm-oracle");
      expect(sig.rationale).toMatch(/oracle/);
    }
  });

  it("flips to SELL when pTrue < pMarket", async () => {
    _seedOracleCache("m1", "v1", { probability: 0.30, confidence: "high", reasoning: "test" });
    const { decide } = await import("@/lib/arena/sim");
    const agent = makeOracleAgent();
    const ctx = makePolyCtx("m1", 0.55);
    const sig = decide(agent, ctx, Math.random);
    if (sig.kind === "entry") expect(sig.side).toBe("SELL");
    else throw new Error("expected entry");
  });

  it("holds when confidence is 'low' (article rule 3)", async () => {
    _seedOracleCache("m1", "v1", { probability: 0.62, confidence: "low", reasoning: "test" });
    const { decide } = await import("@/lib/arena/sim");
    const sig = decide(makeOracleAgent(), makePolyCtx("m1", 0.40), Math.random);
    expect(sig.kind).toBe("hold");
  });

  it("respects category_filter", async () => {
    _seedOracleCache("m1", "v1", { probability: 0.62, confidence: "medium", reasoning: "test" });
    const { decide } = await import("@/lib/arena/sim");
    const agent = makeOracleAgent({ category_filter: "elections" });
    // ctx market has category "crypto"; agent only takes elections
    const ctx = makePolyCtx("m1", 0.40, "crypto");
    expect(decide(agent, ctx, Math.random).kind).toBe("hold");
  });
});

// ── helpers ────────────────────────────────────────────────────────────────
import type { LiveAgent, TickContext } from "@/lib/arena/types";

function makeOracleAgent(overrides: Record<string, unknown> = {}): LiveAgent {
  return {
    id: 1, name: "oracle-test", generation: 0, parent_paper_agent_id: null,
    genome_json: "{}", introduced_by: "test",
    cash_usd_start: 1000, cash_usd_current: 1000, position_basket_json: "[]",
    realized_pnl_usd: 0, unrealized_pnl_usd: 0,
    peak_equity_usd: 1000, max_drawdown_usd: 0,
    trades_count: 0, entries_count: 0, wins_count: 0,
    alive: 1, retire_reason: null, retired_at: null,
    created_at: "", updated_at: "",
    genome: {
      kind: "llm_probability_oracle",
      params: {
        model: "claude-sonnet-4-6",
        min_ev_pct: 0.05,
        max_calls_per_tick: 1,
        prompt_version: "v1",
        cache_ttl_min: 60,
        entry_size_usd: 25,
        ...overrides,
      },
    },
    positions: [],
  };
}

function makePolyCtx(marketId: string, price: number, category = "crypto"): TickContext {
  const snap = { venue: "sim-poly" as const, market_id: marketId, price, captured_at: "2026-05-25T23:00:00Z", category };
  return {
    now: "2026-05-25T23:00:00Z",
    snapshots: new Map([[marketId, { history: [snap], latest: snap }]]),
  };
}
