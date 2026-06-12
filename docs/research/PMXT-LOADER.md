# PMXT parquet → L2 loader (G3 data path)

**Date:** 2026-06-11
**Context:** docs/POLYMARKET-STACK-AUDIT.md §5 G3 (backtest on real Polymarket L2
history) + docs/research/EVAN-KOLBERG-BACKTESTER-ASSESS.md (archive schema/URLs).
This is the ported `pmxt-mirror` + `pmxt-loader` pair that doc recommended,
plus the queue-position maker-fill model it called "a ~100-line upgrade".

## Pieces

| File | What |
|---|---|
| `scripts/pmxt_fetch.py` | Mirror an hourly full-market parquet from the free R2 buckets (probe r2v2 then r2, keep larger; atomic, size-checked, skip-if-cached). |
| `scripts/pmxt_extract.py` | Filter one market/token out of the hour and reconstruct a chronological top-N book-update stream → JSONL (+ optional trade prints). |
| `src/lib/backtest/pmxt.ts` | TS consumer: load/stream the JSONL; bridge to `MarketEvent` (snapshot engine, maker-fill calibrator) and to `QueueEvent` (queue-fill model). |
| `src/lib/backtest/queue-fill.ts` | Queue-position maker-fill model (replaces the front-of-queue optimism of RAILS-REVIEW-2026-06-11 finding 4). |
| `tests/unit/queue-fill.test.ts` | 27 deterministic vitest tests. |

Cache dir: `/Volumes/My Passport/hft-data/pmxt/` when the passport is mounted,
else `data/pmxt/`. ~0.3–0.7 GB per hour — passport strongly preferred.

## Usage

```bash
# 1. Mirror an hour (UTC). $0, no auth.
npm run pmxt:fetch -- 2026-06-10T20

# 2. Which Up/Down markets ended inside that hour? (Gamma, closed=true)
npm run pmxt:extract -- --discover-updown 2026-06-10T20

# 3. Extract one market token to JSONL (slug → Gamma → conditionId + clobTokenIds)
npm run pmxt:extract -- --hour 2026-06-10T20 --slug btc-updown-5m-1781121900 \
    --top 5 --trades --out data/pmxt/btc-updown-5m-1781121900-up.jsonl
# (or --condition-id 0x... --token <asset_id> to skip Gamma; --outcome down for the Down token;
#  repeat --hour for multi-hour markets)
```

```ts
import { loadPmxtJsonl, toMarketEvents, toQueueEvents } from "@/lib/backtest/pmxt";
import { simulateQueueFills } from "@/lib/backtest/queue-fill";

const evs = loadPmxtJsonl("data/pmxt/btc-updown-5m-1781121900-up.jsonl"); // or streamPmxtJsonl()
const mkt = toMarketEvents(evs);            // → snapshot engine / calibrateMakerFillRate (ts seconds)
const quote = { side: "bid", price: 0.5, size: 25, postedTs: 1781121960000 } as const;
const r = simulateQueueFills(quote, toQueueEvents(evs, quote)); // honest queue-position fills (ts ms)
```

## Archive schema (v2 fixed-column, verified on 2026-06-10T20)

`https://r2v2.pmxt.dev/polymarket_orderbook_YYYY-MM-DDTHH.parquet` (v1 era at
`r2.pmxt.dev`, same filename). One file per UTC hour, EVERY Polymarket market.
The 2026-06-10T20 file: 339 MB, 49,639,680 rows, 41,248 distinct markets.

Columns: `timestamp_received`, `timestamp` (TIMESTAMPTZ — use `timestamp`,
exchange clock), `market` (BLOB = **condition id** 0x…, NOT the slug),
`event_type`, `asset_id` (CLOB token id; two per binary market — Gamma
`clobTokenIds`, Up/Yes first), `bids`/`asks` (JSON ladders of
`["price","size"]`), `price`/`size`/`side`, `best_bid`/`best_ask`,
`fee_rate_bps`, `transaction_hash`, `old_tick_size`/`new_tick_size`.

