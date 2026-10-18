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
import { buildAgentContext, summarizeContext } from "@/lib/agents/context";
import { createCapsule, setStatus } from "@/lib/capsules/store";
import { appendOrderEvent } from "@/lib/venue/order-events";
import { resetDefaultKillSwitchForTests } from "@/lib/risk/kill-switch";
import { resetDefaultRiskEngineForTests } from "@/lib/risk/engine";

function seedAgentAndStrategy(): { agentId: number; strategyId: number; versionId: number } {
  const db = (dbModule as any).db();
  db.prepare("INSERT INTO agents (slug, name, charter) VALUES ('ctx-agent', 'CtxAgent', 'context test')").run();
  const a = db.prepare("SELECT id FROM agents WHERE slug='ctx-agent'").get();
  db.prepare(
    "INSERT INTO strategies (agent_id, slug, name, thesis, market_filter) VALUES (?, 'ctx-strat', 'CtxStrat', 't', '{}')",
  ).run(a.id);
  const s = db.prepare("SELECT id FROM strategies WHERE agent_id=?").get(a.id);
  db.prepare(
    "INSERT INTO strategy_versions (strategy_id, version, spec_json, rationale, stage, is_current) VALUES (?, 1, '{}', 'init', 'sim', 1)",
  ).run(s.id);
  const v = db.prepare("SELECT id FROM strategy_versions ORDER BY id DESC LIMIT 1").get();
  return { agentId: a.id, strategyId: s.id, versionId: v.id };
}

beforeEach(() => { memDb?.close(); memDb = null; resetDefaultKillSwitchForTests(); resetDefaultRiskEngineForTests(); });
afterEach(() => { memDb?.close(); memDb = null; resetDefaultKillSwitchForTests(); resetDefaultRiskEngineForTests(); });

describe("buildAgentContext", () => {
  it("returns sane defaults on a fresh DB", () => {
    const { agentId, strategyId } = seedAgentAndStrategy();
    const ctx = buildAgentContext(strategyId);
    expect(ctx.strategyId).toBe(strategyId);
    expect(ctx.agentId).toBe(agentId);
    expect(ctx.capsules).toEqual([]);
    expect(ctx.activeCapsules).toEqual([]);
    expect(ctx.killSwitch.halted).toBe(false);
    expect(ctx.recentOrderEvents).toEqual([]);
    expect(ctx.recentRejectCounts).toEqual({});
    expect(ctx.lastBacktest).toBeNull();
    expect(ctx.riskLimits.enabled).toBe(true);
  });

  it("surfaces capsules bound to the same agent", () => {
    const { agentId, strategyId } = seedAgentAndStrategy();
    const c1 = createCapsule({ name: "draft cap", agentId, capitalUsd: 100, allowedVenues: ["sim"] });
    const c2 = createCapsule({ name: "live cap", agentId, capitalUsd: 500, allowedVenues: ["sim"] });
    setStatus(c2.id, "live");
    const ctx = buildAgentContext(strategyId);
    expect(ctx.capsules).toHaveLength(2);
    expect(ctx.activeCapsules).toHaveLength(1);
    expect(ctx.activeCapsules[0].id).toBe(c2.id);
  });

  it("aggregates recent reject codes by status field", () => {
    const { strategyId } = seedAgentAndStrategy();
    appendOrderEvent({ event: "submitting", venue: "sim", clientOrderId: "o1", status: "pending" });
    appendOrderEvent({ event: "rejected_capsule", venue: "sim", clientOrderId: "o2", status: "CAPSULE_DAILY_LOSS", error: "x" });
    appendOrderEvent({ event: "rejected_capsule", venue: "sim", clientOrderId: "o3", status: "CAPSULE_DAILY_LOSS", error: "x" });
    appendOrderEvent({ event: "rejected_risk", venue: "sim", clientOrderId: "o4", status: "RISK_ORDER_NOTIONAL", error: "x" });
    const ctx = buildAgentContext(strategyId);
    expect(ctx.recentRejectCounts).toEqual({ CAPSULE_DAILY_LOSS: 2, RISK_ORDER_NOTIONAL: 1 });
  });

  it("returns evolution events for this strategy only (not other strategies')", () => {
    const { strategyId } = seedAgentAndStrategy();
    const db = (dbModule as any).db();
    db.prepare("INSERT INTO evolution_log (strategy_id, event_type, summary, payload_json) VALUES (?, 'proposal', 'a', '{}')").run(strategyId);
    db.prepare("INSERT INTO evolution_log (strategy_id, event_type, summary, payload_json) VALUES (?, 'backtest', 'b', '{}')").run(strategyId);
    // Other strategy's events
    db.prepare("INSERT INTO agents (slug, name, charter) VALUES ('other', 'Other', 'x')").run();
    const o = db.prepare("SELECT id FROM agents WHERE slug='other'").get();
    db.prepare("INSERT INTO strategies (agent_id, slug, name, thesis, market_filter) VALUES (?, 'o', 'O', 't', '{}')").run(o.id);
    const os = db.prepare("SELECT id FROM strategies WHERE slug='o'").get();
    db.prepare("INSERT INTO evolution_log (strategy_id, event_type, summary, payload_json) VALUES (?, 'noise', 'n', '{}')").run(os.id);
    const ctx = buildAgentContext(strategyId);
    expect(ctx.recentEvolution.map((e) => e.event_type).sort()).toEqual(["backtest", "proposal"]);
  });
});

describe("summarizeContext", () => {
  it("produces a compact one-line summary", () => {
    const { strategyId } = seedAgentAndStrategy();
    const ctx = buildAgentContext(strategyId);
    const s = summarizeContext(ctx);
    expect(s).toMatch(/^\[ctx /);
    expect(s).toMatch(/halt=no/);
    expect(s).toMatch(/capsules=0\/0/);
  });
});
