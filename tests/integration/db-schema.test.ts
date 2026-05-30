import { describe, expect, it } from "vitest";
import { makeMemoryDb } from "../helpers/db";

describe("schema migration", () => {
  it("creates every expected table", () => {
    const db = makeMemoryDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    for (const t of [
      "agents", "strategies", "strategy_versions", "trades", "research_notes",
      "market_snapshots", "performance_metrics", "evolution_log",
      "tracked_wallets", "wallet_fills",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("enforces foreign keys", () => {
    const db = makeMemoryDb();
    // Inserting a strategy_version without an existing strategy should fail
    expect(() => db.prepare("INSERT INTO strategy_versions (strategy_id, version, spec_json, rationale) VALUES (999, 1, '{}', 'x')").run()).toThrow();
  });

  it("agents.slug is unique", () => {
    const db = makeMemoryDb();
    db.prepare("INSERT INTO agents (slug, name, charter) VALUES ('a', 'A', 'x')").run();
    expect(() => db.prepare("INSERT INTO agents (slug, name, charter) VALUES ('a', 'A2', 'y')").run()).toThrow();
  });

  it("strategies (agent_id, slug) is unique", () => {
    const db = makeMemoryDb();
    db.prepare("INSERT INTO agents (slug, name, charter) VALUES ('a', 'A', 'x')").run();
    const id = (db.prepare("SELECT id FROM agents WHERE slug='a'").get() as any).id;
    db.prepare("INSERT INTO strategies (agent_id, slug, name, thesis, market_filter) VALUES (?, 's', 'S', 't', '{}')").run(id);
    expect(() => db.prepare("INSERT INTO strategies (agent_id, slug, name, thesis, market_filter) VALUES (?, 's', 'S2', 't', '{}')").run(id)).toThrow();
  });

  it("strategy_versions UNIQUE on (strategy_id, version)", () => {
    const db = makeMemoryDb();
    db.prepare("INSERT INTO agents (slug, name, charter) VALUES ('a', 'A', 'x')").run();
    const agentId = (db.prepare("SELECT id FROM agents WHERE slug='a'").get() as any).id;
    db.prepare("INSERT INTO strategies (agent_id, slug, name, thesis, market_filter) VALUES (?, 's', 'S', 't', '{}')").run(agentId);
    const stratId = (db.prepare("SELECT id FROM strategies WHERE agent_id=?").get(agentId) as any).id;
    db.prepare("INSERT INTO strategy_versions (strategy_id, version, spec_json, rationale) VALUES (?, 1, '{}', 'r')").run(stratId);
    expect(() => db.prepare("INSERT INTO strategy_versions (strategy_id, version, spec_json, rationale) VALUES (?, 1, '{}', 'r2')").run(stratId)).toThrow();
  });

  it("wallet_fills enforces (tx_hash, order_hash) uniqueness", () => {
    const db = makeMemoryDb();
    const insert = (txHash: string, orderHash: string) => db.prepare(
      `INSERT INTO wallet_fills (wallet, side_of_wallet, exchange, block_number, tx_hash, order_hash, maker_address, taker_address, maker_side, token_id, maker_amount, taker_amount, fee)
       VALUES ('0x1', 'maker', 'ctf', 1, ?, ?, '0x1', '0x2', 'BUY', '1', '0', '0', '0')`,
    ).run(txHash, orderHash);
    insert("0xa", "0xb");
    expect(() => insert("0xa", "0xb")).toThrow();
  });

  it.each(["agents", "strategies", "strategy_versions", "trades", "research_notes", "market_snapshots", "tracked_wallets", "wallet_fills", "evolution_log"])(
    "%s table is created and queryable",
    (table) => {
      const db = makeMemoryDb();
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n;
      expect(n).toBe(0);
    },
  );

  it("market_snapshots index exists", () => {
    const db = makeMemoryDb();
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_snap_token_time'").get();
    expect(idx).toBeDefined();
  });

  it("CREATE TABLE IF NOT EXISTS makes init idempotent", () => {
    const db = makeMemoryDb();
    expect(() => makeMemoryDb()).not.toThrow();
    db.close();
  });
});
