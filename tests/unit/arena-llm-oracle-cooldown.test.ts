/**
 * Rate-limit cooldown unit test.
 *
 * Isolated in its own file because the tests mock @/lib/anthropic/auth and
 * @/lib/db/client at module load time — co-locating with other oracle tests
 * would force vi.resetModules() and break their shared module-state contract
 * (the `decide()` tests share the same in-memory cache instance).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/anthropic/auth", () => ({
  authIsAvailable: () => true,
  getOAuthClient: async () => ({
    messages: {
      create: async () => {
        const e = new Error("rate");
        (e as { status?: number }).status = 429;
        throw e;
      },
    },
  }),
}));

vi.mock("@/lib/db/client", () => {
  const fake = {
    prepare: () => ({
      run: () => undefined,
      get: () => undefined,
      all: () => [],
    }),
  };
  return { db: () => fake };
});

vi.mock("@/lib/arena/llm-oracle-budget", () => ({
  checkBudget: () => ({ allowed: true, spent_usd: 0, cap_usd: 1, remaining_usd: 1 }),
}));

describe("oracle rate-limit cooldown", () => {
  beforeEach(async () => {
    const mod = await import("@/lib/arena/llm-oracle");
    mod._resetRateLimitCooldown();
    delete process.env.ARENA_LLM_ORACLE_RATE_LIMIT_COOLDOWN_MIN;
  });
  afterEach(() => { delete process.env.ARENA_LLM_ORACLE_RATE_LIMIT_COOLDOWN_MIN; });

  it("is inert by default (no prior 429)", async () => {
    const { isRateLimitCoolingDown, rateLimitMinRemaining } = await import("@/lib/arena/llm-oracle");
    expect(isRateLimitCoolingDown()).toBe(false);
    expect(rateLimitMinRemaining()).toBe(0);
  });

  it("trips after callOracle catches a 429-shaped error", async () => {
    const mod = await import("@/lib/arena/llm-oracle");
    const result = await mod.callOracle({ marketId: "m429", question: "Q?", marketImpliedProb: 0.5 });
    expect(result).toBeNull();
    expect(mod.isRateLimitCoolingDown()).toBe(true);
    expect(mod.rateLimitMinRemaining()).toBeGreaterThan(0);
  });

  it("blocks subsequent live calls until the cooldown expires (default 30m)", async () => {
    const mod = await import("@/lib/arena/llm-oracle");
    await mod.callOracle({ marketId: "m429-a", question: "Q?", marketImpliedProb: 0.5 });
    expect(mod.isRateLimitCoolingDown()).toBe(true);
    // A second call returns null *without* hitting the (mocked) SDK — the
    // 429-throwing mock would otherwise mean we always return null, but here
    // the cooldown guard catches us before the SDK is touched.
    const result = await mod.callOracle({ marketId: "m429-b", question: "Q?", marketImpliedProb: 0.5 });
    expect(result).toBeNull();
    expect(mod.rateLimitMinRemaining()).toBeGreaterThan(0);
  });

  it("honors ARENA_LLM_ORACLE_RATE_LIMIT_COOLDOWN_MIN", async () => {
    process.env.ARENA_LLM_ORACLE_RATE_LIMIT_COOLDOWN_MIN = "1"; // 1 min
    const mod = await import("@/lib/arena/llm-oracle");
    await mod.callOracle({ marketId: "m429c", question: "Q?", marketImpliedProb: 0.5 });
    const rem = mod.rateLimitMinRemaining();
    expect(rem).toBeGreaterThan(0);
    expect(rem).toBeLessThanOrEqual(1);
  });
});
