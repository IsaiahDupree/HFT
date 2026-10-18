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
import { checkPromotionScore, setVersionStage } from "@/lib/stages/gate";

function seedVersion(stage: string, summary: Record<string, unknown> | null = null): number {
  const db = (dbModule as any).db();
  db.prepare("INSERT INTO agents (slug, name, charter) VALUES ('sg', 'SG', 't')").run();
  const a = db.prepare("SELECT id FROM agents WHERE slug='sg'").get();
  db.prepare("INSERT INTO strategies (agent_id, slug, name, thesis, market_filter) VALUES (?, 'sgs', 'SGS', 't', '{}')").run(a.id);
  const s = db.prepare("SELECT id FROM strategies WHERE agent_id=?").get(a.id);
  db.prepare(
    "INSERT INTO strategy_versions (strategy_id, version, spec_json, rationale, backtest_summary, stage, is_current) VALUES (?, 1, '{}', 'init', ?, ?, 1)",
  ).run(s.id, summary ? JSON.stringify(summary) : null, stage);
  return (db.prepare("SELECT id FROM strategy_versions ORDER BY id DESC LIMIT 1").get() as { id: number }).id;
}

beforeEach(() => { memDb?.close(); memDb = null; delete process.env.RISK_MIN_PROMOTION_SCORE; });
afterEach(() => { memDb?.close(); memDb = null; delete process.env.RISK_MIN_PROMOTION_SCORE; });

describe("checkPromotionScore", () => {
  it("rejects when version has no backtest_summary", () => {
    const v = seedVersion("paper", null);
    const r = checkPromotionScore(v);
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/no backtest_summary/);
  });

  it("rejects when score is below threshold", () => {
    process.env.RISK_MIN_PROMOTION_SCORE = "0";
    const v = seedVersion("paper", { score: -5 });
    const r = checkPromotionScore(v);
    expect(r.passed).toBe(false);
    expect(r.score).toBe(-5);
    expect(r.threshold).toBe(0);
  });

  it("passes when score >= threshold", () => {
    process.env.RISK_MIN_PROMOTION_SCORE = "0";
    const v = seedVersion("paper", { score: 5 });
    const r = checkPromotionScore(v);
    expect(r.passed).toBe(true);
    expect(r.score).toBe(5);
  });

  it("reads .score, .result.score, or .sweep.median_score (in that order)", () => {
    process.env.RISK_MIN_PROMOTION_SCORE = "0";
    const a = seedVersion("paper", { score: 3 });
    expect(checkPromotionScore(a).score).toBe(3);
    memDb?.close(); memDb = null;
    const b = seedVersion("paper", { result: { score: 7 } });
    expect(checkPromotionScore(b).score).toBe(7);
    memDb?.close(); memDb = null;
    const c = seedVersion("paper", { sweep: { median_score: 11 } });
    expect(checkPromotionScore(c).score).toBe(11);
  });
});

describe("setVersionStage — score gate on live_eligible→live", () => {
  // paper→live isn't in the promotion ladder (paper→live_eligible→live), so
  // the score gate is exercised via live_eligible→live which IS in the ladder.

  it("refuses live_eligible→live when score is below threshold", () => {
    process.env.RISK_MIN_PROMOTION_SCORE = "0";
    const v = seedVersion("live_eligible", { score: -5 });
    const r = setVersionStage(v, "live");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/score gate refused/);
    const evo = (dbModule as any).db().prepare("SELECT * FROM evolution_log WHERE event_type = 'stage-refused'").all();
    expect(evo).toHaveLength(1);
  });

  it("allows live_eligible→live when score is above threshold", () => {
    process.env.RISK_MIN_PROMOTION_SCORE = "0";
    const v = seedVersion("live_eligible", { score: 5 });
    const r = setVersionStage(v, "live");
    expect(r.ok).toBe(true);
    expect(r.scoreGate?.passed).toBe(true);
  });

  it("force=true bypasses the score gate but stamps it in the log", () => {
    process.env.RISK_MIN_PROMOTION_SCORE = "0";
    const v = seedVersion("live_eligible", { score: -50 });
    const r = setVersionStage(v, "live", { force: true, rationale: "operator override" });
    expect(r.ok).toBe(true);
    const evo = (dbModule as any).db().prepare("SELECT summary FROM evolution_log WHERE event_type = 'stage-change'").get();
    expect(evo.summary).toMatch(/FORCED past score gate/);
  });

  it("sim→paper is NOT score-gated (only transitions TO 'live' are)", () => {
    process.env.RISK_MIN_PROMOTION_SCORE = "0";
    const v = seedVersion("sim", { score: -100 });
    const r = setVersionStage(v, "paper");
    expect(r.ok).toBe(true);
  });

  it("paper→live still fails — but on the LADDER gate, not the score gate", () => {
    process.env.RISK_MIN_PROMOTION_SCORE = "0";
    const v = seedVersion("paper", { score: 100 });
    const r = setVersionStage(v, "live");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not in promotion ladder/);
  });
});
