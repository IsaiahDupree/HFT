-- Local SQLite store for the Polymarket agent workspace.
-- Tables are evolved with `CREATE TABLE IF NOT EXISTS` so init is idempotent.

CREATE TABLE IF NOT EXISTS agents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  charter         TEXT NOT NULL,                       -- the agent's purpose / mandate
  risk_budget_usd REAL NOT NULL DEFAULT 100.0,
  status          TEXT NOT NULL DEFAULT 'active',      -- active | paused | retired
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS strategies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id        INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  slug            TEXT NOT NULL,
  name            TEXT NOT NULL,
  thesis          TEXT NOT NULL,
  market_filter   TEXT NOT NULL,                       -- JSON: tags, categories, time horizon
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, slug)
);

-- Versioned strategy specs so the evolution loop can iterate.
-- `stage` is the release-stage ladder borrowed from TradingBot/marketplace:
--   sim            — never trades real capital; runs against snapshots only
--   paper          — submits but only through a paper/sim venue adapter
--   live_eligible  — backtest passed, awaiting capsule binding
--   live           — actively trades against allocated capsule capital
--   restricted     — flagged (high drawdown, broken auth, manual hold)
CREATE TABLE IF NOT EXISTS strategy_versions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id          INTEGER NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  parent_version_id    INTEGER REFERENCES strategy_versions(id),
  version              INTEGER NOT NULL,
  spec_json            TEXT NOT NULL,                  -- params: entry/exit rules, sizing
  rationale            TEXT NOT NULL,                  -- why this version supersedes the parent
  introduced_by        TEXT NOT NULL DEFAULT 'human',  -- human | agent:<slug> | research-loop
  backtest_summary     TEXT,                           -- JSON of perf metrics
  is_current           INTEGER NOT NULL DEFAULT 0,
  stage                TEXT NOT NULL DEFAULT 'sim',    -- sim | paper | live_eligible | live | restricted
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(strategy_id, version)
);

-- Trades the app has either observed or executed for a given strategy.
CREATE TABLE IF NOT EXISTS trades (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_version_id  INTEGER NOT NULL REFERENCES strategy_versions(id) ON DELETE CASCADE,
  market_condition_id  TEXT NOT NULL,
  token_id             TEXT NOT NULL,
  side                 TEXT NOT NULL,                  -- BUY | SELL
  price                REAL NOT NULL,
  size                 REAL NOT NULL,
  intent               TEXT NOT NULL,                  -- entry | exit | hedge | rebalance
  status               TEXT NOT NULL DEFAULT 'planned',-- planned | submitted | filled | rejected | cancelled
  order_id             TEXT,
  tx_hash              TEXT,
  pnl_usd              REAL,
  notes                TEXT,
  opened_at            TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at            TEXT
);

