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

import { canTradeLive, canTradePaper, getVersionStage, setVersionStage } from "@/lib/stages/gate";

beforeEach(() => {
  memDb?.close();
  memDb = null;
});
afterEach(() => {
  memDb?.close();
  memDb = null;
});

function seedVersion(stage: string): number {
  const db = memDb ?? makeMemoryDb();
  memDb = db;
  db.prepare("INSERT INTO agents (slug, name, charter) VALUES ('a', 'A', 'c')").run();
  const agent = db.prepare("SELECT id FROM agents WHERE slug='a'").get() as { id: number };
  db.prepare("INSERT INTO strategies (agent_id, slug, name, thesis, market_filter) VALUES (?, 's', 'S', 't', '{}')").run(agent.id);
  const strat = db.prepare("SELECT id FROM strategies WHERE agent_id=?").get(agent.id) as { id: number };
  db.prepare(
    "INSERT INTO strategy_versions (strategy_id, version, spec_json, rationale, stage, is_current) VALUES (?, 1, '{}', 'init', ?, 1)",
  ).run(strat.id, stage);
  return (db.prepare("SELECT id FROM strategy_versions ORDER BY id DESC LIMIT 1").get() as { id: number }).id;
}

describe("stage gate — reads", () => {
  it.each(["sim", "paper", "live_eligible", "live", "restricted"])("getVersionStage returns stage=%s", (stage) => {
    const vid = seedVersion(stage);
    expect(getVersionStage(vid)?.stage).toBe(stage);
  });

  it.each([
    { stage: "live", expected: true },
    { stage: "paper", expected: false },
    { stage: "live_eligible", expected: false },
    { stage: "sim", expected: false },
    { stage: "restricted", expected: false },
  ])("canTradeLive=$expected when stage=$stage", ({ stage, expected }) => {
    expect(canTradeLive(seedVersion(stage))).toBe(expected);
  });

  it.each([
    { stage: "paper", expected: true },
    { stage: "live_eligible", expected: true },
    { stage: "live", expected: true },
    { stage: "sim", expected: false },
    { stage: "restricted", expected: false },
  ])("canTradePaper=$expected when stage=$stage", ({ stage, expected }) => {
    expect(canTradePaper(seedVersion(stage))).toBe(expected);
  });
});

describe("stage gate — promotion ladder", () => {
  it("allows sim → paper", () => {
    const vid = seedVersion("sim");
    const r = setVersionStage(vid, "paper");
    expect(r.ok).toBe(true);
    expect(getVersionStage(vid)?.stage).toBe("paper");
  });

  it("rejects sim → live without force=true", () => {
    const vid = seedVersion("sim");
    const r = setVersionStage(vid, "live");
    expect(r.ok).toBe(false);
    expect(getVersionStage(vid)?.stage).toBe("sim");
  });

  it("allows sim → live with force=true", () => {
    const vid = seedVersion("sim");
    const r = setVersionStage(vid, "live", { force: true, rationale: "test override" });
    expect(r.ok).toBe(true);
    expect(getVersionStage(vid)?.stage).toBe("live");
  });

  it("logs an evolution event on every stage change", () => {
    const vid = seedVersion("sim");
    setVersionStage(vid, "paper", { rationale: "ready for paper" });
    const events = memDb!.prepare("SELECT * FROM evolution_log WHERE event_type = 'stage-change'").all() as any[];
    expect(events).toHaveLength(1);
    expect(events[0].summary).toMatch(/sim → paper/);
  });
});
