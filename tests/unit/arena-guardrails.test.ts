/**
 * Mental-bug guardrails from the Lunar article — encoded as unit tests so
 * regressions are caught early. Each test names the bug it locks out.
 *
 * Article-listed bugs:
 *   1. Base Rate Neglect
 *   2. Sunk Cost Fallacy
 *   3. Survivorship Bias
 *   4. Copying Without Filtering
 *   5. Overfitting
 *
 * PRD: docs/prds/lunar-inspired-arena-strategies.md §6.6.R6 + IMPLEMENTATION
 * Phase 9.
 */
import { describe, expect, it } from "vitest";
import { applySignal, decide } from "@/lib/arena/sim";
import { applyRiskRails } from "@/lib/arena/risk-wrapper";
import type { LiveAgent, Position, Signal, Snapshot, SnapshotWindow, TickContext } from "@/lib/arena/types";

// ── helpers ────────────────────────────────────────────────────────────────
function makeCtx(marketId: string, price: number, history: number[] = [], category = "crypto"): TickContext {
  const baseTime = new Date("2026-05-25T22:00:00Z").getTime();
  const snaps: Snapshot[] = history.map((p, i) => ({
    venue: "sim-poly" as const, market_id: marketId, price: p, category,
    captured_at: new Date(baseTime + i * 5 * 60_000).toISOString(),
  }));
  const latest: Snapshot = {
    venue: "sim-poly", market_id: marketId, price, category,
    captured_at: new Date(baseTime + history.length * 5 * 60_000).toISOString(),
  };
  return {
    now: new Date(baseTime + (history.length + 1) * 5 * 60_000).toISOString(),
    snapshots: new Map([[marketId, { history: [...snaps, latest], latest }]]),
  };
}

function makeAgentWithPosition(position: Position, cash = 800): LiveAgent {
  return {
    id: 1, name: "test-agent", generation: 0, parent_paper_agent_id: null,
    genome_json: "{}", introduced_by: "test",
    cash_usd_start: 1000, cash_usd_current: cash, position_basket_json: "[]",
    realized_pnl_usd: 0, unrealized_pnl_usd: 0,
    peak_equity_usd: 1000, max_drawdown_usd: 0,
    trades_count: 0, entries_count: 1, wins_count: 0,
    alive: 1, retire_reason: null, retired_at: null,
    created_at: "", updated_at: "",
    genome: { kind: "poly_fade_spike", params: { threshold_pts: 3, lookback_h: 6, confirm_quiet_h: 2, entry_size_usd: 20, exit_target_pts: 2, stop_pts: 4, time_stop_h: 24 } },
    positions: [position],
  };
}

// ── Bug #2: Sunk Cost Fallacy ──────────────────────────────────────────────
describe("Bug #2: Sunk Cost Fallacy guardrail", () => {
  it("exits a -50% position on the same criteria as +50% (target hit)", () => {
    // Position bought at 0.40, target 0.50 (target_pts above), stop 0.30
    const pos: Position = {
      venue: "sim-poly", market_id: "m1", side: "BUY", size_usd: 100,
      entry_price: 0.40, opened_at: "2026-05-25T22:00:00Z",
      target_price: 0.50, stop_price: 0.30,
    };
    // Price is now AT target — should exit
    const ctx = makeCtx("m1", 0.50);
    const agent = makeAgentWithPosition(pos);
    const sig = decide(agent, ctx, () => 0.5);
    expect(sig.kind).toBe("exit");
  });

  it("exits a deep loser at stop the SAME way as a winner at target", () => {
    // Position bought at 0.40, stop 0.30, target 0.50
    const pos: Position = {
      venue: "sim-poly", market_id: "m1", side: "BUY", size_usd: 100,
      entry_price: 0.40, opened_at: "2026-05-25T22:00:00Z",
      target_price: 0.50, stop_price: 0.30,
    };
    // Price hits stop — should exit
    const ctx = makeCtx("m1", 0.29);
    const agent = makeAgentWithPosition(pos);
    const sig = decide(agent, ctx, () => 0.5);
    expect(sig.kind).toBe("exit");
    // Critically, no "let it run because of sunk cost" logic — exit fires
    // even though position is at a 27.5% loss
  });

  it("does NOT exit on entry_price proximity (no 'recover to breakeven' rule)", () => {
    // Position underwater at -25%, but price approaching entry. No "exit at
    // breakeven" rule should fire — only target/stop/time matter.
    const pos: Position = {
      venue: "sim-poly", market_id: "m1", side: "BUY", size_usd: 100,
      entry_price: 0.40, opened_at: "2026-05-25T22:00:00Z",
      target_price: 0.50, stop_price: 0.30,
    };
    const ctx = makeCtx("m1", 0.41); // just above entry — no target/stop
    const agent = makeAgentWithPosition(pos);
    const sig = decide(agent, ctx, () => 0.5);
    // Either hold (no exit signal) or an entry signal — but NOT an exit
    expect(sig.kind).not.toBe("exit");
  });
});

