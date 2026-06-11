# evan-kolberg/prediction-market-backtesting — G3 enabler assessment

**Date:** 2026-06-11
**Clone:** `~/Documents/Software/quarantine/prediction-market-backtesting` (shallow, HEAD `c76e77a`, 2026-05-16; full history = 476 commits per the 2026-06-10 audit)
**Rules followed:** read-only review, nothing installed, nothing run, no keys.
**Context:** POLYMARKET-STACK-AUDIT.md §3 (ADOPT) and §5 G3 — "Backtest with evan-kolberg adapters on real Polymarket history."

## Verdict up front

**YES — we can get the timestamp-correct Polymarket L2 data we need, and the
baseline path is FREE.** The PMXT raw archive (public Cloudflare R2 buckets, no
auth) has hourly full-market Polymarket L2 order-book parquet from
**2026-02-21T16:00Z to now**, verified live by HEAD probes on 2026-06-11.
Telonex ($79/mo, free 5-download trial) extends that to ~3 years of tick
trades + full-depth book snapshots + on-chain fills and is the only vendor
path for deep history, but it is **optional** for G3: our maker thesis lives on
the BTC/ETH short-duration binaries, and the relevant market eras (hourly
Up/Down, the Apr-2026 5-min series, the relaunched Jun-2026 5/15-min series)
are all inside the free PMXT window.

## 0. Security review (done before everything else)

- **No install hooks anywhere.** There is no `package.json`, no top-level
  `setup.py`/`pyproject.toml`. Install is Makefile-driven:
  `uv pip install "nautilus_trader[polymarket,visualization]==1.226.0" …` —
  all deps from PyPI by version pin (nautilus_trader, bokeh, plotly, numpy,
  py-clob-client, duckdb, textual, optuna, python-dotenv, aiohttp, pytest, ruff).
- **Rust crates are clean:** `crates/core` (arrow-array + parquet only) and
  `crates/python` (pyo3) — **no `build.rs`**, maturin build backend only.
  Native build is opt-in (`make native-develop`); pure-Python fallback exists.
- **Keys:** `.env.example` contains only `TELONEX_API_KEY`. The only
  private-key reference in the codebase is the **Kalshi live adapter** config
  (`KALSHI_PRIVATE_KEY_PEM` env var, standard Kalshi API auth, unused by any
  backtest path). No wallet keys, no mnemonic handling, no exfil patterns
  (grepped for curl/wget/base64/eval/exec/subprocess/os.system/.ssh/.aws —
  hits are all benign: downloader retry logic, cache-clear guard).
- Sandbox/live runners place real-trading explicitly out of scope; `make
  sandbox` is Nautilus sandbox execution against live public feeds only.
