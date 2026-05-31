# Data warehouse — TimescaleDB single source of truth

## Why
The DB path was `cwd/data/polymarket.db`, so the **dev checkout (HFT-work) and the runtime checkout
(~/hft-live) ran on two different SQLite files that silently diverged** — the daily history lived in one,
a fresh hourly pull in the other, and 979 candles existed in only one of them. SQLite under `~/Documents`
also hits macOS TCC (background daemons can't read it) and serializes writes (one writer at a time), which
caps the "hundreds of agents" goal.

**Fix:** a **TimescaleDB** (Postgres) container is the canonical store for the heavy append-only
time-series. Every process — both checkouts and every agent — connects over `localhost:5544`, so there is
ONE source of truth with concurrent multi-agent writes. The small transactional arena control-plane
(`paper_agents`/`capsules`/`paper_generations`) stays on SQLite for now.

```
┌─ Docker: hft-timescaledb (localhost:5544 → 5432) ─┐
│  hypertables:  coinbase_candles                   │  ← canonical, concurrent
│                realtime_ticks · market_snapshots  │
│  volume: hft-work_hft-pgdata                      │
└───────────────────────────────────────────────────┘
        ▲                 ▲                ▲
   HFT-work          ~/hft-live       N agents
   (backtests)       (live arena)     (future)
        └── arena control-plane stays SQLite (small, transactional)
```

## Bring it up
```bash
docker compose up -d timescaledb     # starts ONLY the DB (not the trading sidecars)
npm run tsdb:init                    # create hypertables (idempotent)
npm run tsdb:migrate                 # backfill candles from BOTH SQLite DBs, deduped
```
Connect string (default, no env needed for local dev):
`TSDB_URL=postgres://hft:${TSDB_PASSWORD:-hft_local_dev}@localhost:5544/hft`

## Schema (`src/lib/db/tsdb-schema.sql`)
- **coinbase_candles** — hypertable on `start_unix` (90-day chunks), PK `(product_id, granularity, start_unix)`.
  Idempotent ingest via `ON CONFLICT DO NOTHING`.
- **realtime_ticks** — hypertable on `ts_unix` (7-day chunks), append-only.
- **market_snapshots** — hypertable on `captured_at` (7-day chunks), append-only.

## Data-access (`src/lib/db/candle-store.ts`)
The ONE candle path: `getCandles(product, granularity)`, `listProducts(granularity)`,
`candleRange(...)`, `upsertCandles(...)` (batched, parameterized, idempotent), `tsdb()` pool, `closeTsdb()`.
The in-memory backtest engine/strategies/stats are untouched — only the load/store boundary became async.

**Repointed to the warehouse:** `ingest-history.ts`, `harden-priors.ts`, `backtest-history.ts`,
`validate-history.ts`. Verified lossless: the overfit battery reads from Timescale and reproduces the SQLite
numbers exactly (BTC daily PBO 0.00 / DSR 0.94; hourly+sized DSR 0.60 / turn× 0.80).

## Migration verified
| granularity | sqlite (union) | warehouse | missing |
|---|---|---|---|
| ONE_DAY | 29,297 | 29,297 | **0** |
| ONE_HOUR | 226,294 | 226,294 | **0** |
| ONE_MINUTE | 2,406 | 2,380 | 26 (live drift) |

DAILY + HOURLY (the backtest history) are 100% canonical. The `ONE_MINUTE` gap is the *running* live-capture
loop still appending to SQLite — a moving target, not data loss.

## Follow-ups
- Repoint the **live arena loop's** candle/tick/snapshot capture (worker-snapshot, capture-l2, realtime)
  to the warehouse so `ONE_MINUTE` + ticks + snapshots are canonical too (kills the last divergence).
- Consider migrating the arena control-plane to Postgres if write-concurrency becomes the bottleneck at
  hundreds of simultaneous agents.
- Add a Timescale **compression policy** + **retention** on the minute/tick hypertables once they grow.
