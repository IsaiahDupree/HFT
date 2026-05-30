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
import { backtestProposedSpec } from "@/lib/agents/backtest-loop";

function seedFullStrategy(): { strategyId: number; versionId: number; tokenId: string } {
  const db = (dbModule as any).db();
  db.prepare("INSERT INTO agents (slug, name, charter) VALUES ('bt-agent', 'BT', 't')").run();
  const a = db.prepare("SELECT id FROM agents WHERE slug='bt-agent'").get();
  db.prepare("INSERT INTO strategies (agent_id, slug, name, thesis, market_filter) VALUES (?, 'bt-strat', 'BT', 't', '{}')").run(a.id);
  const s = db.prepare("SELECT id FROM strategies WHERE agent_id=?").get(a.id);
  db.prepare("INSERT INTO strategy_versions (strategy_id, version, spec_json, rationale) VALUES (?, 1, '{}', 'init')").run(s.id);
  const v = db.prepare("SELECT id FROM strategy_versions ORDER BY id DESC LIMIT 1").get();
  // Seed 60+ snapshots with a midpoint dip then recovery so the threshold strategy fires.
  const tokenId = "bt-token-001";
  const conditionId = "0xbt";
  const prices = [
    ...Array.from({ length: 20 }, (_, i) => 0.45 + i * 0.001), // ~0.45 → 0.469
    ...Array.from({ length: 10 }, () => 0.25),                  // dip
    ...Array.from({ length: 10 }, (_, i) => 0.30 + i * 0.005),  // recovery
    ...Array.from({ length: 20 }, (_, i) => 0.55 + i * 0.002),  // peak
  ];
  for (let i = 0; i < prices.length; i++) {
    db.prepare(
      `INSERT INTO market_snapshots (condition_id, token_id, question, yes_price, no_price, midpoint, spread, captured_at)
       VALUES (?, ?, 'q', ?, ?, ?, 0.02, datetime('now', '-' || ? || ' minutes'))`,
    ).run(conditionId, tokenId, prices[i], 1 - prices[i], prices[i], prices.length - i);
  }
  return { strategyId: s.id, versionId: v.id, tokenId };
}

beforeEach(() => { memDb?.close(); memDb = null; });
afterEach(() => { memDb?.close(); memDb = null; });

describe("backtestProposedSpec", () => {
  it("returns 'no token id' when no signalsUniverse and no explicit tokenId", () => {
    const { strategyId, versionId } = seedFullStrategy();
    const r = backtestProposedSpec({
      versionId, strategyId, version: 1,
      spec: { entry: { threshold_pts: 8 } },
    });
    expect(r.reason).toBe("no token id");
    expect(r.result).toBeNull();
  });

  it("returns 'decision fn unsupported' when spec has no recognizable shape", () => {
    const { strategyId, versionId, tokenId } = seedFullStrategy();
    const r = backtestProposedSpec({
      versionId, strategyId, version: 1,
      spec: { unrelated: true },
      tokenId,
    });
    expect(r.reason).toBe("decision fn unsupported");
  });

  it("scores a threshold strategy and persists results", () => {
    const { strategyId, versionId, tokenId } = seedFullStrategy();
    const r = backtestProposedSpec({
      versionId, strategyId, version: 1,
      spec: { entry: { threshold_pts: 50 } }, // buyBelow = 0.5 - 50/200 = 0.25
      tokenId,
    });
    expect(r.reason).toBe("ok");
    expect(r.result).not.toBeNull();
    expect(r.tokenIdUsed).toBe(tokenId);
    expect(r.snapshotsScanned).toBeGreaterThan(30);

    // Persisted: backtest_summary has score, performance_metrics has the row
    const db = (dbModule as any).db();
    const v = db.prepare("SELECT backtest_summary FROM strategy_versions WHERE id = ?").get(versionId) as any;
    const summary = JSON.parse(v.backtest_summary);
    expect(typeof summary.score).toBe("number");
    expect(summary.tokenId).toBe(tokenId);
    const perf = db.prepare("SELECT * FROM performance_metrics WHERE strategy_version_id = ? AND window = 'backtest'").get(versionId) as any;
    expect(perf).toBeDefined();
    expect(perf.trades_count).toBeGreaterThanOrEqual(0);

    // Evolution event logged
    const evo = db.prepare("SELECT * FROM evolution_log WHERE event_type = 'backtest' AND strategy_id = ?").get(strategyId) as any;
    expect(evo).toBeDefined();
    expect(evo.summary).toMatch(/score=/);
  });

  it("picks top |zScore| token from signalsUniverse when tokenId not given", () => {
    const { strategyId, versionId, tokenId } = seedFullStrategy();
    const r = backtestProposedSpec({
      versionId, strategyId, version: 1,
      spec: { entry: { threshold_pts: 50 } },
      signalsUniverse: [
        { tokenId: "low-z", zScoreAbs: 0.3 },
        { tokenId: tokenId, zScoreAbs: 2.5 }, // highest
        { tokenId: "mid-z", zScoreAbs: 1.0 },
      ],
    });
    expect(r.tokenIdUsed).toBe(tokenId);
  });
});
