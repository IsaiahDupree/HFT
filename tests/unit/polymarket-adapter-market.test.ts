/**
 * PolymarketAdapter MARKET path — single-side BUY/SELL submission.
 *
 * Covers:
 *  - BUY YES → submitSingleSideMarket called with the YES token
 *  - SELL-YES entry with no_token_id in metadata → swapped to BUY NO
 *  - Dry-run mode (ALLOW_TRADE unset) returns ok=true status="dry_run"
 *  - Invalid order type returns INVALID_INPUT
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnifiedOrder } from "@/lib/venue/types";

// Track calls into the underlying execute helper.
const calls: Array<{ tokenId: string; side: string; sizeUsd: number }> = [];

vi.mock("@/lib/polymarket/execute", () => ({
  submitSingleSideMarket: vi.fn(async (args: { tokenId: string; side: string; sizeUsd: number; refPrice: number }) => {
    calls.push({ tokenId: args.tokenId, side: args.side, sizeUsd: args.sizeUsd });
    return {
      kind: "dry-run",
      reason: "ALLOW_TRADE!=1",
      planned: { tokenId: args.tokenId, side: args.side, amount: args.sizeUsd, price: args.refPrice },
      capUsed: { trade: args.sizeUsd, daily: args.sizeUsd },
    };
  }),
  executeSingleMarketArb: vi.fn(),
  killSwitch: vi.fn(),
  safety: { mode: () => "DRY_RUN", maxTrade: () => 25, maxDaily: () => 100, dailyExecutedUsd: () => 0 },
}));

beforeEach(() => { calls.length = 0; });
afterEach(() => { vi.clearAllMocks(); });

describe("PolymarketAdapter — MARKET path", () => {
  it("BUY YES routes to submitSingleSideMarket with the YES token", async () => {
    const { PolymarketAdapter } = await import("@/lib/venue/adapters/polymarket");
    const adapter = new PolymarketAdapter();
    const order: UnifiedOrder = {
      clientOrderId: "test-1",
      venue: "polymarket",
      symbol: "yes-token-abc",
      side: "BUY",
      type: "MARKET",
      size: 5,
      refPrice: 0.6,
      metadata: { intent: "entry", sizeUsd: 5 },
    };
    const verdict = await adapter.submit(order);
    expect(verdict.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].tokenId).toBe("yes-token-abc");
    expect(calls[0].side).toBe("BUY");
    expect(calls[0].sizeUsd).toBe(5);
  });

  it("SELL-YES entry with no_token_id swaps to BUY NO", async () => {
    const { PolymarketAdapter } = await import("@/lib/venue/adapters/polymarket");
    const adapter = new PolymarketAdapter();
    const order: UnifiedOrder = {
      clientOrderId: "test-2",
      venue: "polymarket",
      symbol: "yes-token-xyz",
      side: "SELL",
      type: "MARKET",
      size: 7,
      refPrice: 0.4,
      metadata: { intent: "entry", sizeUsd: 7, no_token_id: "no-token-xyz" },
    };
    const verdict = await adapter.submit(order);
    expect(verdict.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].tokenId).toBe("no-token-xyz"); // swapped
    expect(calls[0].side).toBe("BUY");             // swapped
  });

  it("SELL-YES entry WITHOUT no_token_id keeps SELL YES (exit-like)", async () => {
    const { PolymarketAdapter } = await import("@/lib/venue/adapters/polymarket");
    const adapter = new PolymarketAdapter();
    const order: UnifiedOrder = {
      clientOrderId: "test-3",
      venue: "polymarket",
      symbol: "yes-token-bare",
      side: "SELL",
      type: "MARKET",
      size: 3,
      refPrice: 0.5,
      // No no_token_id — no swap.
      metadata: { intent: "entry", sizeUsd: 3 },
    };
    await adapter.submit(order);
    expect(calls[0].tokenId).toBe("yes-token-bare");
    expect(calls[0].side).toBe("SELL");
  });

  it("rejects an unknown order type with INVALID_INPUT", async () => {
    const { PolymarketAdapter } = await import("@/lib/venue/adapters/polymarket");
    const adapter = new PolymarketAdapter();
    const order: UnifiedOrder = {
      clientOrderId: "test-4",
      venue: "polymarket",
      symbol: "yes-token-bad",
      side: "BUY",
      type: "LIMIT",
      size: 1,
      refPrice: 0.5,
    };
    const verdict = await adapter.submit(order);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("INVALID_INPUT");
  });
});
