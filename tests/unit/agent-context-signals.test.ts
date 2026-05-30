/**
 * Tests for the new AgentContext signal arrays:
 *   - recentTypologies   (latest wallet-typology per wallet)
 *   - recentConsensusSignals
 *   - recentTradeClassifications
 *   - recentStrategyOpportunities
 *
 * Uses an in-memory SQLite shimmed via the makeMemoryDb test helper, seeds
 * synthetic evolution_log rows for each event_type, asserts the buildAgentContext
 * surfaces them correctly.
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

import * as dbModule from "@/lib/db/client";
import { buildAgentContext, summarizeContext } from "@/lib/agents/context";
import { insertEvolutionEvent } from "@/lib/db/queries";

beforeEach(() => {
  memDb?.close();
  memDb = null;
  const db = (dbModule as any).db();
  // Seed a minimal strategy so buildAgentContext doesn't blow up.
  db.prepare(`INSERT INTO agents (id, slug, name, charter) VALUES (1, 'test', 'Test', 'test charter')`).run();
  db.prepare(`INSERT INTO strategies (id, agent_id, slug, name, thesis, market_filter) VALUES (1, 1, 'test-strat', 'Test Strategy', 'test thesis', '{}')`).run();
  db.prepare(`INSERT INTO strategy_versions (id, strategy_id, version, spec_json, rationale, is_current) VALUES (1, 1, 1, '{}', 'test rationale', 1)`).run();
});
afterEach(() => {
  memDb?.close();
  memDb = null;
});

describe("AgentContext signal arrays", () => {
  it("recentTypologies returns the latest classification per wallet, deduped", () => {
    insertEvolutionEvent({
      event_type: "wallet-typology",
      summary: "wA → hft_bot",
      payload_json: JSON.stringify({
        wallet: "0xaa",
        primaryBucket: "hft_bot",
        copyabilityClass: "un_copyable",
        confidence: 0.9,
        features: { realizedPnlUsd: 100, portfolioValueUsd: 50 },
      }),
    });
    insertEvolutionEvent({
      event_type: "wallet-typology",
      summary: "wA → conviction_trader (newer)",
      payload_json: JSON.stringify({
        wallet: "0xaa",
        primaryBucket: "conviction_trader",
        copyabilityClass: "potentially_copyable",
        confidence: 0.95,
        features: { realizedPnlUsd: 2_000_000, portfolioValueUsd: 1_000_000 },
      }),
    });
    insertEvolutionEvent({
      event_type: "wallet-typology",
      summary: "wB",
      payload_json: JSON.stringify({
        wallet: "0xbb",
        primaryBucket: "hft_bot",
        copyabilityClass: "un_copyable",
        confidence: 0.85,
        features: { realizedPnlUsd: 500, portfolioValueUsd: null },
      }),
    });
    const ctx = buildAgentContext(1);
    expect(ctx.recentTypologies).toHaveLength(2);
    const wA = ctx.recentTypologies.find((t) => t.wallet === "0xaa");
    expect(wA?.primaryBucket).toBe("conviction_trader"); // most recent wins
    expect(wA?.realizedPnlUsd).toBe(2_000_000);
  });

  it("recentConsensusSignals returns only the last hour, sorted by effectiveWallets desc", () => {
    insertEvolutionEvent({
      event_type: "consensus-signal",
      summary: "low",
      payload_json: JSON.stringify({
        marketKey: "m1",
        direction: "YES",
        effectiveWallets: 3,
        combinedTrust: 6,
        combinedUsd: 1000,
        avgPrice: 0.55,
      }),
    });
    insertEvolutionEvent({
      event_type: "consensus-signal",
      summary: "high",
      payload_json: JSON.stringify({
        marketKey: "m2",
        direction: "NO",
        effectiveWallets: 7,
        combinedTrust: 15,
        combinedUsd: 5000,
        avgPrice: 0.42,
      }),
    });
    const ctx = buildAgentContext(1);
    expect(ctx.recentConsensusSignals).toHaveLength(2);
    expect(ctx.recentConsensusSignals[0].marketKey).toBe("m2"); // higher effectiveWallets first
    expect(ctx.recentConsensusSignals[0].effectiveWallets).toBe(7);
  });

  it("recentTradeClassifications surfaces from the observer worker", () => {
    insertEvolutionEvent({
      event_type: "wallet-trade-classified",
      summary: "trade",
      payload_json: JSON.stringify({
        wallet: "0xaa",
        trade: {
          marketKey: "m1",
          side: "BUY",
          direction: "YES",
          price: 0.55,
          usd: 100,
        },
        intent: { label: "accumulation", confidence: 0.85 },
        features: { likelyDrivers: ["cross-wallet consensus tail"] },
      }),
    });
    const ctx = buildAgentContext(1);
    expect(ctx.recentTradeClassifications).toHaveLength(1);
    expect(ctx.recentTradeClassifications[0].intent).toBe("accumulation");
    expect(ctx.recentTradeClassifications[0].topDriver).toContain("consensus tail");
  });

  it("recentStrategyOpportunities reads all 3 strategy event types and sorts by edge desc", () => {
    insertEvolutionEvent({
      event_type: "near-resolution-opportunity",
      summary: "nrs",
      payload_json: JSON.stringify({
        marketKey: "m1",
        marketTitle: "BTC reach $90K?",
        side: "NO",
        edge: 0.03,
        annualizedEdge: 1.5,
        reason: "near-resolution, NO @ 0.97",
      }),
    });
    insertEvolutionEvent({
      event_type: "cross-timeframe-spread",
      summary: "cts",
      payload_json: JSON.stringify({
        marketKey: "m2",
        side: "YES",
        edge: 0.08,
        signalStrength: 0.7,
        reason: "z=3.6 5m/15m spread",
      }),
    });
    insertEvolutionEvent({
      event_type: "orderbook-imbalance-signal",
      summary: "obi",
      payload_json: JSON.stringify({
        marketKey: "m3",
        side: "BUY",
        edge: 0.01,
        signalStrength: 0.55,
        reason: "imbalance 3.2:1 bid-heavy",
      }),
    });
    const ctx = buildAgentContext(1);
    expect(ctx.recentStrategyOpportunities).toHaveLength(3);
    expect(ctx.recentStrategyOpportunities[0].type).toBe("cross-timeframe-spread"); // edge=0.08 wins
    expect(ctx.recentStrategyOpportunities[0].edge).toBe(0.08);
    const types = new Set(ctx.recentStrategyOpportunities.map((o) => o.type));
    expect(types).toEqual(new Set(["near-resolution", "cross-timeframe-spread", "orderbook-imbalance"]));
  });

  it("empty when no events exist — never null/undefined", () => {
    const ctx = buildAgentContext(1);
    expect(ctx.recentTypologies).toEqual([]);
    expect(ctx.recentConsensusSignals).toEqual([]);
    expect(ctx.recentTradeClassifications).toEqual([]);
    expect(ctx.recentStrategyOpportunities).toEqual([]);
  });

  it("summarizeContext includes counters for the new signals", () => {
    insertEvolutionEvent({
      event_type: "wallet-typology",
      summary: "wA",
      payload_json: JSON.stringify({
        wallet: "0xaa",
        primaryBucket: "conviction_trader",
        copyabilityClass: "potentially_copyable",
        confidence: 0.9,
        features: { realizedPnlUsd: 1000 },
      }),
    });
    insertEvolutionEvent({
      event_type: "consensus-signal",
      summary: "cs",
      payload_json: JSON.stringify({
        marketKey: "m1",
        direction: "YES",
        effectiveWallets: 5,
        combinedTrust: 10,
        combinedUsd: 2000,
        avgPrice: 0.6,
      }),
    });
    insertEvolutionEvent({
      event_type: "near-resolution-opportunity",
      summary: "nrs",
      payload_json: JSON.stringify({
        marketKey: "m2",
        side: "NO",
        edge: 0.04,
        annualizedEdge: 2.0,
        reason: "test",
      }),
    });
    const ctx = buildAgentContext(1);
    const line = summarizeContext(ctx);
    expect(line).toContain("typ=");
    expect(line).toContain("cons=1");
    expect(line).toContain("opps=1");
  });
});
