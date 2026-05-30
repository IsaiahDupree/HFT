import "./_env.ts";
import { db } from "../src/lib/db/client.ts";

const handle = db();

// One-shot migrations for columns that schema.sql can't add idempotently via
// CREATE TABLE IF NOT EXISTS (SQLite has no ALTER TABLE IF NOT EXISTS).
// Each block: check pragma, ALTER only if missing. Swallowing the duplicate-column
// error would also work but pragma-check is more transparent.
function ensureColumn(table: string, column: string, ddlFragment: string): void {
  const cols = handle.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  handle.exec(`ALTER TABLE ${table} ADD COLUMN ${ddlFragment}`);
  console.log(`  migrated: ${table}.${column} added`);
}

ensureColumn("strategy_versions", "stage", "stage TEXT NOT NULL DEFAULT 'sim'");
ensureColumn("paper_generations", "tick_count", "tick_count INTEGER NOT NULL DEFAULT 0");
ensureColumn("capsules", "paper_agent_id", "paper_agent_id INTEGER REFERENCES paper_agents(id)");
// category tag for Polymarket markets — populated by the keyword classifier
// in `src/lib/polymarket/category.ts` so category_specialist genomes (and
// future wallet-copy-filtered) can route by category dominance. NULL = not
// yet classified.
ensureColumn("market_snapshots", "category", "category TEXT");

// llm_call_log — every call to the LLM probability oracle gets logged here
// (cache hits + misses). Budget guard sums today's cost_usd to refuse calls
// once the daily cap is hit. PRD lunar-inspired §6.5 + Phase 6.
// realtime_ticks — sub-minute price ticks from worker:realtime WS. Arena
// context reads the freshest tick per product (last 90s) and overrides the
// "now" price in coinbase snapshots. PRD arena-agent-decision-framework
// §6.3.L3 + IMPLEMENTATION Phase 7.
handle.exec(`
  CREATE TABLE IF NOT EXISTS realtime_ticks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    product_id TEXT NOT NULL,
    price REAL NOT NULL,
    source TEXT NOT NULL,
    ts_unix INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_realtime_ticks_product_ts ON realtime_ticks(product_id, ts_unix DESC);
`);

handle.exec(`
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
    response_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_llm_call_log_called_at ON llm_call_log(called_at DESC);
  CREATE INDEX IF NOT EXISTS idx_llm_call_log_market_id ON llm_call_log(market_id, called_at DESC);
`);
// error_kind column tags failed oracle calls (rate_limit | auth | parse |
// transport | unknown) so the operator can SELECT to see why the oracle is
// failing. Audit F3. NULL on success.
ensureColumn("llm_call_log", "error_kind", "error_kind TEXT");
// entries_count tracks the count of ENTRY trades (one bump per applySignal
// entry). trades_count continues to count round-trips (bumps on exit), so
// win-rate denominators stay correct. Both columns are tracked because the
// activity bonus in the fitness formula needs to reward action even when an
// agent's positions are still open — i.e. entered but not yet exited.
ensureColumn("paper_agents", "entries_count", "entries_count INTEGER NOT NULL DEFAULT 0");
ensureColumn("paper_agents", "is_elite", "is_elite INTEGER NOT NULL DEFAULT 0");
// Backfill: agents that already have paper_trades rows with intent='entry'
// get their column synced from history. Idempotent — re-running this script
// recomputes from paper_trades each time, but since the column has a default
// of 0 on insert, only agents with existing entry rows need touching.
{
  const updated = handle.prepare(
    `UPDATE paper_agents
       SET entries_count = (
         SELECT COUNT(*) FROM paper_trades
          WHERE paper_trades.paper_agent_id = paper_agents.id
            AND paper_trades.intent = 'entry'
       )
      WHERE EXISTS (
        SELECT 1 FROM paper_trades
         WHERE paper_trades.paper_agent_id = paper_agents.id
           AND paper_trades.intent = 'entry'
      )`,
  ).run();
  if (updated.changes > 0) console.log(`  backfilled paper_agents.entries_count for ${updated.changes} rows`);
}
// Cost-basis tracking — required so SELL fills realize PnL against the
// proportional cost of the open position (instead of treating gross cash
// flow as PnL, which would silently trip max_daily_loss_usd on the BUY leg).
ensureColumn("capsules", "open_position_qty", "open_position_qty REAL NOT NULL DEFAULT 0");
ensureColumn("capsules", "open_position_cost_usd", "open_position_cost_usd REAL NOT NULL DEFAULT 0");
// UTC date of the last daily_pnl reset — when a journal fires on a new
// date, daily_pnl_usd and trades_today reset to 0 first.
ensureColumn("capsules", "daily_pnl_reset_date", "daily_pnl_reset_date TEXT");

console.log("DB ready:", process.env.POLYMARKET_DB_PATH ?? "data/polymarket.db");
