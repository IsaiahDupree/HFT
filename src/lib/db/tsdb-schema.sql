-- TimescaleDB warehouse schema — the canonical store for the heavy append-only
-- market time-series. Hypertables give concurrent multi-agent writes + fast
-- time-range scans. Run with `npm run tsdb:init` (idempotent).
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Coinbase OHLC candles (any granularity). PK includes the partition column
-- (start_unix) as TimescaleDB requires; ON CONFLICT makes ingestion idempotent.
CREATE TABLE IF NOT EXISTS coinbase_candles (
  product_id   text   NOT NULL,
  granularity  text   NOT NULL,
  start_unix   bigint NOT NULL,
  open         double precision NOT NULL,
  high         double precision NOT NULL,
  low          double precision NOT NULL,
  close        double precision NOT NULL,
  volume       double precision,
  captured_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, granularity, start_unix)
);
-- integer-time hypertable, ~90-day chunks (7776000 s). Idempotent via if_not_exists.
SELECT create_hypertable('coinbase_candles', 'start_unix',
  chunk_time_interval => 7776000, if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_cb_candles_prod_start
  ON coinbase_candles (product_id, granularity, start_unix DESC);

-- Realtime trade ticks from the live scanner (append-only log; dups allowed).
CREATE TABLE IF NOT EXISTS realtime_ticks (
  product_id text   NOT NULL,
  symbol     text   NOT NULL,
  price      double precision NOT NULL,
  source     text,
  ts_unix    bigint NOT NULL
);
SELECT create_hypertable('realtime_ticks', 'ts_unix',
  chunk_time_interval => 604800, if_not_exists => TRUE);  -- 7-day chunks
CREATE INDEX IF NOT EXISTS idx_rt_ticks_prod_ts
  ON realtime_ticks (product_id, ts_unix DESC);

-- Polymarket market snapshots from the snapshot worker (append-only).
CREATE TABLE IF NOT EXISTS market_snapshots (
  condition_id  text NOT NULL,
  token_id      text NOT NULL,
  question      text NOT NULL,
  yes_price     double precision,
  no_price      double precision,
  midpoint      double precision,
  spread        double precision,
  volume_24h    double precision,
  open_interest double precision,
  liquidity_usd double precision,
  category      text,
  captured_at   timestamptz NOT NULL DEFAULT now()
);
SELECT create_hypertable('market_snapshots', 'captured_at',
  chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_snap_token_time
  ON market_snapshots (token_id, captured_at DESC);