- AGENTS.md culture is realism-obsessed ("do not paper over failures that make
  simulated results trustworthy") — same religion as our gauntlet.

**Classification stands: ADOPT.** Safe to keep in quarantine and read; an
eventual venv-isolated install would pull only pinned PyPI packages, but per
the rules nothing was installed in this pass.

## (a) How the historical-data adapters work, and what they cost

The repo is a NautilusTrader 1.226.0 extension. Everything replays as
**L2 market-by-price order-book deltas** (`OrderBookDeltas`) with real
`TradeTick`s interleaved purely as execution/fill evidence — exactly the
no-lookahead L2 discipline our gauntlet wants.

### Vendor 1 — PMXT (FREE archive; the G3 path)

- **What it is:** hourly raw Polymarket order-book archives, one parquet per
  UTC hour covering **every Polymarket market**, served from public R2:
  - `https://r2.pmxt.dev/polymarket_orderbook_YYYY-MM-DDTHH.parquet` (v1, older era)
  - `https://r2v2.pmxt.dev/polymarket_orderbook_YYYY-MM-DDTHH.parquet` (v2, current)
- **Verified live (HEAD probes, 2026-06-11):**
  | Hour | Bucket | Status | Size |
  |---|---|---|---|
  | 2026-02-21T16 (first hour) | r2 (v1) | 200 | 6 MB |
  | 2026-03-15T12 | r2 (v1) | 200 | 320 MB |
  | 2026-05-01T12 | r2v2 | 200 | 411 MB |
  | 2026-06-01T12 | r2v2 | 200 | 481 MB |
  | 2026-06-10T20 | r2v2 | 200 | 339 MB |
  (v1 404s after ~April; v2 covers the later era — the repo's downloader
  probes both and keeps the larger object.)
- **Cost: $0.** No API key, no auth header, no rate-limit ceremony observed.
  Budget the bandwidth/disk instead: ~0.3–0.7 GB/hour ⇒ ~8–16 GB/day of
  full-market raw; a month ≈ 300–500 GB → mirror to the My Passport drive,
  or filter-and-discard (their loader filters to market/token at parquet scan
  time, then caches the small slice in `~/.cache/nautilus_trader/pmxt`).
- **Schema (documented in `docs/data-vendors.md`):** two row formats —
  legacy (`market_id`/`update_type`/`data`-JSON) and fixed-column
  (`timestamp, market, event_type, asset_id, bids, asks, price, size, side`)
  with `book_snapshot` (full book) and `price_change` (incremental level
  update) events. Missing hour ⇒ loader resets book state and waits for the
  next snapshot (honest gap semantics, no interpolation).
- **Limits:** books only — **no trade prints in PMXT raw**. Trades come from
  Telonex (`onchain_fills` → `trades`) or, as final fallback, Polymarket's
  public trade API (which has a documented historical-offset ceiling).
- PMXT the company also sells a hosted Data API (free 25k credits/mo; $29.99
  Starter; $99.99 Pro; "CCXT for prediction markets" SDK is free/self-hosted)
  — **not needed** for the archive path; the R2 buckets are the product we want.

### Vendor 2 — Telonex (paid; deep history + trades + Binance alignment)

- **What it is:** Polymarket tick-history vendor (`api.telonex.io`), channels:
  `book_snapshot_full` (canonical full-depth book), `onchain_fills` (Polygon
  log fills — preferred execution ticks), `trades`, quotes, plus **Binance
  spot data** aligned to the same clock (their archived BTC-5m models train
  on Telonex Polymarket books + Telonex Binance parquet).
- **Cost (telonex.io, 2026-06-11):** Free trial $0 — limited markets, **5 file
  downloads**, API access. **Plus $79/mo — unlimited downloads + Binance data,
  daily updates.** Enterprise custom. Coverage claim: 100B+ points, 1M+
  markets, up to **3+ years**.
- **Adapter mechanics:** daily parquet per market/outcome/channel; API key via
  `TELONEX_API_KEY`; local Hive-partitioned mirror with a DuckDB manifest for
  crash-safe resumable bulk downloads (`make download-telonex-data`);
  materialized Nautilus delta/tick caches for warm replays.

### Vendor 3 — "native" Polymarket (free, metadata + shallow history)

Gamma + CLOB + public trade API loaders (`polymarket_native.py`) — market
metadata, fee schedules, and recent trades only. Not an L2 history source.

### Execution realism (why this engine clears our bar)

`docs/execution-modeling.md`: L2_MBP book replay with liquidity consumption;
**queue-position model** for resting limits (same-side displayed depth at
accept = queue ahead; trade prints decrement it; only excess fills us);
**maker rebates modeled** as negative commission using Polymarket's documented
fee-equivalent curve `C·feeRate·p·(1−p)` × 20% crypto share; taker fees from
Gamma `feeSchedule.rate`; configurable **static latency** (default 75ms base +
10/5/5ms insert/update/cancel); explicit honesty boundaries documented ($1
rebate payout threshold not modeled, LP rewards not credited, MBP ≠ MBO).
This is *more* fill-realistic than our current maker-fill model on the queue
dimension.

## (b) Can it feed OUR backtest gauntlet for BTC/ETH 5m/15m/hourly Up/Down?

**Yes — two distinct ways, and (importantly) the market series we need are in
the free window:**

- The repo's own public runners already target the series: 
  `backtests/polymarket_btc_5m_pair_arbitrage.py` replays slugs
  `btc-updown-5m-{unixts}` (windows on 2026-04-26) from **PMXT**, and
  `polymarket_btc_5m_late_favorite_taker_hold.py` likewise. So 5-min Up/Down
  history exists in the free archive at least for the April era, plus the
  relaunched 5/15-min series from 2026-06-10 forward is being archived hourly
  now (verified 2026-06-10T20 object exists). Hourly Up/Down and daily strikes
  are full-period.
- Slug discovery for our own scans: 5-min = `btc-updown-5m-<epoch>`; the
  repo's `live/btc_5m.py` builds rolling slug horizons we can mimic for
  eth/15m/hourly families via Gamma (we already do this in
  `leadlag-campaign.ts`).
- **Trades for fill evidence (free):** Polymarket public trade API (shallow)
  or our existing `backfill-wallet` eth_getLogs machinery pointed at the CTF
  exchange's OrderFilled events — we already own that code path; it replaces
  Telonex `onchain_fills` at $0.
- **Caveat for the gauntlet:** PMXT gives *books*, not Binance. Our Binance
  side (5yr/100sym on the passport) supplies the fair-value feed; timestamps
  are exchange-native on both sides, so the no-lookahead join is ours to get
  right (PMXT rows carry epoch timestamps; align on UTC, never on receipt).

## (c) Minimal integration path — port vs run-in-place

**Recommended: hybrid. Port the data acquisition (small), keep the engine as a
second-opinion run-in-place (later, venv-isolated, after the line-review we've
now done).**

1. **Port now (≈1–2 days, TypeScript, into HFT-work):** a `pmxt-mirror` +
   `pmxt-loader` pair.
   - Mirror: walk `polymarket_orderbook_YYYY-MM-DDTHH.parquet` newest-first
     across r2v2 then r2 (probe both, keep larger — copy their downloader's
     incremental skip-if-exists semantics), restricted to the hours we care
     about, onto the passport. Their reference impl:
     `scripts/_pmxt_raw_download.py` (filename regex line 18, format line 91).
   - Loader: DuckDB/parquet scan filtered to `market`/`asset_id`, decode
     `book_snapshot` + `price_change` into our L2 backtester's delta format
     (schema fully documented in `docs/data-vendors.md` §Required Parquet
     Columns — both legacy JSON-payload and fixed-column variants). Honor the
     missing-hour rule: reset book, ignore deltas until next snapshot.
   - Then the existing gauntlet (walk-forward → PBO → DSR → shuffle) and the
     existing maker-fill model run unchanged on real Polymarket L2 history.
     **This alone unblocks G3.**
2. **Adopt the queue-position idea** (port-by-reimplementation, not by
   dependency): same-side-depth-at-accept queue counter decremented by trade
   prints is a ~100-line upgrade to our maker-fill model and removes its
   biggest optimism.
3. **Run-in-place later (optional, second opinion):** venv-isolated
   `make install` in quarantine, write our binary-maker as a Nautilus strategy,
   and demand the two engines agree on the same windows. Cross-engine
   agreement is itself an anti-delusion control. Their
   `strategies/private/passive_pair_accumulation.py` is **literally the
   coinman2 merge-maker** (post-only bids both legs when fee-adjusted pair
   cost < $1, hold matched to resolution, flatten surplus) with chunked
   forward-validation runners in `backtests/private/telonex_btc_5m_*` — read
   those before writing our G3 configs; they've already stepped on the rakes.
4. **Telonex $79/mo:** defer until/unless G3 on free PMXT-era data passes and
   we want (i) pre-Feb-2026 history, (ii) vendor on-chain fills instead of our
   eth_getLogs, or (iii) their clock-aligned Binance set. One month, cancel
   after bulk download (their mirror tooling is built for exactly that).

## Costs summary

| Source | What | Cost | Coverage |
|---|---|---|---|
| PMXT R2 archive | hourly full-market L2 book parquet | **$0** (no key) | 2026-02-21 → now (verified) |
| Polymarket public APIs | Gamma metadata, fee schedules, shallow trades | $0 | live + shallow history |
| Our eth_getLogs backfill | on-chain fills (trade evidence) | $0 (RPC we already pay) | full chain history |
| Telonex Plus | tick trades, full books, onchain fills, Binance | $79/mo (trial: 5 files free) | ~3 years |
| PMXT hosted Data API | live/OHLCV API, not needed for G3 | $0–$99.99/mo | n/a |

## Bottom line for G3

Take the free path: mirror PMXT hours for the BTC/ETH Up/Down families
(Apr-2026 5-min era + Jun-2026 relaunch + hourly series), port the ~documented
parquet decode into our loader, replay through our gauntlet with the
queue-position upgrade, and hold Telonex in reserve. The G3 gate stops being
data-blocked **today**, at $0.
