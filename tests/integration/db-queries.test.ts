import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMemoryDb } from "../helpers/db";

// Mock the singleton db() factory with a fresh in-memory DB per test.
// __resetMemDb() is exposed so the test harness can swap DBs between tests.
let memDb: ReturnType<typeof makeMemoryDb> | null = null;
vi.mock("@/lib/db/client", () => ({
  db: () => {
    if (!memDb) memDb = makeMemoryDb();
    return memDb;
  },
  closeDb: () => { memDb?.close(); memDb = null; },
}));

// Importing AFTER the mock is registered ensures the mocked db() is in effect.
import * as queries from "@/lib/db/queries";

beforeEach(() => {
  memDb?.close();
  memDb = null;
});
afterEach(() => {
  memDb?.close();
  memDb = null;
});

function seedAgentAndStrategy() {
  // Touch the mocked db() once so it's created, then reach in via queries.ts paths.
  const handle = queries["db" as keyof typeof queries] as any; // not exported — fall back to the import
  // Easier: do raw INSERTs via the singleton path
  const dbMod = require("@/lib/db/client");
  const db = dbMod.db ? dbMod.db() : null;
  // Bypass: just access via queries module side-effect — easier is the inline approach
  return { agentId: 0, strategyId: 0 };
}

// Use a clean import of the db client (which is now mocked) and seed via raw SQL.
import * as dbModule from "@/lib/db/client";
function seed(): { agentId: number; strategyId: number } {
  const db = (dbModule as any).db();
  db.prepare("INSERT INTO agents (slug, name, charter, risk_budget_usd) VALUES ('a', 'A', 'c', 100)").run();
  const a = db.prepare("SELECT id FROM agents WHERE slug='a'").get() as any;
  db.prepare("INSERT INTO strategies (agent_id, slug, name, thesis, market_filter) VALUES (?, 's', 'S', 't', '{}')").run(a.id);
  const s = db.prepare("SELECT id FROM strategies WHERE agent_id=?").get(a.id) as any;
  db.prepare("INSERT INTO strategy_versions (strategy_id, version, spec_json, rationale, is_current) VALUES (?, 1, '{}', 'init', 1)").run(s.id);
  return { agentId: a.id, strategyId: s.id };
}

describe("listAgents / getAgentBySlug", () => {
  it("returns empty on a fresh DB", () => {
    expect(queries.listAgents()).toEqual([]);
  });

  it("returns the seeded agent", () => {
    seed();
    const agents = queries.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].slug).toBe("a");
  });

  it.each(["a", "nope"])("getAgentBySlug returns expected for %s", (slug) => {
    seed();
    const r = queries.getAgentBySlug(slug);
    if (slug === "a") expect(r?.slug).toBe("a");
    else expect(r).toBeUndefined();
  });
});

describe("listStrategiesForAgent / listAllStrategies", () => {
  it("returns strategies for the agent", () => {
    const { agentId } = seed();
    const strats = queries.listStrategiesForAgent(agentId);
    expect(strats).toHaveLength(1);
    expect(strats[0].slug).toBe("s");
  });

  it("listAllStrategies joins agent info", () => {
    seed();
    const rows = queries.listAllStrategies();
    expect(rows[0].agent_slug).toBe("a");
  });
});

describe("currentVersion / listVersions", () => {
  it("returns the current version", () => {
    const { strategyId } = seed();
    const v = queries.currentVersion(strategyId);
    expect(v?.version).toBe(1);
    expect(v?.is_current).toBe(1);
  });

  it("listVersions sorts version desc", () => {
    const { strategyId } = seed();
    const db = (dbModule as any).db();
    db.prepare("INSERT INTO strategy_versions (strategy_id, version, spec_json, rationale) VALUES (?, 2, '{}', 'r')").run(strategyId);
    db.prepare("INSERT INTO strategy_versions (strategy_id, version, spec_json, rationale) VALUES (?, 3, '{}', 'r')").run(strategyId);
    const all = queries.listVersions(strategyId);
    expect(all.map((v) => v.version)).toEqual([3, 2, 1]);
  });
});

describe("insertResearchNote / listResearchNotes", () => {
  it.each([
    { confidence: 0.1, tags: ["a"] },
    { confidence: 0.5, tags: [] },
    { confidence: 0.95, tags: ["a", "b", "c"] },
  ])("inserts and returns note with confidence=$confidence", ({ confidence, tags }) => {
    queries.insertResearchNote({
      topic: `t-${confidence}`,
      body: "body",
      confidence,
      tags_json: JSON.stringify(tags),
    });
    const notes = queries.listResearchNotes();
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].confidence).toBe(confidence);
  });

  it("listResearchNotes returns all inserted notes", () => {
    queries.insertResearchNote({ topic: "one", body: "x" });
    queries.insertResearchNote({ topic: "two", body: "x" });
    queries.insertResearchNote({ topic: "three", body: "x" });
    const topics = queries.listResearchNotes().map((n: any) => n.topic).sort();
    expect(topics).toEqual(["one", "three", "two"]);
  });
});

describe("insertEvolutionEvent / listEvolutionEvents", () => {
  it("inserts and returns events", () => {
    queries.insertEvolutionEvent({ event_type: "proposal", summary: "x" });
    queries.insertEvolutionEvent({ event_type: "promotion", summary: "y" });
    const events = queries.listEvolutionEvents();
    expect(events).toHaveLength(2);
  });

  it.each(["proposal", "promotion", "retirement", "scoring", "arb-detection"])(
    "stores event_type=%s",
    (type) => {
      queries.insertEvolutionEvent({ event_type: type, summary: "x" });
      const events = queries.listEvolutionEvents(10);
      expect(events.some((e: any) => e.event_type === type)).toBe(true);
    },
  );
});

describe("recordMarketSnapshot / latestSnapshotFor", () => {
  it("stores and retrieves the latest snapshot per token", () => {
    queries.recordMarketSnapshot({
      condition_id: "0xc", token_id: "t1", question: "q",
      yes_price: 0.5, no_price: 0.5, midpoint: 0.5, spread: 0,
      volume_24h: null, open_interest: null, liquidity_usd: null,
    });
    const r = queries.latestSnapshotFor("t1");
    expect(r.token_id).toBe("t1");
    expect(r.midpoint).toBe(0.5);
  });
});

describe("listRecentTrades / listTradesForStrategy", () => {
  it("returns empty on no trades", () => {
    seed();
    expect(queries.listRecentTrades()).toEqual([]);
  });
});