Event types in that hour:

| event_type | rows | meaning |
|---|---|---|
| `price_change` | 48,779,024 | one level update; `side` BUY=bid / SELL=ask; `size` is the **new absolute aggregate size** at `price` (0 removes the level) |
| `book` | 813,743 | full ladder snapshot — **resets state** (honest gap semantics: never interpolate across a reset) |
| `last_trade_price` | 46,639 | trade print; `side` = taker (aggressor) side. **The v2 archive DOES carry prints** — the assess doc's "books only" limit was v1-era. Still shallow vs on-chain fills; eth_getLogs backfill remains the deep trade source. |
| `tick_size_change` | 274 | venue tick change (`old_tick_size`→`new_tick_size`) |

Slug discovery: slugs are not in the parquet. Gamma `markets?slug=<slug>&closed=true`
(**`closed=true` is required** for resolved markets — the bare query returns `[]`),
or `--discover-updown` which pages `markets?closed=true&end_date_min/max=<hour>`.
June-relaunch slug families confirmed live: `btc-updown-5m-{epoch}`,
`btc-updown-15m-{epoch}`, `btc-updown-4h-{epoch}`, hourly
`bitcoin-up-or-down-june-10-2026-4pm-et`.

## JSONL output format

```
{"type":"book","ts":1781121551661,"bids":[[0.4,291.0]],"asks":[]}          ts = epoch ms UTC
{"type":"trade","ts":1781121612296,"price":0.5,"size":5.0,"aggressor":"BUY"}
```
Bids best-first (desc price), asks best-first (asc price), top-N (`--top`).
A `book` line is emitted after **every** snapshot/price_change → a full
book-update stream. One-sided books (pre-first-snapshot warmup,
post-resolution collapse) are kept in the JSONL; `toMarketEvents()` skips them.

## Queue-fill model (deliverable 2)

We join the **back** of the queue: queue ahead = visible size at our level at
post time; later size growth queues behind us; cancellations shrink the queue
pro-rata (`cancelMode: "behind"` = pessimistic bound, `"ahead"` = optimistic
bound — bracket any result that matters); prints at our level consume the
queue ahead first and only the excess fills us; prints through our price sweep
the level (full fill at our price). No-lookahead: nothing at-or-before
`postedTs` can fill us. Known boundary: MBP ≠ MBO, so true queue position is
unknowable — pro-rata is the standard neutral assumption, hence the brackets.

## Verification (real hour, end-to-end, 2026-06-11)

Hour `2026-06-10T20` (r2v2, 339,062,587 bytes) → market
`btc-updown-5m-1781121900` ("Bitcoin Up or Down - June 10, 4:05PM-4:10PM ET",
condition `0xd79e7c25…dc1a43d0`), Up token `618184…106933`:

- extract stats: **921 book snapshots + 73,331 price_changes → 74,252 book
  updates emitted**, 261 trade prints; stream spans
  **2026-06-10T19:59:11.661Z → 20:10:09.110Z**
- first book update: `{"bids":[[0.4,291.0]],"asks":[]}` (pre-snapshot warmup)
- last book update: `{"bids":[],"asks":[[0.01,913190.23],[0.02,3653.4],…]}`
  (resolved Down — Up book collapsed, as expected)
- TS consumer: 74,513 events loaded; 69,964 two-sided `MarketEvent`s
- queue-fill on the real tape: bid 25 @ 0.50 posted 20:06:00Z with **125.1
  visible ahead** → first fill **20:07:38.261Z** (98 s queue wait, filled by a
  sweep through the level — adverse selection visible, exactly the honesty the
  old front-of-queue model lacked)
- `npx vitest run tests/unit/queue-fill.test.ts` → **27/27 pass**

## Deps

None added to package.json (the parquet work is Python). Python side: only
**duckdb** (1.5.3, already installed for python3.14) for the parquet scan;
stdlib `urllib` for transfers. `pyarrow` is not required.
