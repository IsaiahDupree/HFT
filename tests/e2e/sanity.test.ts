/**
 * E2E sanity checks — only run when RUN_E2E=1 (hits the live network).
 * Each test pins to a real Polymarket / on-chain endpoint and asserts the
 * shape we depend on. If these regress, the corresponding client function
 * needs an update.
 */
import { describe, expect, it } from "vitest";
import { poly } from "@/lib/polymarket/client";

const RUN_E2E = process.env.RUN_E2E === "1";
const e2eIt = RUN_E2E ? it : it.skip;

describe("Live Gamma API", () => {
  e2eIt("events endpoint returns an array of event objects", async () => {
    const r = await poly.events({ limit: 3, closed: false });
    expect(Array.isArray(r)).toBe(true);
    if (r.length > 0) {
      expect(r[0]).toHaveProperty("id");
      expect(r[0]).toHaveProperty("title");
    }
  });

  e2eIt("tags endpoint returns an array", async () => {
    const r = await poly.tags(3);
    expect(Array.isArray(r)).toBe(true);
  });
});

describe("Live Data API", () => {
  e2eIt("openInterest returns numeric body", async () => {
    const r = await poly.openInterest();
    expect(typeof r).toBe("object");
  });

  e2eIt("traderLeaderboard returns ranked entries", async () => {
    const r = await poly.traderLeaderboard({ limit: 3 });
    expect(Array.isArray(r)).toBe(true);
  });
});

describe("Live CLOB", () => {
  e2eIt("samplingMarkets returns markets with tokens", async () => {
    const r = await poly.samplingMarkets(3);
    expect(r.data).toBeDefined();
    expect(r.data.length).toBeGreaterThan(0);
    expect(r.data[0]).toHaveProperty("tokens");
  });

  e2eIt("orderbook for a real sampling-market token has bids and asks shape", async () => {
    const m = (await poly.samplingMarkets(1)).data[0];
    const tokenId = m.tokens.find((t: any) => t.outcome === "Yes")?.token_id ?? m.tokens[0]?.token_id;
    const book = await poly.orderbook(tokenId);
    expect(book).toHaveProperty("bids");
    expect(book).toHaveProperty("asks");
  });
});

describe("Live on-chain (viem)", () => {
  e2eIt("Polygon RPC reachable + returns a block number", async () => {
    const { createPublicClient, http } = await import("viem");
    const { polygon } = await import("viem/chains");
    const client = createPublicClient({ chain: polygon, transport: http() });
    const bn = await client.getBlockNumber();
    expect(bn).toBeGreaterThan(80_000_000n);
  });
});

describe("Live Claude OAuth (Anthropic SDK)", () => {
  e2eIt("OAuth client makes a tiny call (~ <10 tokens)", async () => {
    const { authIsAvailable, getOAuthClient } = await import("@/lib/anthropic/auth");
    if (!authIsAvailable()) return;
    const client = await getOAuthClient();
    const resp = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 30,
      messages: [{ role: "user", content: "Reply with the single word: OK" }],
    });
    const text = (resp.content.find((b: any) => b.type === "text") as any)?.text ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect(resp.usage.input_tokens).toBeGreaterThan(0);
  });
});

if (!RUN_E2E) {
  describe("E2E gate", () => {
    it("E2E suite is currently skipped (set RUN_E2E=1 to enable)", () => {
      expect(true).toBe(true);
    });
  });
}