// ── Bug #1: Base Rate Neglect ──────────────────────────────────────────────
describe("Bug #1: Base Rate Neglect guardrail (extreme-probability cap)", () => {
  it("rail engages on a confident 97% pTrue BUT clamps size to $10", () => {
    // pMarket 0.30, pTrue 0.97 — extreme prob. Confidence='high' so rail
    // engages, but extreme-probability guardrail caps size at $10 regardless
    // of what Kelly recommends.
    const ctx = makeCtx("m1", 0.30);
    const agent: LiveAgent = {
      id: 1, name: "x", generation: 0, parent_paper_agent_id: null,
      genome_json: "{}", introduced_by: "test",
      cash_usd_start: 1000, cash_usd_current: 1000, position_basket_json: "[]",
      realized_pnl_usd: 0, unrealized_pnl_usd: 0, peak_equity_usd: 1000,
      max_drawdown_usd: 0, trades_count: 0, entries_count: 0, wins_count: 0,
      alive: 1, retire_reason: null, retired_at: null, created_at: "", updated_at: "",
      genome: { kind: "random_walk_baseline", params: { trade_prob: 0.05, buy_bias_pct: 0.5, entry_size_usd: 10 } },
      positions: [],
    };
    const sig: Signal = {
      kind: "entry", venue: "sim-poly", market_id: "m1", side: "BUY", size_usd: 200,
      rationale: "test", pTrueEstimate: { pTrue: 0.97, confidence: "high", source: "test" },
    };
    const r = applyRiskRails(sig, ctx, agent);
    expect(r.kept).toBe(true);
    if (r.kept && r.signal.kind === "entry") {
      expect(r.signal.size_usd).toBeLessThanOrEqual(10); // extreme cap
    }
  });

  it("rail BLOCKS extreme pTrue when confidence is not 'high'", () => {
    const ctx = makeCtx("m1", 0.30);
    const agent: LiveAgent = {
      id: 1, name: "x", generation: 0, parent_paper_agent_id: null,
      genome_json: "{}", introduced_by: "test",
      cash_usd_start: 1000, cash_usd_current: 1000, position_basket_json: "[]",
      realized_pnl_usd: 0, unrealized_pnl_usd: 0, peak_equity_usd: 1000,
      max_drawdown_usd: 0, trades_count: 0, entries_count: 0, wins_count: 0,
      alive: 1, retire_reason: null, retired_at: null, created_at: "", updated_at: "",
      genome: { kind: "random_walk_baseline", params: { trade_prob: 0.05, buy_bias_pct: 0.5, entry_size_usd: 10 } },
      positions: [],
    };
    const sig: Signal = {
      kind: "entry", venue: "sim-poly", market_id: "m1", side: "BUY", size_usd: 100,
      rationale: "test", pTrueEstimate: { pTrue: 0.97, confidence: "medium", source: "test" },
    };
    const r = applyRiskRails(sig, ctx, agent);
    expect(r.kept).toBe(false);
    if (!r.kept) expect(r.reason).toMatch(/extreme/);
  });

  it("LLM oracle decide() respects confidence='low' rule (rule 3 from prompt v1)", async () => {
    const { _clearOracleCache, _seedOracleCache } = await import("@/lib/arena/llm-oracle");
    _clearOracleCache();
    _seedOracleCache("m1", "v1", { probability: 0.95, confidence: "low", reasoning: "test" });
    const agent: LiveAgent = {
      id: 1, name: "x", generation: 0, parent_paper_agent_id: null,
      genome_json: "{}", introduced_by: "test",
      cash_usd_start: 1000, cash_usd_current: 1000, position_basket_json: "[]",
      realized_pnl_usd: 0, unrealized_pnl_usd: 0, peak_equity_usd: 1000,
      max_drawdown_usd: 0, trades_count: 0, entries_count: 0, wins_count: 0,
      alive: 1, retire_reason: null, retired_at: null, created_at: "", updated_at: "",
      genome: { kind: "llm_probability_oracle", params: { model: "claude-sonnet-4-6", min_ev_pct: 0.05, max_calls_per_tick: 1, prompt_version: "v1", cache_ttl_min: 60, entry_size_usd: 25 } },
      positions: [],
    };
    const ctx = makeCtx("m1", 0.30);
    const sig = decide(agent, ctx, Math.random);
    expect(sig.kind).toBe("hold"); // low confidence → no entry, even at 95% prob
  });
});

// ── Bug #5: Overfitting ────────────────────────────────────────────────────
describe("Bug #5: Overfitting guardrail", () => {
  it("wallet_copy_filtered requires min_source_trades before copying", async () => {
    // Genome demands min_source_trades=20. If wallet has only 3 trades in the
    // category, genome holds — won't copy a tiny sample. This is enforced in
    // decideWalletCopyFiltered via the stats.trades_count check.
    // Schema enforces min_source_trades >= 5 (lower bound).
    const { GenomeSchema } = await import("@/lib/arena/genome");
    const result = GenomeSchema.safeParse({
      kind: "wallet_copy_filtered",
      params: {
        wallet_address: "0xb55fa1296e6ec55d0ce53d93b9237389f11764d4",
        copy_category: "crypto", size_pct_of_source: 0.01, max_size_usd: 10,
        delay_min: 30, min_source_win_rate: 0.55, min_source_trades: 3, // BELOW lower bound
      },
    });
    expect(result.success).toBe(false); // schema rejects min_source_trades < 5
  });
});

// ── Bug #4: Copying Without Filtering ──────────────────────────────────────
describe("Bug #4: Copying Without Filtering guardrail", () => {
  it("wallet_copy_filtered requires copy_category (no naive mirror)", async () => {
    const { GenomeSchema } = await import("@/lib/arena/genome");
    // Schema requires copy_category — can't construct genome without it.
    const r1 = GenomeSchema.safeParse({
      kind: "wallet_copy_filtered",
      params: {
        wallet_address: "0xb55fa1296e6ec55d0ce53d93b9237389f11764d4",
        // copy_category missing
        size_pct_of_source: 0.01, max_size_usd: 10, delay_min: 30,
        min_source_win_rate: 0.55, min_source_trades: 10,
      },
    });
    expect(r1.success).toBe(false);
  });
});
