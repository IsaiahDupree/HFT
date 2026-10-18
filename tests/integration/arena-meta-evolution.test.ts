/**
 * Tests for meta-evolution — the layer that asks Claude to synthesize new
 * genome variants from the current population.
 *
 * We stub:
 *   - @/lib/anthropic/auth   → controllable authIsAvailable + getOAuthClient
 *   - the OAuth client's messages.create → controllable LLM response text
 *
 * Tests cover the deterministic plumbing (validation, attribution, audit
 * logging, cadence gate, malformed-output resilience) rather than the LLM
 * call itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeMemoryDb } from "../helpers/db";

let memDb: ReturnType<typeof makeMemoryDb> | null = null;
vi.mock("@/lib/db/client", () => ({
  db: () => {
    if (!memDb) memDb = makeMemoryDb();
    return memDb;
  },
  closeDb: () => { memDb?.close(); memDb = null; },
}));

const mockOAuth = {
  authIsAvailable: vi.fn(() => true),
  getOAuthClient: vi.fn(),
};
vi.mock("@/lib/anthropic/auth", () => mockOAuth);

beforeEach(() => {
  memDb?.close(); memDb = null;
  mockOAuth.authIsAvailable.mockReturnValue(true);
});

async function seedPromisingAgent(opts: { name: string; kind: string; params: any; trades: number; realized: number }) {
  const { db } = await import("@/lib/db/client");
  db().prepare(`INSERT OR IGNORE INTO paper_generations (gen_number) VALUES (1)`).run();
  db().prepare(
    `INSERT INTO paper_agents (
       name, generation, genome_json, introduced_by,
       cash_usd_start, cash_usd_current, peak_equity_usd, realized_pnl_usd,
       trades_count, entries_count, wins_count, alive
     ) VALUES (?, 1, ?, 'preset-aggressive', 100, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    opts.name,
    JSON.stringify({ kind: opts.kind, params: opts.params }),
    100 + opts.realized,
    100 + opts.realized,
    opts.realized,
    opts.trades,
    opts.trades,
    Math.floor(opts.trades * 0.6),
  );
}

function stubClientResponse(text: string): void {
  mockOAuth.getOAuthClient.mockResolvedValue({
    messages: { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text }] }) },
  } as any);
}

describe("shouldRunMetaEvolution — cadence gate", () => {
  it("returns true when ARENA_META_EVOLVE_EVERY divides the seal gen", async () => {
    process.env.ARENA_META_EVOLVE_EVERY = "5";
    const { shouldRunMetaEvolution } = await import("@/lib/arena/meta-evolution");
    expect(shouldRunMetaEvolution(5)).toBe(true);
    expect(shouldRunMetaEvolution(10)).toBe(true);
    expect(shouldRunMetaEvolution(7)).toBe(false);
    expect(shouldRunMetaEvolution(0)).toBe(true); // 0 % 5 = 0
    delete process.env.ARENA_META_EVOLVE_EVERY;
  });

  it("returns false when ARENA_META_EVOLVE_EVERY is 0 (disabled)", async () => {
    process.env.ARENA_META_EVOLVE_EVERY = "0";
    const { shouldRunMetaEvolution } = await import("@/lib/arena/meta-evolution");
    expect(shouldRunMetaEvolution(5)).toBe(false);
    delete process.env.ARENA_META_EVOLVE_EVERY;
  });
});

describe("runMetaEvolution — gates + happy path", () => {
  it("skips when no anthropic auth", async () => {
    mockOAuth.authIsAvailable.mockReturnValue(false);
    const { runMetaEvolution } = await import("@/lib/arena/meta-evolution");
    const r = await runMetaEvolution({ nextGen: 6 });
    expect(r.attempted).toBe(false);
    expect(r.reason).toMatch(/no anthropic auth/);
    expect(r.accepted_count).toBe(0);
  });

  it("skips when fewer than 3 promising agents", async () => {
    await seedPromisingAgent({ name: "lonely", kind: "poly_short_binary_directional", params: { assets: "BTC", vel_window_min: 3, vel_entry_pct: 0.001, pre_cutoff_min: 3, max_window_min: 6, max_yes_price_for_buy: 0.7, min_yes_price_for_sell: 0.3, entry_size_usd: 5, max_positions_per_asset: 1 }, trades: 12, realized: 25 });
    const { runMetaEvolution } = await import("@/lib/arena/meta-evolution");
    const r = await runMetaEvolution({ nextGen: 6 });
    expect(r.attempted).toBe(false);
    expect(r.reason).toMatch(/only 1 promising agents/);
  });

  it("accepts valid LLM-proposed variants and seeds them with introduced_by=meta-llm", async () => {
    // Seed enough agents to clear the >= 3 threshold
    for (let i = 0; i < 4; i++) {
      await seedPromisingAgent({
        name: `winner-${i}`,
        kind: "poly_short_binary_directional",
        params: {
          assets: "BTC", vel_window_min: 3, vel_entry_pct: 0.001,
          pre_cutoff_min: 3, max_window_min: 6,
          max_yes_price_for_buy: 0.7, min_yes_price_for_sell: 0.3,
          entry_size_usd: 5, max_positions_per_asset: 1,
        },
        trades: 15, realized: 30 - i,
      });
    }

    // Claude responds with two valid variants + one invalid.
    stubClientResponse(JSON.stringify({
      variants: [
        {
          reasoning: "Push vel_entry tighter",
          genome: {
            kind: "poly_short_binary_directional",
            params: {
              assets: "BTC,ETH", vel_window_min: 5, vel_entry_pct: 0.0008,
              pre_cutoff_min: 3, max_window_min: 6,
              max_yes_price_for_buy: 0.65, min_yes_price_for_sell: 0.35,
              entry_size_usd: 8, max_positions_per_asset: 2,
            },
          },
        },
        {
          reasoning: "Cb momentum sibling",
          genome: {
            kind: "cb_momentum_burst",
            params: {
              product_id: "BTC-USD", vel_window_min: 5, vel_entry_pct: 0.001,
              accel_min: 0.00005, entry_size_usd: 15, target_pct: 0.003,
              stop_pct: 0.004, time_stop_min: 30, direction_bias: "long_short",
            },
          },
        },
        {
          reasoning: "Garbage kind",
          genome: { kind: "totally_not_a_real_strategy", params: {} },
        },
      ],
    }));

    const { runMetaEvolution } = await import("@/lib/arena/meta-evolution");
    const r = await runMetaEvolution({ nextGen: 7 });
    expect(r.attempted).toBe(true);
    expect(r.proposed_count).toBe(3);
    expect(r.accepted_count).toBe(2);
    expect(r.rejected_reasons.length).toBe(1);

    const { db } = await import("@/lib/db/client");
    const seeded = db().prepare(`SELECT name, generation, introduced_by FROM paper_agents WHERE introduced_by = 'meta-llm'`).all() as Array<{ name: string; generation: number; introduced_by: string }>;
    expect(seeded.length).toBe(2);
    expect(seeded.every((a) => a.generation === 7)).toBe(true);
    expect(seeded.every((a) => a.name.includes("meta"))).toBe(true);

    const audit = db().prepare(`SELECT event_type, summary FROM evolution_log WHERE event_type = 'meta-evolve'`).get() as { event_type: string; summary: string };
    expect(audit.event_type).toBe("meta-evolve");
    expect(audit.summary).toMatch(/2\/3 genome variants/);
  });

  it("handles malformed LLM output gracefully", async () => {
    for (let i = 0; i < 4; i++) {
      await seedPromisingAgent({
        name: `w${i}`, kind: "poly_fade_spike",
        params: { threshold_pts: 3, lookback_h: 6, confirm_quiet_h: 2, entry_size_usd: 5, exit_target_pts: 2, stop_pts: 4, time_stop_h: 24 },
        trades: 12, realized: 20,
      });
    }
    stubClientResponse("Sure, here's some prose. Not JSON.");

    const { runMetaEvolution } = await import("@/lib/arena/meta-evolution");
    const r = await runMetaEvolution({ nextGen: 8 });
    expect(r.attempted).toBe(true);
    expect(r.reason).toMatch(/no JSON/);
    expect(r.accepted_count).toBe(0);
  });

  it("rejects variants with out-of-range params (zod validation works)", async () => {
    for (let i = 0; i < 4; i++) {
      await seedPromisingAgent({
        name: `w${i}`, kind: "poly_short_binary_directional",
        params: { assets: "BTC", vel_window_min: 3, vel_entry_pct: 0.001, pre_cutoff_min: 3, max_window_min: 6, max_yes_price_for_buy: 0.7, min_yes_price_for_sell: 0.3, entry_size_usd: 5, max_positions_per_asset: 1 },
        trades: 12, realized: 25,
      });
    }
    // entry_size_usd: 9999 is way over the 50 cap on binary directional
    stubClientResponse(JSON.stringify({
      variants: [{
        reasoning: "Aggressive sizing",
        genome: {
          kind: "poly_short_binary_directional",
          params: {
            assets: "BTC", vel_window_min: 3, vel_entry_pct: 0.001,
            pre_cutoff_min: 3, max_window_min: 6,
            max_yes_price_for_buy: 0.7, min_yes_price_for_sell: 0.3,
            entry_size_usd: 9999,
            max_positions_per_asset: 1,
          },
        },
      }],
    }));

    const { runMetaEvolution } = await import("@/lib/arena/meta-evolution");
    const r = await runMetaEvolution({ nextGen: 9 });
    expect(r.proposed_count).toBe(1);
    expect(r.accepted_count).toBe(0);
    expect(r.rejected_reasons[0]).toMatch(/zod rejected/);
  });
});
