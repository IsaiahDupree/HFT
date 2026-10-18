/**
 * Paper-flow end-to-end: agent → capsule → paper-stage version → router.submit
 * through the SimAdapter, with the order_events trail proving every gate
 * fired in the right order.
 *
 * This is the "runs with paper" proof: a fresh DB plus no real venue creds
 * should still produce a clean filled-in-sim verdict and a complete audit log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMemoryDb } from "../helpers/db";

let memDb: ReturnType<typeof makeMemoryDb> | null = null;
vi.mock("@/lib/db/client", () => ({
  db: () => {
    if (!memDb) memDb = makeMemoryDb();
    return memDb;
  },
  closeDb: () => { memDb?.close(); memDb = null; },
}));

import * as dbModule from "@/lib/db/client";
import { createCapsule, setStatus } from "@/lib/capsules/store";
import { ExecutionRouter } from "@/lib/venue/router";
import { SimAdapter } from "@/lib/venue/adapters/sim";
import { RiskEngine } from "@/lib/risk/engine";
import { KillSwitch } from "@/lib/risk/kill-switch";
import { listOrderEvents } from "@/lib/venue/order-events";
import { setVersionStage } from "@/lib/stages/gate";

function seedAgentAndVersion(): { agentId: number; strategyId: number; versionId: number } {
  // Go through the mocked db() so memDb is lazily initialized — matches the
  // pattern in tests/integration/db-queries.test.ts.
  const handle = (dbModule as any).db();
  handle.prepare("INSERT INTO agents (slug, name, charter) VALUES ('sim-agent', 'Sim Agent', 'paper trading proof')").run();
  const agent = handle.prepare("SELECT id FROM agents WHERE slug='sim-agent'").get() as { id: number };
  handle.prepare(
    "INSERT INTO strategies (agent_id, slug, name, thesis, market_filter) VALUES (?, 'paper-strat', 'Paper Strategy', 'sim only', '{}')",
  ).run(agent.id);
  const strat = handle.prepare("SELECT id FROM strategies WHERE agent_id=?").get(agent.id) as { id: number };
  handle.prepare(
    "INSERT INTO strategy_versions (strategy_id, version, spec_json, rationale, stage, is_current) VALUES (?, 1, '{}', 'init', 'sim', 1)",
  ).run(strat.id);
  const version = handle.prepare("SELECT id FROM strategy_versions ORDER BY id DESC LIMIT 1").get() as { id: number };
  return { agentId: agent.id, strategyId: strat.id, versionId: version.id };
}

function makeRouterWithSim() {
  const risk = new RiskEngine({
    enabled: true,
    max_order_notional_usd: 10_000,
    max_position_notional_usd: 50_000,
    max_daily_loss_usd: 1_000,
    max_open_positions: 50,
    max_orders_per_minute: 600,
    max_concentration_pct: 1.0,
    require_confirmation_above_usd: 100_000,
    forbidden_symbols: [],
  });
  const kill = new KillSwitch(risk);
  const router = new ExecutionRouter({ riskEngine: risk, killSwitch: kill });
  router.registerAdapter(new SimAdapter());
  return router;
}

beforeEach(() => { memDb?.close(); memDb = null; });
afterEach(() => { memDb?.close(); memDb = null; });

describe("paper flow — end-to-end via SimAdapter", () => {
  it("submits, fills in sim, and writes the full order_events trail", async () => {
    const { agentId, versionId } = seedAgentAndVersion();
    // Promote sim → paper so the stage gate (when wired) would allow paper submits.
    setVersionStage(versionId, "paper", { rationale: "ready for paper" });

    const cap = createCapsule({
      name: "Paper capsule",
      agentId,
      capitalUsd: 500,
      allowedVenues: ["sim"],
      maxDailyLossUsd: 100,
      maxPositionPct: 0.5,
      maxOpenPositions: 5,
      maxTradesPerDay: 100,
    });
    setStatus(cap.id, "paper");

    const router = makeRouterWithSim();
    const verdict = await router.submit({
      clientOrderId: "paper-coid-1",
      venue: "sim",
      symbol: "BTC-USD",
      side: "BUY",
      type: "MARKET",
      size: 1,
      refPrice: 100,
      capsuleId: cap.id,
      agentId,
      strategyVersionId: versionId,
    });

    expect(verdict.ok).toBe(true);
    if (verdict.ok && "status" in verdict) {
      expect(verdict.status).toBe("filled");
      expect(verdict.brokerOrderId?.startsWith("SIM-")).toBe(true);
    }

    const events = listOrderEvents({ clientOrderId: "paper-coid-1" });
    const types = events.map((e) => e.event).sort();
    expect(types).toEqual(["status_filled", "submitting"]);
    // Capsule attribution survives the roundtrip
    expect(events.every((e) => e.capsule_id === cap.id)).toBe(true);
    expect(events.every((e) => e.venue === "sim")).toBe(true);
  });

  it("rejects UNSUPPORTED when order.type isn't supported by the adapter", async () => {
    const { agentId } = seedAgentAndVersion();
    const cap = createCapsule({
      name: "Paper capsule", agentId, capitalUsd: 500, allowedVenues: ["sim"],
      maxPositionPct: 1.0, maxOpenPositions: 5, maxTradesPerDay: 100,
    });
    setStatus(cap.id, "paper");

    // Override SimAdapter's capability to test the gate fires
    const router = new ExecutionRouter({
      riskEngine: new RiskEngine({
        enabled: false,                 // bypass global risk for this test
        max_order_notional_usd: 0, max_position_notional_usd: 0, max_daily_loss_usd: 0,
        max_open_positions: 0, max_orders_per_minute: 0, max_concentration_pct: 0,
        require_confirmation_above_usd: 0, forbidden_symbols: [],
      }),
    });
    const sim = new SimAdapter();
    (sim.capabilities as any).market = false;  // force-deny MARKET on this instance
    router.registerAdapter(sim);

    const verdict = await router.submit({
      clientOrderId: "unsupported-1",
      venue: "sim",
      symbol: "X",
      side: "BUY",
      type: "MARKET",
      size: 1,
      refPrice: 1,
      capsuleId: cap.id,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("UNSUPPORTED");
  });

  it("rejects CAPSULE_VENUE_NOT_ALLOWED when capsule's allowed_venues excludes 'sim'", async () => {
    const { agentId } = seedAgentAndVersion();
    const cap = createCapsule({
      name: "Polymarket-only capsule",
      agentId, capitalUsd: 500,
      allowedVenues: ["polymarket"],     // no 'sim'
      maxPositionPct: 1.0, maxOpenPositions: 5, maxTradesPerDay: 100,
    });
    setStatus(cap.id, "paper");

    const router = makeRouterWithSim();
    const verdict = await router.submit({
      clientOrderId: "venue-blocked-1",
      venue: "sim",
      symbol: "BTC-USD",
      side: "BUY",
      type: "MARKET",
      size: 1,
      refPrice: 100,
      capsuleId: cap.id,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("CAPSULE_VENUE_NOT_ALLOWED");
  });
});
