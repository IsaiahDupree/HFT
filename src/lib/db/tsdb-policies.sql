-- TimescaleDB compression + retention policies for the warehouse hypertables.
-- Idempotent (replace_if_exists / if_not_exists); run with `npm run tsdb:policies`
-- (also invoked by tsdb:init). Compression keeps ALL history but shrinks old
-- chunks ~10-20×; retention drops only the truly-ephemeral sub-minute ticks.

-- Integer-time hypertables (start_unix / ts_unix are epoch-seconds bigints) need a
-- "now" function so the policy scheduler knows the current time in the partition
-- column's units. market_snapshots is timestamptz, so it needs none.
CREATE OR REPLACE FUNCTION unix_now() RETURNS bigint LANGUAGE sql STABLE
  AS $$ SELECT EXTRACT(epoch FROM now())::bigint $$;
SELECT set_integer_now_func('coinbase_candles', 'unix_now', replace_if_exists => true);
SELECT set_integer_now_func('realtime_ticks',  'unix_now', replace_if_exists => true);

-- Compression settings: segment by the series key, order by time DESC. The
-- segmentby+orderby columns cover each table's unique key (candles PK
-- product_id,granularity,start_unix; snapshots uq token_id,captured_at) so
-- uniqueness + ON CONFLICT on recent (uncompressed) chunks still works.
ALTER TABLE coinbase_candles SET (timescaledb.compress,
  timescaledb.compress_segmentby = 'product_id, granularity',
  timescaledb.compress_orderby = 'start_unix DESC');
ALTER TABLE realtime_ticks SET (timescaledb.compress,
  timescaledb.compress_segmentby = 'product_id',
  timescaledb.compress_orderby = 'ts_unix DESC');
ALTER TABLE market_snapshots SET (timescaledb.compress,
  timescaledb.compress_segmentby = 'token_id',
  timescaledb.compress_orderby = 'captured_at DESC');

-- Compression policies: compress chunks once they're old enough to be read-mostly.
SELECT add_compression_policy('coinbase_candles', compress_after => BIGINT '604800', if_not_exists => true);  -- 7 days
SELECT add_compression_policy('realtime_ticks',  compress_after => BIGINT '86400',  if_not_exists => true);   -- 1 day
SELECT add_compression_policy('market_snapshots', compress_after => INTERVAL '7 days', if_not_exists => true);

-- Retention: realtime_ticks are sub-minute ephemera (the SQLite side already
-- prunes to 24h). Drop chunks older than 30 days. NO retention on candles
-- (the deep backtest history since 2015 must be kept) or snapshots (research log).
SELECT add_retention_policy('realtime_ticks', drop_after => BIGINT '2592000', if_not_exists => true);  -- 30 days
