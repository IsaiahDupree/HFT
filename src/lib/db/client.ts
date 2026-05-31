import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DB_PATH = process.env.POLYMARKET_DB_PATH ?? resolve(process.cwd(), "data", "polymarket.db");

let cached: Database.Database | null = null;

export function db(): Database.Database {
  if (cached) return cached;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const handle = new Database(DB_PATH);
  handle.pragma("journal_mode = WAL");
  handle.pragma("foreign_keys = ON");
  const schema = readFileSync(resolve(process.cwd(), "src/lib/db/schema.sql"), "utf8");
  handle.exec(schema);
  runLightMigrations(handle);
  cached = handle;
  return handle;
}

/**
 * Idempotent runtime migrations for changes that SQLite can't express with
 * `CREATE TABLE IF NOT EXISTS` (which silently keeps the old shape on
 * existing DBs). Each step checks `pragma_table_info` first so it's safe to
 * run on every startup.
 */
function runLightMigrations(handle: Database.Database): void {
  const hasColumn = (table: string, col: string): boolean => {
    const row = handle.prepare(
      `SELECT 1 FROM pragma_table_info(?) WHERE name = ?`,
    ).get(table, col);
    return !!row;
  };
  // 2026-05-26: extend cross_venue_arbs for Kalshi sister-venue pairings.
  // ADD COLUMN is conditional; the index is created unconditionally because
  // IF NOT EXISTS makes it idempotent on fresh DBs (where the column came in
  // via schema.sql) and old DBs (where we just added it via ALTER TABLE).
  if (!hasColumn("cross_venue_arbs", "kalshi_ticker")) {
    handle.exec(`ALTER TABLE cross_venue_arbs ADD COLUMN kalshi_ticker TEXT;`);
  }
  handle.exec(
    `CREATE INDEX IF NOT EXISTS idx_cross_venue_kalshi
       ON cross_venue_arbs(kalshi_ticker) WHERE kalshi_ticker IS NOT NULL;`,
  );

  // 2026-05-26: elite preservation. ALTER first (column may be missing on
  // pre-existing DBs), then create the index — schema.sql can't safely create
  // the index because it would fail on old DBs before the ALTER runs.
  if (!hasColumn("paper_agents", "is_elite")) {
    handle.exec(`ALTER TABLE paper_agents ADD COLUMN is_elite INTEGER NOT NULL DEFAULT 0;`);
  }
  handle.exec(
    `CREATE INDEX IF NOT EXISTS idx_paper_agents_elite ON paper_agents(is_elite, alive);`,
  );

  // 2026-05-26: poly_binaries.event_slug for embedding the official
  // Polymarket iframe on /binaries (https://embed.polymarket.com/market?market=<slug>).
  if (!hasColumn("poly_binaries", "event_slug")) {
    handle.exec(`ALTER TABLE poly_binaries ADD COLUMN event_slug TEXT;`);
  }

  // 2026-05-30: market_snapshots.category — classifyMarket() tag written by the
  // snapshot worker and read by the arena TickContext. schema.sql now defines it
  // for fresh DBs; this ALTER backfills DBs created before the column existed
  // (without it, every Polymarket snapshot write + poly tick read throws
  // "no column named category").
  if (!hasColumn("market_snapshots", "category")) {
    handle.exec(`ALTER TABLE market_snapshots ADD COLUMN category TEXT;`);
  }

  // 2026-05-30: paper_generations.tick_count — the per-generation tick counter
  // that drives the auto-evolve trigger. Missing on DBs created before it was
  // tracked (arena:tick's incrementGenerationTickCount throws without it).
  if (!hasColumn("paper_generations", "tick_count")) {
    handle.exec(`ALTER TABLE paper_generations ADD COLUMN tick_count INTEGER NOT NULL DEFAULT 0;`);
  }

  // 2026-05-31: link an ENTRY paper_trade back to the shadow-gate decision that
  // produced it (decision_journal.id), so calibration can grade the gates'
  // approval_score against the realized PnL of the exit (via linked_entry_id).
  if (!hasColumn("paper_trades", "decision_journal_id")) {
    handle.exec(`ALTER TABLE paper_trades ADD COLUMN decision_journal_id INTEGER;`);
  }
  // Index outside the branch: the column now exists on both fresh (schema.sql) and
  // migrated DBs, and CREATE INDEX IF NOT EXISTS is idempotent.
  handle.exec(`CREATE INDEX IF NOT EXISTS idx_paper_trades_decision ON paper_trades(decision_journal_id);`);

  // 2026-05-31: signal_intake gains window_end_ts so the /api/signal route can
  // dedup to one order per (asset,recurrence,window) and the reconciler can map a
  // signal to its window outcome. Safe ALTER on the table created earlier today.
  try {
    if (!hasColumn("signal_intake", "window_end_ts")) {
      handle.exec(`ALTER TABLE signal_intake ADD COLUMN window_end_ts INTEGER;`);
    }
    handle.exec(`CREATE INDEX IF NOT EXISTS idx_signal_intake_window ON signal_intake(asset, recurrence, window_end_ts);`);
  } catch {
    /* table may not exist yet on a brand-new DB — schema.sql creates it with the column */
  }

  // 2026-05-26: drop the FK constraints on order_events.agent_id/capsule_id.
  // The schema's intent is "deliberately NO foreign keys" so a rejection log
  // entry can be written even when the referenced row is missing (e.g. paper
  // agents have id-space separate from `agents` table). Older DBs were
  // created with FKs in place; rebuild the table without them, preserving
  // all existing rows.
  const orderEventsFks = handle.prepare(`PRAGMA foreign_key_list(order_events)`).all() as Array<{ from: string }>;
  if (orderEventsFks.length > 0) {
    handle.exec(`
      CREATE TABLE IF NOT EXISTS order_events_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        seq             INTEGER NOT NULL UNIQUE,
        event           TEXT NOT NULL,
        venue           TEXT NOT NULL,
        client_order_id TEXT NOT NULL,
        broker_order_id TEXT,
        capsule_id      TEXT,
        agent_id        INTEGER,
        symbol          TEXT,
        side            TEXT,
        qty             REAL,
        price           REAL,
        status          TEXT,
        error           TEXT,
        metadata_json   TEXT NOT NULL DEFAULT '{}',
        prev_hash       TEXT NOT NULL DEFAULT '',
        hash            TEXT NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO order_events_new SELECT * FROM order_events;
      DROP TABLE order_events;
      ALTER TABLE order_events_new RENAME TO order_events;
      CREATE INDEX IF NOT EXISTS idx_order_events_coid ON order_events(client_order_id);
      CREATE INDEX IF NOT EXISTS idx_order_events_venue_seq ON order_events(venue, seq);
      CREATE INDEX IF NOT EXISTS idx_order_events_created ON order_events(created_at DESC);
    `);
  }

  // 2026-05-27 (Phase 6): capsule diversity profile columns. Additive, all
  // nullable — existing capsules continue to work without these populated.
  // Populated by scripts/infer-capsule-diversity.ts post-migration.
  for (const [col, ddl] of [
    ["paper_agent_id",         "paper_agent_id INTEGER"],
    ["strategy_family",        "strategy_family TEXT"],
    ["asset_class",            "asset_class TEXT"],
    ["allowed_assets_json",    "allowed_assets_json TEXT"],
    ["time_horizon",           "time_horizon TEXT"],
    ["regime_dependency",      "regime_dependency TEXT"],
    ["directional_bias",       "directional_bias TEXT"],
    ["diversity_profile_json", "diversity_profile_json TEXT"],
    ["diversity_confidence",   "diversity_confidence TEXT NOT NULL DEFAULT 'inferred'"],
  ] as const) {
    if (!hasColumn("capsules", col)) {
      handle.exec(`ALTER TABLE capsules ADD COLUMN ${ddl};`);
    }
  }
  handle.exec(
    `CREATE INDEX IF NOT EXISTS idx_capsules_strategy_family ON capsules(strategy_family) WHERE strategy_family IS NOT NULL;`,
  );
  handle.exec(
    `CREATE INDEX IF NOT EXISTS idx_capsules_asset_class ON capsules(asset_class) WHERE asset_class IS NOT NULL;`,
  );
}

export function closeDb() {
  if (cached) {
    cached.close();
    cached = null;
  }
}
