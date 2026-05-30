# Changelog

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com).
Versions follow [SemVer](https://semver.org).

## [Unreleased]

### Added — Scale layer: trader-llm agent + strategy factory + capital allocator

- **`src/lib/agents/trader-llm.ts`** — an LLM Evaluator that can ACT: given its capsule + the
  current signals it asks Claude (OAuth-first, cached, JSON-schema, like `oracle-llm`) for one
  trade decision and returns a `submit-order` verdict. Never touches a venue directly — the intent
  flows through `ExecutionRouter` (halt → capsule → risk gate). Inert until registered in the
  research-loop dispatch. Driven by `prompts/llm-trader-persona.v1.md`.
- **`scripts/strategy-factory.ts`** (`npm run strategy:factory`) — parameter-grid generator over the
  6 strategy families; the default grids fan out to **106,656** distinct specs. Dry-run by default;
  `--seed [--limit N]` seeds a bounded sample as `strategy_versions` at `stage='sim'`.
- **`src/lib/arena/allocator.ts`** + **`scripts/arena-allocate.ts`** (`npm run arena:allocate`) — the
  capital allocator ("which agents get a capsule and why"): pure, fitness-weighted, concentration-
  capped sizing over the arena leaderboard, with a written rationale per agent. Dry-run by default;
  `--commit` appends a `capital-allocation` audit event to `evolution_log`. Unit-tested
  (`tests/unit/allocator.test.ts`, 3/3).
- Verified: `npx tsc --noEmit` clean, `npm run build` green, allocator tests pass, factory + allocator
  run end-to-end on real DB rows.

### Added — Agentic-trading blueprint + Python sim-lab reference

- **Video intelligence** (`docs/blueprint/`) — 4 "All About AI" agentic-trading videos
  reverse-engineered with OpenAI gpt-4o-mini vision (frame OCR) + gpt-4.1 synthesis. Per-video
  `PROMPTS.md` (verbatim agent prompts, architecture, risk controls) + unified `BLUEPRINT.md`
  (the LLM-as-trader pattern, the intent / single-execution-gate framework, the persona/risk system).
- **`prompts/llm-trader-persona.v1.md`** — versioned trader-agent system prompt distilled from the
  videos; seed for a planned `trader-llm` Evaluator that emits risk-gated `submit-order` intents.
- **`docs/blueprint/INTEGRATION.md`** — maps the blueprint onto existing capsules/router/risk/stages
  and lays out the scale plan: `trader-llm` agent, `strategy-factory` (→10^5 variants via param grids),
  and an `allocator` ("which agents get a capsule and why", logged to `evolution_log`).
- **`research/sim-lab/`** — self-contained Python reference implementation of the full loop on REAL
  market data (Coinbase/Hyperliquid): OpenAI LLM-trader → capsule → single risk gate → sim perp broker
  → risk-adjusted scoring → multi-window promotion verdict → treasury ledger. Unit-tested broker math
  (5/5). De-risks the TS port. Measured: single LLM scalper ≈ break-even (BTC +1.0%, ETH +0.82% on 5m).

### Added — Packaging pass (port of TradingBot patterns)

- **Venue abstraction** (`src/lib/venue/`)
  - `VenueAdapter` interface, `ExecutionRouter` with idempotent submit + halt gate + capsule gate + risk gate.
  - `PolymarketAdapter` and `CoinbaseAdapter` wrap the existing `executeSingleMarketArb` / `executeCoinbaseMarket` paths so per-venue safety envs (`ALLOW_TRADE`, `COINBASE_ALLOW_TRADE`) still apply on top of the router gates.
  - Append-only hash-chained `order_events` table (`appendOrderEvent`, `verifyChain`).
- **Centralized risk engine** (`src/lib/risk/`)
  - `RiskEngine.check()` with notional, daily-loss, order-rate, position-notional, max-open-positions, and concentration gates.
  - `KillSwitch.haltAll()` halts every registered adapter at once; `resume()` clears the halt and re-rolls the day-PNL tracker.
  - Env-driven `RISK_*` knobs in `src/lib/risk/limits.ts`.
- **Capsules** (`src/lib/capsules/`)
  - Per-agent risk envelope: `max_position_pct`, `max_daily_loss_usd`, `max_open_positions`, `max_trades_per_day`, `min_seconds_between_trades`.
  - DB-backed store + pure `checkOrder()` gate.
  - REST: `GET/POST /api/capsules`, `GET/PATCH/DELETE /api/capsules/[id]`.
- **Release stages** (`src/lib/stages/`)
  - `sim → paper → live_eligible → live` ladder on `strategy_versions.stage`.
  - `setVersionStage()` enforces the promotion ladder (or `force=true`); logs to `evolution_log`.
  - REST: `POST /api/strategies/[id]/stage`.
- **Reconciler** (`src/lib/reconcile/`)
  - Pure `diffOrders()` function (testable without venues).
  - `reconcileCoinbase()` diffs `coinbase_orders` against venue truth and writes `reconcile_drift` events to `order_events`.
  - `npm run worker:reconcile` runs a one-shot pass.
- **Backtester** (`src/lib/backtest/`)
  - `runBacktest()` replays `market_snapshots` through a decision function and scores using the TradingBot arena formula: `pnl_pct − k × max_dd_pct`.
  - Example `thresholdMeanReversion()` decision fn included.
  - CLI: `npm run backtest -- --version <id> --token <token_id>`.
- **Deploy artifacts**
  - Multi-stage `Dockerfile` (Node 22, better-sqlite3 native build clean-room).
  - `docker-compose.yml` with `app`, `reconcile` sidecar, `research` sidecar — all sharing one SQLite volume.
  - `vercel.json` with per-route `maxDuration` and a `/api/venue/health` cron.
  - `CONTRIBUTING.md`, `DEPLOY_RUNBOOK.md`, this `CHANGELOG.md`.
- **DB schema**
  - New tables: `capsules`, `order_events`.
  - New column: `strategy_versions.stage` (default `sim`). Migration handled in `scripts/init-db.ts`.

### Changed

- `package.json` — new scripts: `worker:reconcile`, `backtest`, `docker:build|up|down|logs`.

### Notes

- Existing `executeSingleMarketArb` / `executeCoinbaseMarket` call sites continue to work unchanged. The router is an additional path, not a replacement; the per-venue safety gates remain the source of truth for per-venue caps.
- `RISK_*` envs are new and *add* a global layer on top of the per-venue caps. Default values are conservative (max_order_usd=$250, max_daily_loss=$200); see `src/lib/risk/limits.ts` for the full list.

## [0.1.0] — Initial commit

- Next.js 15 + SQLite control plane for Polymarket strategy design + research-loop evolution.
- Polymarket: typed CLOB/Gamma/Data clients, EIP-712/HMAC signing, LP-based combinatorial arb solver, on-chain (viem) wiring, executor with three-layer safety gates.
- Coinbase Advanced Trade: ES256 JWT auth, REST + WebSocket clients, execute with separate safety gates, cross-venue agent seed.
- 974 offline tests (unit + integration + contract) + 8 live E2E (opt-in via `RUN_E2E=1`).
- 47-endpoint Polymarket sweep + ~30-endpoint Coinbase sweep.
