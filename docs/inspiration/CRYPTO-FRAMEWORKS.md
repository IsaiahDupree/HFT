# Crypto trading frameworks worth studying

Verified live on 2026-05-25. Listed by **how much we'd port from them**, not
by star count.

## Already-ported patterns (TradingBot/Star Algorithm)

See [project_packaging.md memory](../../../../memory/project_packaging.md) and
`CHANGELOG.md` § "Packaging pass" — we've already pulled:
- `VenueAdapter` interface + `ExecutionRouter` (5-gate pipeline)
- Centralized `RiskEngine` + global `KillSwitch`
- `Capsule` per-agent risk envelopes
- `sim → paper → live_eligible → live → restricted` release ladder
- Hash-chained `order_events` audit log
- Pure `diffOrders()` reconciler
- Backtester with arena-formula scoring

The repos below would extend that foundation.

---

## [ccxt/ccxt](https://github.com/ccxt/ccxt) — 42.6k stars, 108+ exchanges

- JavaScript / TypeScript / Python / C# / PHP / Go.
- The reference adapter pattern. Every exchange returns the *same* normalized
  `Market`, `Ticker`, `OrderBook`, `Trade`, `Order` shapes regardless of how
  the underlying API expresses them.
- Pattern to borrow:
  - **Unified types live in the core, not in the adapter.** Our `UnifiedOrder` in `src/lib/venue/types.ts` is the same idea — but ccxt has it for *fetched* data too (positions, balances, fills, tickers), not just orders. If we add a third venue, mirror this.
  - **Capability flags** — `exchange.has = { 'fetchOHLCV': true, 'createOrder': true, ... }`. Lets the consumer ask "can I get candles here?" without try/except. We could add `capabilities: { fok: true, market: true, ws_user_channel: true }` to `VenueAdapter`.
- **Action:** when adding the third venue, refactor `VenueAdapter` to add a `capabilities` getter and one normalized `fetchPositions()` / `fetchBalances()` method.

## [freqtrade/freqtrade](https://github.com/freqtrade/freqtrade) — 50.8k stars, Python

- v2026.4 (April 30 2026). The largest open-source crypto bot.
- Patterns worth studying:
  - **Strategy as a class with named hooks** — `populate_indicators()`, `populate_entry_trend()`, `populate_exit_trend()`, `custom_stoploss()`, etc. Forces strategies into a consistent shape so the engine can hot-reload them.
  - **Hyperopt / strategy optimization** — sweeps hyperparameters via Bayesian search. Our `research-loop.ts` proposes versions; an `optimize` mode that sweeps `entry.threshold_pts` over a grid would be the freqtrade equivalent.
  - **dry-run mode as a first-class state** — equivalent to our `ALLOW_TRADE!=1` gate but stamped at the *bot* level instead of per-call. Our capsules + stages essentially do this — a `paper`-stage version with no capsule binding is a freqtrade dry-run.
- **Action:** if we add an optimizer pass to research-loop, pattern after freqtrade's hyperopt. Don't port the strategy-class shape — our evaluator function pattern is fine for now.

## [hummingbot/hummingbot](https://github.com/hummingbot/hummingbot) — 18.7k stars, Python

- v2.14.0 (April 2026). Apache 2.0. 140+ trading venues. $34B reported user volume.
- Patterns worth studying:
  - **Connector/Strategy/Controller separation** — connectors do venue I/O, strategies decide *what* to do, controllers orchestrate. Our `venue/` is connectors, `research-loop.ts` evaluators are strategies — we lack the controller layer that watches multiple strategies and arbitrates between them.
  - **Pure-MM (market making) strategy implementations** — pure_mm, cross_exchange_mm, perpetual_mm. Reference for if we add a market-making mode for liquid Polymarket markets.
  - **`paper_trade_exchange`** — a synthetic connector that runs strategies against live data without submitting. Maps cleanly to a future `SimAdapter` in our venue layer.
- **Action:** add a `SimAdapter` (no-op submit that just records the intended order to `order_events` with `venue=sim`). 30 min of work, gives us a true "paper" venue that the stages ladder can target.

## [jesse-ai/jesse](https://github.com/jesse-ai/jesse) — 7.9k stars

- JavaScript primary, Python secondary.
- The most polished **research → backtest → optimize → live** pipeline I've seen. Includes an AI assistant ("JesseGPT") for strategy iteration.
- Patterns:
  - **One file per strategy, with `should_long()` / `should_short()` / `go_long()` / etc.** — cleaner than freqtrade's populate_* hooks for binary venues like Polymarket.
  - **Built-in risk management at the strategy level**, not just at the engine. Each strategy declares its `risk_per_trade_percent`, `take_profit`, etc.
- **Action:** when extending evaluators in `research-loop.ts`, consider giving each evaluator its own `entry()` / `exit()` / `position_size()` methods instead of one big `evaluate()` callback.

## [nkaz001/hftbacktest](https://github.com/nkaz001/hftbacktest) — 4.1k stars

- Rust 75%, Python wrapper. v0.9.4 / py-v2.4.4 (Dec 2025).
- The *only* OSS backtester I'd trust for market-making decisions:
  - **Tick-by-tick simulation** with feed/order latencies.
  - **Queue position modeling** — at price P, you're behind N units of existing volume. Your limit order doesn't fill until your queue position is consumed.
  - **L2 + L3 order book replay** from Binance and Bybit.
- Our current backtester is mark-to-midpoint with no slippage. For Polymarket binary markets that's defensible (often 1-cent spread); for crypto cross-venue arb on Coinbase it's optimistic.
- **Action:** when our Coinbase strategies graduate from research → paper, add a fill-realism layer to the backtester that:
  1. Models latency as a fixed delay (e.g. 200ms) so a "buy at midpoint" decision actually fills against the orderbook 200ms later.
  2. Walks the visible bid/ask book instead of assuming midpoint fills.
  Port concept from `hftbacktest.backtest.exchange_models`, not the Rust code.

## [bmoscon/cryptofeed](https://github.com/bmoscon/cryptofeed) — 2.8k stars, Python

- 40+ exchanges. v2.4.1 (Feb 2025). Last release a year-and-some ago but stable.
- WebSocket data-feed handler that normalizes events across exchanges and dispatches to registered callbacks.
- Backend integrations for Redis, InfluxDB, MongoDB, Kafka.
- **Action:** if we ever spin up a price-snapshot writer that needs to ingest from many venues (e.g. cross-venue arb against multiple crypto exchanges), use cryptofeed's normalization layer as the reference. For now: overkill.

## [Drakkar-Software/OctoBot](https://github.com/Drakkar-Software/OctoBot) — 6k stars

- Python. v2.1.1 (Mar 30 2026). 15+ exchanges. AI/Grid/DCA/TradingView strategies.
- Web/mobile/Telegram UIs.
- Patterns:
  - **Strategy marketplace UI** — install/configure/swap strategies via the web UI. Our `/strategies` page is a viewer; OctoBot's is interactive.
  - **Telegram bot integration** for ops alerts.
- **Action:** if/when we want push notifications for kill-switch / DAILY_LOSS / arb-detection events, the Telegram bot module is a reference. For now stick with the audit log.

## [Superalgos/Superalgos](https://github.com/Superalgos/Superalgos) — 5.5k stars

- JavaScript. v1.6.1 (Nov 2 2024). Visual strategy designer + multi-server deployment.
- **Action:** likely not worth porting from. Visual strategy design is a different paradigm than our spec-as-JSON model and the project has been quiet for 18+ months.