-- Free-form research notes attached to a market and/or strategy.
CREATE TABLE IF NOT EXISTS research_notes (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id             INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  strategy_id          INTEGER REFERENCES strategies(id) ON DELETE SET NULL,
  market_condition_id  TEXT,
  topic                TEXT NOT NULL,
  body                 TEXT NOT NULL,                  -- markdown
  source_urls_json     TEXT NOT NULL DEFAULT '[]',
  confidence           REAL NOT NULL DEFAULT 0.5,      -- 0..1
  tags_json            TEXT NOT NULL DEFAULT '[]',
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Snapshots of markets the agents watch — fuels back-testing + dashboards.
CREATE TABLE IF NOT EXISTS market_snapshots (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  condition_id         TEXT NOT NULL,
  token_id             TEXT NOT NULL,
  question             TEXT NOT NULL,
  yes_price            REAL,
  no_price             REAL,
  midpoint             REAL,
  spread               REAL,
  volume_24h           REAL,
  open_interest        REAL,
  liquidity_usd        REAL,
  category             TEXT,                          -- classifyMarket() tag; set by the snapshot worker
  captured_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_snap_token_time ON market_snapshots(token_id, captured_at DESC);

-- Sub-minute crypto WS ticks (worker:realtime). The arena TickContext reads the
-- freshest tick per product to override stale REST snapshot prices. Written by
-- src/lib/arena/realtime-ticks.ts; empty until `npm run worker:realtime` runs.
CREATE TABLE IF NOT EXISTS realtime_ticks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol      TEXT NOT NULL,
  product_id  TEXT NOT NULL,
  price       REAL NOT NULL,
  source      TEXT,
  ts_unix     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_realtime_ticks_product_ts ON realtime_ticks(product_id, ts_unix DESC);

-- LLM oracle call log — cost/budget tracker for llm_probability_oracle agents.
-- Written by src/lib/arena/llm-oracle.ts; read by llm-oracle-budget.ts to enforce
-- ARENA_LLM_ORACLE_DAILY_USD (default $1/day). Missing on fresh DBs would crash
-- arena:tick whenever the oracle warmer is enabled.
CREATE TABLE IF NOT EXISTS llm_call_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  model           TEXT NOT NULL,
  prompt_version  TEXT,
  market_id       TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost_usd        REAL NOT NULL DEFAULT 0,
  caller_agent_id INTEGER,
  cache_hit       INTEGER NOT NULL DEFAULT 0,
  response_json   TEXT,
  error_kind      TEXT,
  called_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_llm_call_log_called ON llm_call_log(called_at);

-- Performance summary per strategy_version, recomputed by the research loop.
CREATE TABLE IF NOT EXISTS performance_metrics (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_version_id  INTEGER NOT NULL REFERENCES strategy_versions(id) ON DELETE CASCADE,
  window               TEXT NOT NULL,                  -- 1d | 7d | 30d | all
  trades_count         INTEGER NOT NULL,
  win_rate             REAL,
  total_pnl_usd        REAL,
  sharpe               REAL,
  max_drawdown_usd     REAL,
  computed_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(strategy_version_id, window)
);

-- Append-only log of every evolution event the system records.
CREATE TABLE IF NOT EXISTS evolution_log (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id             INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  strategy_id          INTEGER REFERENCES strategies(id) ON DELETE SET NULL,
  from_version_id      INTEGER REFERENCES strategy_versions(id),
  to_version_id        INTEGER REFERENCES strategy_versions(id),
  event_type           TEXT NOT NULL,                  -- proposal | promotion | retirement | scoring | cb-* | arb-*
  summary              TEXT NOT NULL,
  payload_json         TEXT NOT NULL DEFAULT '{}',
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- Coinbase Advanced Trade — multi-venue tracking
-- ============================================================================

-- Periodic snapshot of account balances (one row per account per snapshot).
CREATE TABLE IF NOT EXISTS coinbase_accounts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid                 TEXT NOT NULL,                  -- Coinbase account uuid
  name                 TEXT,
  currency             TEXT NOT NULL,
  available_balance    REAL,
  hold                 REAL,
  type                 TEXT,                           -- ACCOUNT_TYPE_CRYPTO | ACCOUNT_TYPE_FIAT | etc.
  is_default           INTEGER NOT NULL DEFAULT 0,
  active               INTEGER NOT NULL DEFAULT 1,
  captured_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cb_accounts_uuid_time ON coinbase_accounts(uuid, captured_at DESC);

-- Mirror of orders we placed or observed (one row per order_id, upserted on status changes).
CREATE TABLE IF NOT EXISTS coinbase_orders (
  order_id             TEXT PRIMARY KEY,               -- Coinbase order_id
  client_order_id      TEXT,
  product_id           TEXT NOT NULL,
  side                 TEXT NOT NULL,                  -- BUY | SELL
  order_type           TEXT,                           -- MARKET | LIMIT | STOP_LIMIT | TRIGGER_BRACKET
  status               TEXT,                           -- OPEN | FILLED | CANCELLED | EXPIRED | FAILED
  size                 REAL,                           -- base or quote depending on type
  size_currency        TEXT,                           -- 'BASE' | 'QUOTE'
  filled_size          REAL,
  average_filled_price REAL,
  total_value_after_fees REAL,
  agent_id             INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  strategy_version_id  INTEGER REFERENCES strategy_versions(id) ON DELETE SET NULL,
  raw_json             TEXT,                           -- full last-seen response
  created_time         TEXT,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cb_orders_product_status ON coinbase_orders(product_id, status);

-- Fill history (one row per fill_id).
CREATE TABLE IF NOT EXISTS coinbase_fills (
  fill_id              TEXT PRIMARY KEY,
  order_id             TEXT NOT NULL REFERENCES coinbase_orders(order_id) ON DELETE CASCADE,
  product_id           TEXT NOT NULL,
  side                 TEXT NOT NULL,
  size                 REAL,
  price                REAL,
  commission           REAL,
  trade_time           TEXT,
  liquidity_indicator  TEXT,                           -- M=maker, T=taker
  captured_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cb_fills_order ON coinbase_fills(order_id);

-- Periodic price snapshots — fuels back-testing + cross-venue arb detection.
CREATE TABLE IF NOT EXISTS coinbase_snapshots (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id           TEXT NOT NULL,
  best_bid             REAL,
  best_ask             REAL,
  midpoint             REAL,
  spread               REAL,
  volume_24h           REAL,
  price_24h_change_pct REAL,
  captured_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cb_snap_product_time ON coinbase_snapshots(product_id, captured_at DESC);

-- OHLC candles at fine granularity (default ONE_MINUTE). Coinbase serves
-- candles in fixed start_unix buckets, so the dedup key is
-- (product_id, granularity, start_unix). One row per bucket per product.
-- Used by momentum derivatives (velocity / acceleration) for fast-tick
-- strategies that need finer-grained price action than the 5-min snapshot rate.
CREATE TABLE IF NOT EXISTS coinbase_candles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    TEXT NOT NULL,
  granularity   TEXT NOT NULL DEFAULT 'ONE_MINUTE',
  start_unix    INTEGER NOT NULL,                    -- candle start (epoch seconds)
  open          REAL NOT NULL,
  high          REAL NOT NULL,
  low           REAL NOT NULL,
  close         REAL NOT NULL,
  volume        REAL,
  captured_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(product_id, granularity, start_unix)
);
CREATE INDEX IF NOT EXISTS idx_cb_candles_product_start ON coinbase_candles(product_id, granularity, start_unix DESC);

-- Historical OHLCV from CoinDesk Data API. Separate table from
-- `coinbase_candles` because it pulls from multiple exchanges and goes back
-- years (vs Coinbase live snapshots that only cover the last few hours).
-- Arena momentum strategies union both via `loadRecentCandles`.
CREATE TABLE IF NOT EXISTS coindesk_candles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  market        TEXT NOT NULL,                       -- exchange, e.g. 'coinbase'
  instrument    TEXT NOT NULL,                       -- e.g. 'BTC-USD'
  granularity   TEXT NOT NULL DEFAULT 'ONE_MINUTE',  -- ONE_MINUTE | ONE_HOUR | ONE_DAY
  start_unix    INTEGER NOT NULL,
  open          REAL NOT NULL,
  high          REAL NOT NULL,
  low           REAL NOT NULL,
  close         REAL NOT NULL,
  volume        REAL,                                -- base-asset volume
  quote_volume  REAL,                                -- quote-asset volume (USD for *-USD)
  total_trades  INTEGER,
  ingested_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(market, instrument, granularity, start_unix)
);
CREATE INDEX IF NOT EXISTS idx_cd_candles_inst_start ON coindesk_candles(instrument, granularity, start_unix DESC);
CREATE INDEX IF NOT EXISTS idx_cd_candles_market ON coindesk_candles(market, instrument);

-- Sidecar metadata for short-duration Polymarket binaries (5-min / 15-min Up
-- or Down events). The base market_snapshots table records the YES token's
-- midpoint each tick; this table holds the per-token info that doesn't change
-- during the market's life: which crypto, when it expires, whether it has
-- settled. The arena resolver consults this to force-close positions when the
-- market resolves.
CREATE TABLE IF NOT EXISTS poly_binaries (
  token_id          TEXT PRIMARY KEY,             -- Polymarket CLOB token id (YES side)
  condition_id      TEXT NOT NULL,
  no_token_id       TEXT,                          -- NO side token id (for SELL → buy-NO equivalence)
  question          TEXT NOT NULL,
  asset             TEXT NOT NULL,                 -- BTC | ETH | SOL | XRP | DOGE | BNB | HYPE | UNKNOWN
  duration_kind     TEXT NOT NULL DEFAULT '5M',    -- '5M' | '15M' | other tag observed
  start_iso         TEXT,                          -- event.startDate
  expiry_iso        TEXT NOT NULL,                 -- event.endDate (when binary settles)
  reference_price   REAL,                          -- baseline price at start, set by resolver
  settled           INTEGER NOT NULL DEFAULT 0,
  outcome_yes       INTEGER,                       -- 1=YES, 0=NO (only set when settled)
  resolved_at       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_poly_binaries_expiry ON poly_binaries(settled, expiry_iso);
CREATE INDEX IF NOT EXISTS idx_poly_binaries_asset ON poly_binaries(asset, expiry_iso);

-- Links a Polymarket market (condition_id) to a sister-venue symbol for paired
-- pricing / cross-venue arb. Either coinbase_product_id OR kalshi_ticker (or
-- both, for triangle setups) identifies the other venue. Many-to-many handled
-- via separate rows. NB: existing installs are upgraded by the runtime
-- migration in src/lib/db/client.ts which ADDs the kalshi_ticker column.
CREATE TABLE IF NOT EXISTS cross_venue_arbs (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  poly_condition_id        TEXT NOT NULL,
  poly_question            TEXT,
  coinbase_product_id      TEXT,                       -- nullable when pairing is Polymarket↔Kalshi only
  kalshi_ticker            TEXT,                       -- e.g. KXBTC15M-25MAY26-1745-T120000
  pairing_kind             TEXT NOT NULL,             -- 'price_threshold' | 'event_outcome' | 'hedge' | 'pure_arb'
  threshold_value          REAL,                       -- e.g., for 'BTC > $X' markets, X (in USD)
  threshold_direction      TEXT,                       -- 'gt' | 'gte' | 'lt' | 'lte'
  expiry_iso               TEXT,                       -- if the Polymarket question resolves at a date
  agent_id                 INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  strategy_id              INTEGER REFERENCES strategies(id) ON DELETE SET NULL,
  rationale                TEXT,
  active                   INTEGER NOT NULL DEFAULT 1,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (coinbase_product_id IS NOT NULL OR kalshi_ticker IS NOT NULL),
  UNIQUE(poly_condition_id, coinbase_product_id, kalshi_ticker, pairing_kind)
);
CREATE INDEX IF NOT EXISTS idx_cross_venue_active ON cross_venue_arbs(active, poly_condition_id);
-- idx_cross_venue_kalshi is created in src/lib/db/client.ts runLightMigrations()
-- because existing DBs need ALTER TABLE ADD COLUMN to run BEFORE any index that
-- references the new column. Keeping it out of schema.sql avoids ordering bugs.

-- ============================================================================
-- Capsules — per-agent risk envelopes (pattern from TradingBot/src/capsules)
-- ============================================================================

-- A capsule bounds how a strategy operates on real capital: how much it can
-- deploy, how much it's allowed to lose in a day, how many open positions, etc.
-- One agent can have multiple capsules across different venues/asset classes.
CREATE TABLE IF NOT EXISTS capsules (
  id                          TEXT PRIMARY KEY,                 -- UUID
  agent_id                    INTEGER REFERENCES agents(id) ON DELETE CASCADE,
  strategy_id                 INTEGER REFERENCES strategies(id) ON DELETE SET NULL,
  paper_agent_id              INTEGER,                          -- bound arena paper_agent (championship/auto-promote)
  name                        TEXT NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'draft',    -- draft|paper|live|paused|stopped|closed
  -- Capital
  capital_allocated_usd       REAL NOT NULL DEFAULT 0.0,
  capital_deployed_usd        REAL NOT NULL DEFAULT 0.0,
  capital_available_usd       REAL NOT NULL DEFAULT 0.0,
  -- Hard caps (capsule auto-pauses on breach)
  max_daily_loss_usd          REAL NOT NULL DEFAULT 0.0,
  max_total_drawdown_usd      REAL NOT NULL DEFAULT 0.0,
  max_position_pct            REAL NOT NULL DEFAULT 0.0,        -- 0.0–1.0
  max_open_positions          INTEGER NOT NULL DEFAULT 0,
  max_trades_per_day          INTEGER NOT NULL DEFAULT 0,
  -- Permissions
  allowed_venues_json         TEXT NOT NULL DEFAULT '[]',       -- e.g. ["polymarket","coinbase"]
  allowed_symbols_json        TEXT,                             -- null = any symbol
  min_seconds_between_trades  REAL NOT NULL DEFAULT 0.0,
  -- Realtime (updated by router/reconciler)
  current_pnl_usd             REAL NOT NULL DEFAULT 0.0,
  daily_pnl_usd               REAL NOT NULL DEFAULT 0.0,
  open_positions              INTEGER NOT NULL DEFAULT 0,
  trades_today                INTEGER NOT NULL DEFAULT 0,
  -- Cost-basis tracking (aggregate across symbols — accurate for single-symbol
  -- capsules, which is the common case for v1). SELL fills realize PnL against
  -- the proportional cost; without this, daily_pnl_usd would track gross cash
  -- flow and silently trip max_daily_loss_usd on the BUY leg of a round trip.
  open_position_qty           REAL NOT NULL DEFAULT 0.0,
  open_position_cost_usd      REAL NOT NULL DEFAULT 0.0,
  daily_pnl_reset_date        TEXT,
  -- Diversity profile (Phase 6 of gated-decision-system PRD).
  -- Populated by scripts/infer-capsule-diversity.ts from the bound agent's
  -- genome kind. Operator can override via UI to lock against re-inference.
  -- Used by: correlation engine, cluster kill switches, global risk governor.
  strategy_family             TEXT,                             -- momentum|mean_reversion|vol_breakout|market_neutral|consensus|scrape|directional|market_making|oracle|experimental|reserve
  asset_class                 TEXT,                             -- crypto|equity|macro|stable|prediction_market
  allowed_assets_json         TEXT,                             -- subset of asset_class, e.g. ["BTC","ETH"]
  time_horizon                TEXT,                             -- 1m|5m|15m|1h|1d|to_resolution
  regime_dependency           TEXT,                             -- trending|chop|high_vol|low_vol|breakout|any
  directional_bias            TEXT,                             -- long_only|short_only|long_short|neutral
  diversity_profile_json      TEXT,                             -- escape hatch for richer metadata
  diversity_confidence        TEXT NOT NULL DEFAULT 'inferred', -- inferred|operator_set
  -- Lifecycle
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at                TEXT
);
CREATE INDEX IF NOT EXISTS idx_capsules_agent ON capsules(agent_id);
CREATE INDEX IF NOT EXISTS idx_capsules_status ON capsules(status);
-- Diversity-profile indexes (idx_capsules_strategy_family, idx_capsules_asset_class)
-- are created in runLightMigrations() so they only run after the ALTER TABLEs
-- that add the columns on pre-existing DBs.

-- ============================================================================
-- Order events — append-only execution log (pattern from TradingBot router)
-- ============================================================================

-- Every order submitted through the venue router writes here in order. The
-- reconciler also writes here when it detects external state changes (fills,
-- cancellations, etc.) so the chain stays canonical. Hash chain mirrors the
-- TradingBot OrderEventLog so tampering breaks verify_chain().
-- Audit log: deliberately NO foreign keys on capsule_id / agent_id. The log
-- should retain what was attempted even if the referenced capsule or agent
-- was later deleted, and a rejection ("CAPSULE_NOT_FOUND") needs to be
-- writable even when the FK target is genuinely absent.
CREATE TABLE IF NOT EXISTS order_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  seq             INTEGER NOT NULL UNIQUE,            -- monotonic counter
  event           TEXT NOT NULL,                       -- submitting | status_filled | rejected_risk | rejected_capsule | rejected_halt | cancelled | reconcile_drift
  venue           TEXT NOT NULL,                       -- polymarket | coinbase | sim | paper
  client_order_id TEXT NOT NULL,
  broker_order_id TEXT,
  capsule_id      TEXT,
  agent_id        INTEGER,
  symbol          TEXT,                                -- product_id, token_id, or asset symbol
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
CREATE INDEX IF NOT EXISTS idx_order_events_coid ON order_events(client_order_id);
CREATE INDEX IF NOT EXISTS idx_order_events_venue_seq ON order_events(venue, seq);
CREATE INDEX IF NOT EXISTS idx_order_events_created ON order_events(created_at DESC);

-- ============================================================================
-- Arena — paper-trading agents, genetic evolution, championship lineage
-- ============================================================================

-- One row per paper trading agent. A generation contains N agents (default 8).
-- `genome_json` is the structured strategy spec (typed parameter vector,
-- validated by src/lib/arena/genome.ts). `parent_paper_agent_id` lets us walk
-- the lineage tree. Cash + position basket are updated by the sim engine.
CREATE TABLE IF NOT EXISTS paper_agents (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  name                     TEXT UNIQUE NOT NULL,                 -- e.g. "g0-a3-fade-spike"
  generation               INTEGER NOT NULL,
  parent_paper_agent_id    INTEGER REFERENCES paper_agents(id) ON DELETE SET NULL,
  genome_json              TEXT NOT NULL,                        -- { kind, params } — zod-validated
  introduced_by            TEXT NOT NULL DEFAULT 'init',         -- init | mutate-programmatic | mutate-llm | crossover
  cash_usd_start           REAL NOT NULL DEFAULT 1000.0,
  cash_usd_current         REAL NOT NULL DEFAULT 1000.0,
  position_basket_json     TEXT NOT NULL DEFAULT '[]',           -- open positions [{venue, market_id, side, size, entry_price, opened_at}]
  realized_pnl_usd         REAL NOT NULL DEFAULT 0.0,
  unrealized_pnl_usd       REAL NOT NULL DEFAULT 0.0,
  peak_equity_usd          REAL NOT NULL DEFAULT 1000.0,         -- for drawdown calc
  max_drawdown_usd         REAL NOT NULL DEFAULT 0.0,
  trades_count             INTEGER NOT NULL DEFAULT 0,           -- bumps on EXIT (round-trips); win-rate denominator
  entries_count            INTEGER NOT NULL DEFAULT 0,           -- bumps on ENTRY; fitness activity bonus reads this
  wins_count               INTEGER NOT NULL DEFAULT 0,
  alive                    INTEGER NOT NULL DEFAULT 1,           -- 1=alive, 0=retired
  -- Elite preservation: when 1, evolve() will NOT retire this agent at seal
  -- time even if a younger generation outranks it. Top-N (ARENA_ELITE_COUNT,
  -- default 5) alive-across-all-gens are promoted each seal; elites whose
  -- drawdown from peak crosses ARENA_ELITE_MAX_DD_PCT lose the flag and
  -- re-enter the normal cull pool. Set explicitly by evolve.ts; never by hand.
  is_elite                 INTEGER NOT NULL DEFAULT 0,
  retire_reason            TEXT,
  retired_at               TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_paper_agents_gen_alive ON paper_agents(generation, alive);
CREATE INDEX IF NOT EXISTS idx_paper_agents_parent ON paper_agents(parent_paper_agent_id);
-- idx_paper_agents_elite created in runLightMigrations() after the column is
-- ensured via ALTER TABLE on existing DBs.

-- One row per simulated trade — entries and exits both. Realized PnL on exits.
-- `venue` is sim-only ('sim-poly' | 'sim-coinbase') so this table never gets
-- confused with the live `trades` table.
CREATE TABLE IF NOT EXISTS paper_trades (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_agent_id           INTEGER NOT NULL REFERENCES paper_agents(id) ON DELETE CASCADE,
  venue                    TEXT NOT NULL,                        -- 'sim-poly' | 'sim-coinbase'
  market_id                TEXT NOT NULL,                        -- token_id (poly) or product_id (coinbase)
  side                     TEXT NOT NULL,                        -- BUY | SELL
  intent                   TEXT NOT NULL,                        -- entry | exit | hedge | rebalance
  price                    REAL NOT NULL,
  size_usd                 REAL NOT NULL,
  fee_usd                  REAL NOT NULL DEFAULT 0.0,
  realized_pnl_usd         REAL,                                  -- non-null only on exit
  linked_entry_id          INTEGER REFERENCES paper_trades(id),  -- exit → entry pointer
  signal_rationale         TEXT,                                  -- why the agent fired (compact JSON or short text)
  tick_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  generation               INTEGER NOT NULL,
  decision_journal_id      INTEGER REFERENCES decision_journal(id) -- entry → shadow-gate decision (for calibration)
);
CREATE INDEX IF NOT EXISTS idx_paper_trades_agent_tick ON paper_trades(paper_agent_id, tick_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_trades_gen ON paper_trades(generation);
-- idx_paper_trades_decision is created in runLightMigrations (after the column
-- is guaranteed to exist on both fresh and migrated DBs).

-- One row per generation. Sealed by `arena:evolve`.
-- Score formula: pnl_pct - 2.0 * max_dd_pct (TradingBot Arena pattern).
CREATE TABLE IF NOT EXISTS paper_generations (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  gen_number               INTEGER UNIQUE NOT NULL,
  started_at               TEXT NOT NULL DEFAULT (datetime('now')),
  sealed_at                TEXT,
  n_agents                 INTEGER NOT NULL DEFAULT 0,
  tick_count               INTEGER NOT NULL DEFAULT 0,            -- ticks since gen opened (auto-evolve trigger)
  n_alive_at_seal          INTEGER,
  n_promoted_children      INTEGER,                              -- how many top agents bred children
  top_paper_agent_id       INTEGER REFERENCES paper_agents(id),
  top_score                REAL,
  replay_window_start      TEXT,                                  -- if generation included a replay/backtest warmup
  replay_window_end        TEXT,
  notes                    TEXT
);

-- Append-only ledger linking arena → existing `capsules` table.
-- A paper_agent that wins top-1 across N consecutive generations earns
-- a capsule promotion proposal. Activation flips capsules.status from
-- 'paper' to 'live' under human approval.
CREATE TABLE IF NOT EXISTS championship_log (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_agent_id           INTEGER NOT NULL REFERENCES paper_agents(id) ON DELETE CASCADE,
  consecutive_gen_wins     INTEGER NOT NULL,                     -- e.g. 3 means top-1 in last 3 gens
  capsule_id               TEXT REFERENCES capsules(id),         -- non-null once a capsule is proposed
  status                   TEXT NOT NULL DEFAULT 'eligible',     -- eligible | proposed | activated | rejected | expired
  rationale                TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_championship_agent ON championship_log(paper_agent_id);
CREATE INDEX IF NOT EXISTS idx_championship_status ON championship_log(status);

-- ============================================================================
-- Tracked wallets — externally-cited Polymarket profiles we want to fingerprint
-- ============================================================================
-- Populated by `scripts/seed-tracked-wallets.ts` (seeds from research/* docs)
-- and `scripts/scan-leaderboard.ts` (auto-discovered high performers from the
-- Data API leaderboard). Resolved handle → proxy_wallet by
-- `scripts/resolve-tracked-wallets.ts`; fingerprinted live on /wallets/[address].
CREATE TABLE IF NOT EXISTS tracked_wallets (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  handle              TEXT UNIQUE NOT NULL,            -- userName or 0xaddr
  proxy_wallet        TEXT,                            -- resolved 0xaddr (Polygon)
  note                TEXT,
  claimed_profit_usd  REAL,                            -- as reported by source — NOT measured
  strategy_label      TEXT,                            -- e.g. 'crypto+macro high-freq'
  last_resolved       TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tracked_proxy ON tracked_wallets(proxy_wallet);

-- On-chain fill mirror for tracked wallets. Populated by
-- `scripts/backfill-wallet.ts` from CTF Exchange OrderFilled events.
CREATE TABLE IF NOT EXISTS wallet_fills (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet              TEXT NOT NULL,
  side_of_wallet      TEXT NOT NULL,                   -- 'maker' | 'taker'
  exchange            TEXT NOT NULL,                   -- 'ctf' | 'neg_risk'
  block_number        INTEGER NOT NULL,
  tx_hash             TEXT NOT NULL,
  order_hash          TEXT NOT NULL,
  maker_address       TEXT NOT NULL,
  taker_address       TEXT NOT NULL,
  maker_side          TEXT NOT NULL,                   -- 'BUY' | 'SELL'
  token_id            TEXT NOT NULL,
  maker_amount        TEXT NOT NULL,                   -- raw (USDC has 6 decimals)
  taker_amount        TEXT NOT NULL,                   -- raw (CTF has 6 decimals)
  fee                 TEXT NOT NULL,
  builder             TEXT,
  implied_price       REAL,                            -- derived for convenience
  implied_shares      REAL,
  implied_usd         REAL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tx_hash, order_hash)
);
CREATE INDEX IF NOT EXISTS idx_wallet_fills_wallet ON wallet_fills(wallet, block_number DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_fills_token ON wallet_fills(token_id);

-- Copy-trade backtest results — populated by `scripts/copy-backtest.ts`. One
-- row per (wallet × lag × hold) bucket per run. Each run carries a `run_id`
-- so re-runs don't overwrite history; the UI shows the latest run per wallet.
CREATE TABLE IF NOT EXISTS copy_backtest_results (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                TEXT NOT NULL,                  -- ISO timestamp of the run
  wallet_address        TEXT NOT NULL,
  wallet_handle         TEXT,
  lag_sec               INTEGER NOT NULL,
  hold_min              INTEGER NOT NULL,
  n_trades              INTEGER NOT NULL,
  n_wins                INTEGER NOT NULL,
  win_rate              REAL NOT NULL,
  pnl_usd               REAL NOT NULL,
  pnl_pct               REAL NOT NULL,
  avg_drift_bps         REAL NOT NULL,
  avg_hold_realized_pct REAL NOT NULL,
  size_usd              REAL NOT NULL,
  slippage_bps          INTEGER NOT NULL,
  fee_bps               INTEGER NOT NULL,
  trades_seen           INTEGER NOT NULL,
  trades_used           INTEGER NOT NULL,
  notes_json            TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_copy_backtest_wallet_run ON copy_backtest_results(wallet_address, run_id);
CREATE INDEX IF NOT EXISTS idx_copy_backtest_run ON copy_backtest_results(run_id);

-- Resolved-outcome scoring complements the midpoint backtester. For each
-- closed market the wallet traded, we know the binary outcome and can settle
-- a copy at any slippage tier. Unlocks all historical data the midpoint
-- backtester can't see because resolved markets return empty prices-history.
CREATE TABLE IF NOT EXISTS copy_backtest_resolved (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                   TEXT NOT NULL,
  wallet_address           TEXT NOT NULL,
  wallet_handle            TEXT,
  slippage_bps             INTEGER NOT NULL,
  n_trades                 INTEGER NOT NULL,
  n_wins                   INTEGER NOT NULL,
  win_rate                 REAL NOT NULL,
  pnl_usd                  REAL NOT NULL,
  pnl_pct                  REAL NOT NULL,
  avg_winner_multiple      REAL NOT NULL,
  size_usd                 REAL NOT NULL,
  fee_bps                  INTEGER NOT NULL,
  trades_seen              INTEGER NOT NULL,
  trades_used              INTEGER NOT NULL,
  trades_skipped_unresolved INTEGER NOT NULL,
  trades_skipped_no_token_match INTEGER NOT NULL,
  trades_after_dedup       INTEGER,                 -- post slug-collapse trade count
  distinct_markets_used    INTEGER,                 -- distinct resolved markets in scoring
  verdict_rating           TEXT,                    -- insufficient_data | loss | marginal | profitable
  verdict_reason           TEXT,
  notes_json               TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_copy_resolved_wallet_run ON copy_backtest_resolved(wallet_address, run_id);

-- Consensus-signal backtest — settles each historical consensus signal against
-- the resolved outcome of its market. Tests the platform thesis: do
-- "≥N tracked wallets agree" signals actually pay off, or is it noise?
CREATE TABLE IF NOT EXISTS consensus_backtest_results (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id              TEXT NOT NULL,
  slippage_bps        INTEGER NOT NULL,
  n_signals           INTEGER NOT NULL,
  n_wins              INTEGER NOT NULL,
  win_rate            REAL NOT NULL,
  pnl_usd             REAL NOT NULL,
  pnl_pct             REAL NOT NULL,
  avg_winner_multiple REAL NOT NULL,
  size_usd            REAL NOT NULL,
  fee_bps             INTEGER NOT NULL,
  signals_seen        INTEGER NOT NULL,
  signals_used        INTEGER NOT NULL,
  signals_skipped_unresolved INTEGER NOT NULL,
  signals_skipped_indecipherable INTEGER NOT NULL,
  verdict_rating      TEXT,
  verdict_reason      TEXT,
  n_distinct_signals  INTEGER,
  config_json         TEXT,    -- consensus producer config used (min_wallets, window_min, etc.)
  notes_json          TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_consensus_backtest_run ON consensus_backtest_results(run_id);

-- Retroactive consensus — uses /closed-positions instead of /trades. Every
-- signal here is by definition on a resolved market, so we can settle copy
-- PnL immediately without waiting on resolution.
CREATE TABLE IF NOT EXISTS retroactive_consensus_signals (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id              TEXT NOT NULL,
  condition_id        TEXT NOT NULL,
  market_title        TEXT,
  outcome_index       INTEGER NOT NULL,
  outcome             TEXT,
  won                 INTEGER NOT NULL,
  wallet_count        INTEGER NOT NULL,
  combined_trust      INTEGER NOT NULL,
  combined_usd        REAL NOT NULL,
  consensus_avg_price REAL NOT NULL,
  wallets_json        TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_retro_signals_run ON retroactive_consensus_signals(run_id);

CREATE TABLE IF NOT EXISTS retroactive_consensus_buckets (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id              TEXT NOT NULL,
  slippage_bps        INTEGER NOT NULL,
  n_signals           INTEGER NOT NULL,
  n_wins              INTEGER NOT NULL,
  win_rate            REAL NOT NULL,
  pnl_usd             REAL NOT NULL,
  pnl_pct             REAL NOT NULL,
  avg_winner_multiple REAL NOT NULL,
  size_usd            REAL NOT NULL,
  verdict_rating      TEXT,
  verdict_reason      TEXT,
  n_distinct_signals  INTEGER,
  config_json         TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_retro_buckets_run ON retroactive_consensus_buckets(run_id);

-- Capsule daily-PnL history (Phase 7 of capsule-portfolio-governance PRD).
-- Snapshotted at UTC midnight by scripts/worker-portfolio-snapshot.ts before
-- the auto-reset zeroes daily_pnl_usd. Gives the correlation engine a clean
-- time series per capsule for Pearson + joint-loss math.
--
-- UNIQUE(capsule_id, pnl_date) makes the worker idempotent — re-running on
-- the same day updates the row instead of duplicating it.
CREATE TABLE IF NOT EXISTS capsule_pnl_daily (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  capsule_id          TEXT NOT NULL,                       -- capsules.id
  pnl_date            TEXT NOT NULL,                       -- YYYY-MM-DD (UTC)
  daily_pnl_usd       REAL NOT NULL,                       -- snapshot of capsules.daily_pnl_usd at end of UTC day
  trades_count        INTEGER NOT NULL DEFAULT 0,          -- trades_today at snapshot time
  ending_equity_usd   REAL,                                -- capsules.capital_available_usd + open_position_cost_usd
  drawdown_usd        REAL,                                -- max drawdown observed within the day, if known
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(capsule_id, pnl_date)
);
CREATE INDEX IF NOT EXISTS idx_capsule_pnl_daily_date ON capsule_pnl_daily(pnl_date);
CREATE INDEX IF NOT EXISTS idx_capsule_pnl_daily_capsule ON capsule_pnl_daily(capsule_id, pnl_date);

-- Capsule pair correlation snapshots. One row per (capsule_a, capsule_b,
-- snapshot_date). The worker computes pair stats from capsule_pnl_daily
-- and writes the snapshot daily. Older rows kept for trend analysis.
--
-- Verdict thresholds (from PRD §4.2 + §4.6):
--   pnl_corr > 0.55 AND asset_overlap > 0.7  → 'too_similar'
--   pnl_corr > 0.55 OR  asset_overlap > 0.7  → 'correlated_safe'
--   otherwise                                → 'diversified'
--
-- low_confidence=1 when sample_days < 7 — global risk governor does not
-- veto on low-confidence correlations.
CREATE TABLE IF NOT EXISTS capsule_correlations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date         TEXT NOT NULL,                     -- YYYY-MM-DD when snapshot was taken
  capsule_a             TEXT NOT NULL,
  capsule_b             TEXT NOT NULL,
  pnl_corr              REAL,                              -- Pearson over last N daily-PnL points (NULL when stdev=0)
  asset_overlap         REAL NOT NULL DEFAULT 0,           -- Jaccard of allowed_assets, 0..1
  strategy_family_match INTEGER NOT NULL DEFAULT 0,        -- 0/1
  loss_overlap          REAL NOT NULL DEFAULT 0,           -- fraction of days where BOTH had negative pnl
  drawdown_overlap      REAL NOT NULL DEFAULT 0,           -- v1 = same as loss_overlap; v2 will use intra-day drawdowns
  sample_days           INTEGER NOT NULL,
  verdict               TEXT NOT NULL,                     -- 'diversified' | 'correlated_safe' | 'too_similar'
  low_confidence        INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_capsule_correlations_snapshot ON capsule_correlations(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_capsule_correlations_pair ON capsule_correlations(capsule_a, capsule_b, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_capsule_correlations_verdict ON capsule_correlations(verdict, snapshot_date);

-- Gated decision system audit log (PRD: docs/prd/gated-decision-system-2026-05-27.md).
-- One row per proposed trade — whether approved, reduced, watchlist-only,
-- rejected, or killswitched. Lets the operator answer "why didn't we trade X?"
-- from the /decisions UI and feeds post-trade learning.
--
-- gate_results_json schema (array of GateResult, matching src/lib/decision/types.ts):
--   [{ gate, status, score, action, reason, details? }, ...]
CREATE TABLE IF NOT EXISTS decision_journal (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                  TEXT NOT NULL,                       -- ISO timestamp the decision was finalized
  agent_id            INTEGER,                             -- paper_agents.id (nullable: pre-versioning trades)
  capsule_id          TEXT,                                -- capsules.id
  strategy_version_id INTEGER,                             -- strategy_versions.id (nullable)
  strategy_kind       TEXT NOT NULL,                       -- genome kind ("poly_short_binary_directional", etc.)
  venue               TEXT NOT NULL,
  symbol              TEXT NOT NULL,                       -- market identifier within venue
  side                TEXT NOT NULL,                       -- BUY | SELL
  condition_id        TEXT,                                -- polymarket conditionId / coinbase product
  proposed_size_usd   REAL NOT NULL,                       -- size before approval multiplier
  approved_size_usd   REAL NOT NULL,                       -- = proposed × size_multiplier (0 if rejected)
  proposed_price      REAL NOT NULL,
  decision            TEXT NOT NULL,                       -- APPROVED_FULL | APPROVED_REDUCED | WATCHLIST | REJECTED | KILL_SWITCH
  approval_score      REAL NOT NULL,                       -- 0..1 weighted aggregate
  size_multiplier     REAL NOT NULL,                       -- 0..1
  proposal_json       TEXT NOT NULL,                       -- full DecisionContext.proposal serialized
  snapshot_json       TEXT,                                -- optional DecisionContext.snapshot serialized
  gate_results_json   TEXT NOT NULL,                       -- array of GateResult
  order_id            TEXT,                                -- populated post-submit (NULL if not submitted)
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_decision_journal_ts ON decision_journal(ts);
CREATE INDEX IF NOT EXISTS idx_decision_journal_capsule ON decision_journal(capsule_id, ts);
CREATE INDEX IF NOT EXISTS idx_decision_journal_decision ON decision_journal(decision, ts);
CREATE INDEX IF NOT EXISTS idx_decision_journal_strategy_kind ON decision_journal(strategy_kind, ts);

-- Oracle/spot agreement + Chainlink update-age snapshots (PRD-04 #1/#2).
-- Captured on the snapshot cadence by src/lib/oracle/capture.ts so the
-- oracle-agreement and Chainlink-staleness strategies become measurable.
CREATE TABLE IF NOT EXISTS oracle_snapshots (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  asset                 TEXT NOT NULL,
  captured_at           INTEGER NOT NULL,             -- unix seconds
  coinbase              REAL,
  okx                   REAL,
  coindesk              REAL,
  chainlink             REAL,
  agreement_score       REAL,                          -- 0..1 across the resolvable sources
  side_agree            INTEGER,                       -- 1 = all sources same side of price_to_beat
  n_sources             INTEGER,                       -- how many sources resolved
  chainlink_update_age  REAL,                          -- seconds since the feed last published
  chainlink_zone        TEXT,                          -- fresh | aging | stale
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_oracle_snapshots_asset_ts ON oracle_snapshots(asset, captured_at);

-- Signal intake journal (2dollar-bot golden signals → HFT-work execution bridge).
-- Every received signal is recorded (shadow record); `routed` flags whether it was
-- forwarded to submitSingleSideMarket (only when SIGNAL_INTAKE_ENABLED=1).
CREATE TABLE IF NOT EXISTS signal_intake (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at   INTEGER NOT NULL,
  source        TEXT,
  asset         TEXT,
  recurrence    TEXT,
  side          TEXT,
  size_usd      REAL,
  entry_price   REAL,
  est_win_prob  REAL,
  readiness_ok  INTEGER,
  accepted      INTEGER,
  reason        TEXT,
  routed        INTEGER NOT NULL DEFAULT 0,
  verdict_json  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signal_intake_ts ON signal_intake(received_at);
