/**
 * Tests for the capsule circuit breaker (bug #14).
 *
 * The breaker auto-pauses capsules whose live router has been piling up
 * broker errors. Without it, a geoblocked / mis-configured capsule will keep
 * hitting the API every tick and never recover automatically.
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

beforeEach(() => { memDb?.close(); memDb = null; });

async function seedCapsule(id: string, status: "live" | "paper" | "paused" = "live"): Promise<void> {
  const { db } = await import("@/lib/db/client");
  // agent_id/strategy_id NULL to avoid FK constraint (agents/strategies tables not seeded).
  db().prepare(`INSERT INTO capsules
    (id, agent_id, strategy_id, name, status, capital_allocated_usd, capital_deployed_usd, capital_available_usd,
     max_daily_loss_usd, max_total_drawdown_usd, max_position_pct, max_open_positions, max_trades_per_day,
     allowed_venues_json, allowed_symbols_json, min_seconds_between_trades)
    VALUES (?, NULL, NULL, 'test', ?, 100, 0, 100, 10, 25, 0.5, 3, 20, '["polymarket"]', NULL, 0)`).run(id, status);
}

async function seedEvent(eventType: string, capsuleId: string, summary = "test", minutesAgo = 0): Promise<void> {
  const { db } = await import("@/lib/db/client");
  const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  db().prepare(`INSERT INTO evolution_log (created_at, event_type, summary, payload_json)
    VALUES (?, ?, ?, ?)`).run(
    ts.replace("T", " ").slice(0, 19),
    eventType,
    summary,
    JSON.stringify({ capsuleId, capsule_id: capsuleId, reason: summary }),
  );
}

describe("capsule circuit breaker", () => {
  it("does NOT pause a capsule below the error threshold", async () => {
    await seedCapsule("cap-1", "live");
    for (let i = 0; i < 4; i++) await seedEvent("single-error", "cap-1", "rejected", 1);

    const { runCircuitBreaker } = await import("@/lib/capsules/circuit-breaker");
    const r = runCircuitBreaker({ threshold: 5, windowMin: 15 });
    expect(r.paused).toHaveLength(0);
    expect(r.inspected).toBe(1);
  });

  it("PAUSES a capsule with ≥ threshold errors and zero successes", async () => {
    await seedCapsule("cap-2", "live");
    for (let i = 0; i < 6; i++) await seedEvent("single-error", "cap-2", "Trading restricted geoblock", 2);

    const { runCircuitBreaker } = await import("@/lib/capsules/circuit-breaker");
    const r = runCircuitBreaker({ threshold: 5, windowMin: 15 });
    expect(r.paused).toHaveLength(1);
    expect(r.paused[0].capsule_id).toBe("cap-2");
    expect(r.paused[0].error_count).toBe(6);
    expect(r.paused[0].reason).toMatch(/geoblock/);

    const { getCapsule } = await import("@/lib/capsules/store");
    expect(getCapsule("cap-2")?.status).toBe("paused");
  });

  it("does NOT pause if there was at least one success in the window", async () => {
    await seedCapsule("cap-3", "live");
    for (let i = 0; i < 6; i++) await seedEvent("single-error", "cap-3", "transient", 5);
    await seedEvent("single-executed", "cap-3", "filled", 1);

    const { runCircuitBreaker } = await import("@/lib/capsules/circuit-breaker");
    const r = runCircuitBreaker({ threshold: 5, windowMin: 15 });
    expect(r.paused).toHaveLength(0);
  });

  it("ignores errors outside the lookback window", async () => {
    await seedCapsule("cap-4", "live");
    // 6 errors but all 30 min ago (outside default 15-min window)
    for (let i = 0; i < 6; i++) await seedEvent("single-error", "cap-4", "old", 30);

    const { runCircuitBreaker } = await import("@/lib/capsules/circuit-breaker");
    const r = runCircuitBreaker({ threshold: 5, windowMin: 15 });
    expect(r.paused).toHaveLength(0);
  });

  it("logs a capsule-circuit-trip audit row on every pause", async () => {
    await seedCapsule("cap-5", "live");
    for (let i = 0; i < 5; i++) await seedEvent("single-error", "cap-5", "auth fail", 1);

    const { runCircuitBreaker } = await import("@/lib/capsules/circuit-breaker");
    runCircuitBreaker({ threshold: 5, windowMin: 15 });

    const { db } = await import("@/lib/db/client");
    const audit = db().prepare(`SELECT event_type, summary FROM evolution_log WHERE event_type='capsule-circuit-trip'`).get() as { event_type: string; summary: string };
    expect(audit.event_type).toBe("capsule-circuit-trip");
    expect(audit.summary).toMatch(/cap-5/);
    expect(audit.summary).toMatch(/auth fail/);
  });

  it("skips already-paused capsules", async () => {
    await seedCapsule("cap-6", "paused");
    for (let i = 0; i < 10; i++) await seedEvent("single-error", "cap-6", "err", 1);

    const { runCircuitBreaker } = await import("@/lib/capsules/circuit-breaker");
    const r = runCircuitBreaker({ threshold: 5, windowMin: 15 });
    expect(r.inspected).toBe(0); // 'paused' status is not in (live, paper)
    expect(r.paused).toHaveLength(0);
  });

  it("respects CAPSULE_ERROR_THRESHOLD env override", async () => {
    await seedCapsule("cap-7", "live");
    for (let i = 0; i < 3; i++) await seedEvent("single-error", "cap-7", "x", 1);

    const orig = process.env.CAPSULE_ERROR_THRESHOLD;
    process.env.CAPSULE_ERROR_THRESHOLD = "3";
    try {
      const { runCircuitBreaker } = await import("@/lib/capsules/circuit-breaker");
      const r = runCircuitBreaker({}); // use env, not opts
      expect(r.paused).toHaveLength(1);
    } finally {
      if (orig === undefined) delete process.env.CAPSULE_ERROR_THRESHOLD;
      else process.env.CAPSULE_ERROR_THRESHOLD = orig;
    }
  });
});
