/**
 * /api/binaries route — smoke test.
 *
 * Calls the Next.js GET handler directly with a fake Request and verifies
 * each section (active / resolved / summary / all) returns the expected
 * shape against a seeded in-memory DB.
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

async function seedFixtures() {
  const { db } = await import("@/lib/db/client");
  db().prepare(`INSERT INTO paper_generations (gen_number) VALUES (1)`).run();
  // Two active binaries (future expiry), one resolved (past expiry).
  db().prepare(
    `INSERT INTO poly_binaries (token_id, condition_id, no_token_id, question, asset, duration_kind, expiry_iso, settled)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run("active-btc", "c-btc", "active-btc-no", "BTC up?", "BTC", "5M", "2030-01-01T00:05:00Z");
  db().prepare(
    `INSERT INTO poly_binaries (token_id, condition_id, no_token_id, question, asset, duration_kind, expiry_iso, settled)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run("active-eth", "c-eth", "active-eth-no", "ETH up?", "ETH", "15M", "2030-01-01T00:10:00Z");
  db().prepare(
    `INSERT INTO poly_binaries (token_id, condition_id, no_token_id, question, asset, duration_kind, expiry_iso, settled, outcome_yes, reference_price, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 70000, '2026-05-26T11:55:00Z')`,
  ).run("resolved-btc", "c-r-btc", "resolved-btc-no", "BTC up resolved?", "BTC", "5M", "2026-05-26T11:55:00Z");

  // Snapshot for each active binary so midpoint is non-null.
  db().prepare(
    `INSERT INTO market_snapshots (condition_id, token_id, question, midpoint, category, captured_at)
     VALUES ('c-btc', 'active-btc', 'q', 0.55, '5min-binary', datetime('now'))`,
  ).run();
  db().prepare(
    `INSERT INTO market_snapshots (condition_id, token_id, question, midpoint, category, captured_at)
     VALUES ('c-eth', 'active-eth', 'q', 0.48, '15min-binary', datetime('now'))`,
  ).run();

  // An agent with an open position on active-btc so agent_positions=1
  db().prepare(
    `INSERT INTO paper_agents (name, generation, genome_json, introduced_by, cash_usd_start, cash_usd_current, peak_equity_usd, position_basket_json)
     VALUES ('a', 1, '{}', 'test', 100, 95, 100, ?)`,
  ).run(JSON.stringify([{ market_id: "active-btc", side: "BUY", size_usd: 5, entry_price: 0.5 }]));
}

async function callRoute(query: string) {
  const { GET } = await import("@/app/api/binaries/route");
  const req = new Request(`http://localhost/api/binaries${query}`);
  const resp = await GET(req);
  return resp.json();
}

describe("/api/binaries", () => {
  it("section=active returns rows with midpoint and agent_positions", async () => {
    await seedFixtures();
    const data = await callRoute("?section=active");
    expect(Array.isArray(data.active)).toBe(true);
    expect(data.active).toHaveLength(2);
    const btc = data.active.find((r: any) => r.token_id === "active-btc");
    expect(btc.midpoint).toBe(0.55);
    expect(btc.agent_positions).toBe(1);
    const eth = data.active.find((r: any) => r.token_id === "active-eth");
    expect(eth.midpoint).toBe(0.48);
    expect(eth.agent_positions).toBe(0);
  });

  it("section=resolved returns settled binaries with outcome", async () => {
    await seedFixtures();
    const data = await callRoute("?section=resolved");
    expect(data.resolved).toHaveLength(1);
    expect(data.resolved[0].token_id).toBe("resolved-btc");
    expect(data.resolved[0].outcome_yes).toBe(1);
    expect(data.resolved[0].reference_price).toBe(70000);
  });

  it("section=summary aggregates by asset + overall", async () => {
    await seedFixtures();
    const data = await callRoute("?section=summary");
    expect(data.summary.overall.total).toBe(3);
    expect(data.summary.overall.resolved).toBe(1);
    expect(data.summary.overall.active).toBe(2);
    const byAsset = data.summary.by_asset as Array<{ asset: string; total: number }>;
    const btcRow = byAsset.find((r) => r.asset === "BTC")!;
    expect(btcRow.total).toBe(2);     // 1 active + 1 resolved
    const ethRow = byAsset.find((r) => r.asset === "ETH")!;
    expect(ethRow.total).toBe(1);
  });

  it("section=all returns all three sections + fetched_at", async () => {
    await seedFixtures();
    const data = await callRoute("");
    expect(data.active).toBeDefined();
    expect(data.resolved).toBeDefined();
    expect(data.summary).toBeDefined();
    expect(data.fetched_at).toBeDefined();
    expect(new Date(data.fetched_at).getTime()).toBeGreaterThan(0);
  });

  it("returns empty arrays when DB is empty", async () => {
    const data = await callRoute("?section=all");
    expect(data.active).toHaveLength(0);
    expect(data.resolved).toHaveLength(0);
    expect(data.summary.overall.total).toBe(0);
  });

  it("respects ?limit", async () => {
    await seedFixtures();
    const data = await callRoute("?section=active&limit=1");
    expect(data.active).toHaveLength(1);
  });
});
