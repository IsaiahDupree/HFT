/**
 * Test DB helper — spin up a fresh in-memory SQLite per test, apply the schema,
 * and yield queries/client wired to it.
 */
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCHEMA = readFileSync(resolve(process.cwd(), "src/lib/db/schema.sql"), "utf8");

function ensureColumn(d: Database.Database, table: string, column: string, ddlFragment: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddlFragment}`);
}

export function makeMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = MEMORY");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  // Mirror the migrations applied by scripts/init-db.ts so tests use the same shape as prod.
  ensureColumn(db, "strategy_versions", "stage", "stage TEXT NOT NULL DEFAULT 'sim'");
  ensureColumn(db, "paper_generations", "tick_count", "tick_count INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "capsules", "paper_agent_id", "paper_agent_id INTEGER REFERENCES paper_agents(id)");
  ensureColumn(db, "paper_agents", "entries_count", "entries_count INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "paper_agents", "is_elite", "is_elite INTEGER NOT NULL DEFAULT 0");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_paper_agents_elite ON paper_agents(is_elite, alive);`);
  ensureColumn(db, "poly_binaries", "event_slug", "event_slug TEXT");
  ensureColumn(db, "market_snapshots", "category", "category TEXT");
  // Phase 6: capsule diversity profile columns (additive, all nullable).
  ensureColumn(db, "capsules", "strategy_family",        "strategy_family TEXT");
  ensureColumn(db, "capsules", "asset_class",            "asset_class TEXT");
  ensureColumn(db, "capsules", "allowed_assets_json",    "allowed_assets_json TEXT");
  ensureColumn(db, "capsules", "time_horizon",           "time_horizon TEXT");
  ensureColumn(db, "capsules", "regime_dependency",      "regime_dependency TEXT");
  ensureColumn(db, "capsules", "directional_bias",       "directional_bias TEXT");
  ensureColumn(db, "capsules", "diversity_profile_json", "diversity_profile_json TEXT");
  ensureColumn(db, "capsules", "diversity_confidence",   "diversity_confidence TEXT NOT NULL DEFAULT 'inferred'");
  // Phase 7: capsule_pnl_daily + capsule_correlations come from schema.sql via
  // CREATE TABLE IF NOT EXISTS — no ALTERs needed for the test in-memory DB.
  db.exec(`
    CREATE TABLE IF NOT EXISTS realtime_ticks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      product_id TEXT NOT NULL,
      price REAL NOT NULL,
      source TEXT NOT NULL,
      ts_unix INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_call_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      market_id TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL NOT NULL DEFAULT 0,
      called_at TEXT NOT NULL DEFAULT (datetime('now')),
      caller_agent_id INTEGER,
      cache_hit INTEGER NOT NULL DEFAULT 0,
      response_json TEXT,
      error_kind TEXT
    );
  `);
  // Also create the tracked_wallets + wallet_fills tables that live outside the main schema file
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      handle TEXT UNIQUE NOT NULL,
      proxy_wallet TEXT,
      note TEXT,
      claimed_profit_usd REAL,
      strategy_label TEXT,
      last_resolved TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS wallet_fills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT NOT NULL,
      side_of_wallet TEXT NOT NULL,
      exchange TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      tx_hash TEXT NOT NULL,
      order_hash TEXT NOT NULL,
      maker_address TEXT NOT NULL,
      taker_address TEXT NOT NULL,
      maker_side TEXT NOT NULL,
      token_id TEXT NOT NULL,
      maker_amount TEXT NOT NULL,
      taker_amount TEXT NOT NULL,
      fee TEXT NOT NULL,
      builder TEXT,
      implied_price REAL,
      implied_shares REAL,
      implied_usd REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tx_hash, order_hash)
    );
  `);
  return db;
}
