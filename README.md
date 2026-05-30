# Polymarket Agents — local control plane

A local Next.js app for designing, running, and self-evolving AI-agent strategies
on Polymarket. Mirrors the full Polymarket docs offline, exercises every endpoint
end-to-end, and stores your agents' strategies, research, trades, and evolution
history in SQLite.

## What's in the box

```
PolyMarket/
├── docs/polymarket/          # 163 .md files — full Polymarket docs, mirrored
├── docs/test-results.json    # last endpoint-sweep results (45/47 passing)
├── scripts/
│   ├── fetch-docs.sh         # re-pull docs from docs.polymarket.com
│   ├── test-endpoints.ts     # smoke-test every endpoint we know about
│   ├── derive-clob-creds.ts  # one-shot: L1 → L2 credential derivation
│   ├── init-db.ts            # idempotent SQLite init
│   ├── seed-strategies.ts    # seed the 4 starter AI agents
│   └── research-loop.ts      # snapshot markets, evaluate strategies, propose new versions
├── src/
│   ├── app/                  # Next.js App Router pages + API routes
│   ├── lib/polymarket/       # typed HTTP client + EIP-712 / HMAC signing + executor
│   ├── lib/coinbase/         # typed REST + WS + JWT auth + executor
│   ├── lib/venue/            # unified VenueAdapter + ExecutionRouter + hash-chained order events
│   ├── lib/risk/             # RiskEngine + KillSwitch + env-driven limits
│   ├── lib/capsules/         # per-agent risk envelopes (store + pure gate)
│   ├── lib/stages/           # sim → paper → live_eligible → live promotion ladder
│   ├── lib/reconcile/        # pure diff() + per-venue reconcileX() loops
│   ├── lib/backtest/         # market_snapshots replay + arena-formula scoring
│   └── lib/db/               # SQLite schema + queries
├── Dockerfile, docker-compose.yml, vercel.json   # deploy artifacts
├── DEPLOY_RUNBOOK.md, CONTRIBUTING.md, CHANGELOG.md
├── data/polymarket.db        # local SQLite store (gitignored)
└── .env.local                # secrets (gitignored)
```

## Architecture at a glance

```
[ strategy_version (stage: sim|paper|live) ]
                │
                ▼
[ Capsule (per-agent risk envelope) ]
                │ binds capital + caps to
                ▼
[ ExecutionRouter ]  ← single submit() entry point
       │
       ├── 1. Idempotency (clientOrderId dedup)
       ├── 2. Halt gate (RiskEngine.halted, set by KillSwitch)
       ├── 3. Capsule gate (allowed venues/symbols, position pct, cooldown, daily loss)
       ├── 4. Global RiskEngine.check (notional, daily loss, rate, concentration)
       └── 5. VenueAdapter.submit
                │
                ├── PolymarketAdapter  →  executeSingleMarketArb (FOK basket)
                └── CoinbaseAdapter    →  executeCoinbaseMarket  (market IOC)
                                              │
                                              ▼
                              [ order_events (append-only hash-chained) ]
                                              ▲
                                              │ writes drift events on
                                              │
                                [ reconciler — diffs local DB vs venue truth ]
```

## Setup

```bash
npm install
cp .env.local.example .env.local       # then fill in the values
npm run derive:creds                   # derive CLOB L2 API key from your private key
npm run db:init && npm run db:seed     # build SQLite + seed 4 starter agents
npm run test:endpoints                 # 47-endpoint sweep — should show pass=45 fail=2 skip=4
npm run dev                            # http://localhost:3000
```

## What the harness validates

| Surface              | Pass | Notes |
|----------------------|------|-------|
| Gamma (public)       | 11/11 | events, markets, tags, series, comments, search, sports, profiles |
| Data API (public)    | 11/11 | positions, trades, activity, value, OI, market-positions, holders, leaderboard, live-volume |
| CLOB public          | 14/14 | health, markets, sampling, orderbook, price, midpoint, spread, last-trade, history, tick-size |
| CLOB authenticated   | 5/5   | api-keys, orders, trades, balance-allowance, notifications |
| Relayer              | 6/6   | relay-payload, deployed, transactions, list-keys |
| Destructive (opt-in) | skip  | POST /order, DELETE /order, DELETE /cancel-all, relayer /submit |

Pass `--destructive` to wire the destructive trading paths in; they additionally
require `ALLOW_TRADE=1` to actually submit anything.

## Agent model

```
agents → strategies → strategy_versions (parent_version_id, is_current)
                          ↳ trades (price, size, intent, status, pnl_usd)
                          ↳ performance_metrics (window, win_rate, sharpe, drawdown)
research_notes  (topic, body, confidence, tags, source_urls, optional agent/strategy/market)
evolution_log   (proposal | promotion | retirement | scoring — append-only)
market_snapshots (yes/no price, midpoint, spread — fuels backtesting + UI)
```

Each strategy has a chain of immutable `strategy_versions`. The research loop
**proposes** new versions (writes them with `is_current=0` and logs a `proposal`
event); promoting a version is a separate human/agent step that flips
`is_current` and records a `promotion` event.

## Running the evolution loop

```bash
npm run worker:research        # one-shot
```

Pair with the Claude Code `/loop` skill, a cron job, or your scheduler of choice
to run it on an interval. Each pass:

1. snapshots the top-N reward-eligible markets,
2. records midpoint + spread for back-testing,
3. evaluates every active strategy against the snapshot,
4. proposes a new version when the evaluator suggests an edge,
5. writes a synthesis research note.

Per-strategy evaluators live in `scripts/research-loop.ts:evaluators`. Each one
is small and tailored:

- **`fade-headline-spikes`** (Atlas Macro) — recalibrates `entry.threshold_pts`
  to the observed p90 of `|1d return|` across the candidate universe.
- **`breakout-rider`** (Ember Momentum) — recalibrates `entry.vol_multiple_min`
  from current realized-vol distribution.
- **`stale-quote-arb`** (Scribe Sports) — proposes `requires_websocket: true`
  + a `max_age_ms` exit, citing the NBA-arb paper's 3.6s median window.
- **`weekly-deep-dives`** (Oracle Research) — emits a `research_note` listing
  the top-5 |z-score| candidates rather than mutating a spec.

Each proposal writes its observation set into `strategy_versions.backtest_summary`
so the rationale is auditable. Swap any evaluator for a model-driven one to
upgrade.

## Pages

- `/`              — control plane: agent count, risk, OI, leaderboard, recent trades, evolution feed
- `/agents`        — every agent + their strategies
- `/agents/[slug]` — agent charter + each strategy's current spec
- `/strategies`    — all strategies across agents
- `/strategies/[agent]/[strategy]` — version history, **proposed versions awaiting promotion** (with promote/retire buttons), performance, all trades
- `/trades`        — local agent trades + on-chain trades for the signer
- `/markets`       — live sampling markets + upcoming events + search
- `/markets/condition/[id]` — full orderbook + top holders + price-history **sparkline** for one market
- `/markets/event/[id]`     — every market in an event
- `/live`          — real-time websocket stream (top-of-book) for top sampling markets
- `/research`      — every research note (seeded with 11 substantive prediction-market microstructure notes)
- `/evolution`     — append-only evolution timeline (proposals + promotions + retirements)
- `/coinbase`                       — Coinbase auth status, key permissions, accounts, open orders, 30d fees, BTC-USD spot
- `/coinbase/products`              — top SPOT products by 24h volume
- `/coinbase/products/[id]`         — orderbook + recent trades + best bid/ask + spread (bps)
- `/coinbase/orders`                — open / filled / cancelled orders + last 25 fills

## Internal API routes

- `GET  /api/agents`                                  — list agents
- `GET  /api/markets/sampling`                        — proxied sampling-markets
- `GET  /api/polymarket/sweep`                        — last endpoint-sweep result
- `GET  /api/research`                                — list research notes
- `POST /api/research`                                — create a note (zod-validated body)
- `POST /api/strategies/:id/promote` `{versionId}`    — flip is_current + log a `promotion` event
- `POST /api/strategies/:id/retire`                   — mark a strategy retired + log it
- `GET  /api/coinbase/sweep`                          — last Coinbase endpoint-sweep result
- `GET  /api/coinbase/accounts`                       — proxied list accounts (auth)
- `GET  /api/coinbase/products`                       — proxied list products (auth)
- `GET  /api/coinbase/products/[id]/book`             — orderbook (top 25)
- `GET  /api/coinbase/orders`                         — list orders (filter by `status=`)
- `POST /api/coinbase/orders`                         — submit a market order through `executeCoinbaseMarket()` (zod-validated, honors all safety gates)
- `POST /api/coinbase/kill-switch`                    — batch-cancel every open order (defensive; ignores `COINBASE_ALLOW_TRADE`)
- `POST /api/venue/submit`                            — unified submit through the router (zod-validated, runs all 5 gates)
- `GET  /api/venue/health`                            — per-adapter health + `order_events` chain verification
- `GET  /api/risk/halt`                               — current kill-switch state + RiskEngine limits/last rejection
- `POST /api/risk/halt` `{ reason, mode? }`           — engage kill switch across every registered venue
- `DELETE /api/risk/halt`                             — resume trading + re-roll the daily loss tracker
- `GET  /api/capsules`                                — list capsules (filter by status / agent_id)
- `POST /api/capsules`                                — create a capsule (zod-validated)
- `GET/PATCH/DELETE /api/capsules/[id]`               — read / update status & realtime stats / delete a capsule
- `POST /api/strategies/[id]/stage` `{ versionId, stage, force?, rationale? }` — advance a version's release stage

## Coinbase Advanced Trade integration

A sister-venue surface mirroring the Polymarket workspace patterns. Built end-to-end:

- **Auth** (`src/lib/coinbase/auth.ts`) — short-lived JWT bearer per request (ES256 PEM or EdDSA), `nbf`/`exp` 120s, `uri` claim formatted `METHOD host/path`. Key loaded from `coinbase_cloud_api_key.json` (gitignored) or `COINBASE_CDP_KEY_NAME` + `COINBASE_CDP_PRIVATE_KEY` env vars.
- **Client** (`src/lib/coinbase/client.ts`) — typed REST client for all `/api/v3/brokerage/*` surfaces: accounts, products, orders, fills, portfolios, convert, fees, payment methods, key permissions, CFM (futures), INTX (perps).
- **WebSocket** (`src/lib/coinbase/ws.ts`) — public + user channels (`ticker`, `level2`, `user`, `market_trades`, `candles`, `heartbeats`), fresh JWT per subscribe (no `uri` claim).
- **Execute** (`src/lib/coinbase/execute.ts`) — `executeCoinbaseMarket()` enforces three gates: `COINBASE_ALLOW_TRADE=1`, `COINBASE_MAX_TRADE_USD` per trade, `COINBASE_MAX_DAILY_USD` rolling 24h (summed from `evolution_log`). Plus `killSwitch()` to batch-cancel every open order.
- **Sweep** (`scripts/test-coinbase-endpoints.ts`) — exercises every endpoint we wrap; writes `docs/coinbase-test-results.json`. Destructive POSTs gated behind `--destructive`, real LIVE orders behind `--destructive --live` AND `COINBASE_ALLOW_TRADE=1` AND `COINBASE_SWEEP_MAX_USD>0`.
- **DB tables**: `coinbase_accounts`, `coinbase_orders`, `coinbase_fills`, `coinbase_snapshots`, `cross_venue_arbs` (links a Polymarket `condition_id` to a Coinbase `product_id` for paired pricing).
- **Cross-venue agent** (`scripts/seed-cross-venue.ts`) — seeds the **Aurora Cross** agent with two strategies (`btc-price-threshold-fade`, `eth-merge-narrative`) and example pairings.

```bash
npm run test:coinbase                       # read-only sweep (~30 endpoints)
npm run test:coinbase:destructive           # adds preview-order calls (still no funds move)
npm run test:coinbase:live                  # places real tiny orders — needs COINBASE_ALLOW_TRADE=1 + COINBASE_SWEEP_MAX_USD>0
npm run seed:coinbase                       # seed Aurora Cross agent + example pairings
```

## Operations: router, capsules, kill switch, backtester, reconciler

```bash
npm run worker:reconcile                    # diff coinbase_orders vs venue truth, append drift events
npm run backtest -- --version 12 --token <token_id>   # replay snapshots, score on pnl_pct − 2·max_dd_pct
```

Engage the kill switch (idempotent — safe to spam):

```bash
curl -X POST http://localhost:3000/api/risk/halt \
  -H 'content-type: application/json' \
  -d '{"reason":"manual halt","mode":"liquidate"}'
curl http://localhost:3000/api/risk/halt | jq        # state
curl -X DELETE http://localhost:3000/api/risk/halt   # resume
```

Risk-engine envs (all optional, conservative defaults):

| Env | Default | Effect |
|---|---|---|
| `RISK_DISABLED` | unset (engine on) | Set to `1` to bypass all global checks; per-venue caps still apply |
| `RISK_MAX_ORDER_USD` | `250` | Notional cap per submit |
| `RISK_MAX_POSITION_USD` | `1000` | Resulting position notional cap |
| `RISK_MAX_DAILY_LOSS_USD` | `200` | Trips DAILY_LOSS rejection AND can engage the kill switch |
| `RISK_MAX_OPEN_POSITIONS` | `20` | Max open positions across all venues |
| `RISK_MAX_ORDERS_PER_MIN` | `60` | Rolling per-minute order rate cap |
| `RISK_MAX_CONCENTRATION_PCT` | `0.25` | Max single-position notional / equity |
| `RISK_CONFIRM_ABOVE_USD` | `100` | Sets `requires_confirmation` flag on the verdict |
| `RISK_FORBIDDEN_SYMBOLS` | `""` | Comma-separated symbol blocklist |

## Deploying

Two supported modes; see [DEPLOY_RUNBOOK.md](./DEPLOY_RUNBOOK.md) for the full procedure.

```bash
npm run docker:up                           # docker compose up -d --build (preserves SQLite)
npm run docker:logs                         # tail the app container
npm run docker:down                         # stop everything
```

The `docker-compose.yml` runs three containers off one image: the Next.js
`app` on :3000, a `reconcile` sidecar (60s interval), and a `research`
sidecar (5 min interval), all sharing the SQLite volume.

For Vercel deploys you'll need to migrate `better-sqlite3` to Neon Postgres
(SQLite doesn't survive Vercel Functions' stateless containers).
See `DEPLOY_RUNBOOK.md §B`.

## Tests

```bash
npm run test:run            # full offline suite (~974 tests, ~4s)
npm run test:coverage       # with v8 coverage report
RUN_E2E=1 npm run test:e2e  # opt-in: hits live Gamma, Data, CLOB, Polygon RPC, Claude OAuth
```

| Suite | Files | Tests | Notes |
|---|---|---|---|
| Unit — signals/arb/lp/sign/onchain/auth/client + Coinbase auth/URLs | `tests/unit/*` | 840+ | Parameterized via `it.each` |
| Integration — schema, queries, executor safety, Coinbase execute gates | `tests/integration/*` | 70+ | In-memory SQLite per test |
| Contract — mocked Polymarket fetch responses | `tests/contract/*` | 50+ | Asserts URLs, headers, parsed shapes |
| E2E — live network (opt-in, `RUN_E2E=1`) | `tests/e2e/*` | 8 | One per major surface |

If a test fails in CI, it's a real regression — the suite is green locally and contains no flaky live calls by default.

## Security notes

- `.env.local` is gitignored. **Never commit your private key.**
- The CLOB L2 secret + passphrase are derived deterministically from your
  signer's private key (`derive:creds`). They can be rotated by passing a
  different `nonce` to `client.createApiKey`.
- The destructive trading paths in `scripts/test-endpoints.ts` are wired but
  **refuse to actually submit anything** without `--destructive` AND
  `ALLOW_TRADE=1` set — keep it that way until you're ready.
- Coinbase trading uses a **separate** opt-in (`COINBASE_ALLOW_TRADE=1`) so
  enabling Polymarket live trading doesn't silently arm Coinbase too. The
  Coinbase CDP key (`coinbase_cloud_api_key.json` at repo root) is gitignored;
  see `SECURITY.md` for the full list of credential locations.

## Hot-reload safety: trading keeps running during code changes

The arena worker chain (`worker:snapshot` → `arena:tick` → auto-evolve) is
**deliberately decoupled from the Next.js dev server**. Each invocation is a
separate `tsx scripts/*.ts` process triggered by Windows Task Scheduler (or
your scheduler of choice). That means:

- **Editing code while the arena is running is safe.** The next scheduled
  tick spawns a fresh Node process that imports the latest source. In-flight
  ticks finish on the old code; you never end up with a half-reloaded
  trading loop.
- **Restarting the Next.js dev server doesn't affect the arena.** The dev
  server hosts the UI + API routes only; the worker doesn't depend on it.
- **DB writes are crash-safe.** `better-sqlite3` runs in WAL mode (set in
  `src/lib/db/client.ts`); concurrent reads from the UI never block writes
  from the tick worker, and partial work always persists.
- **Live capsules survive dev restarts.** When the arena bridge routes an
  agent's signal through `ExecutionRouter`, the order is submitted through
  the venue adapter's HTTP/JWT path — no long-lived dev-server state is
  involved. Polymarket and Coinbase auth credentials are loaded per-process.

The one exception: if you change `src/lib/db/schema.sql` and add a new column
that older code doesn't know about, a tick running mid-migration could still
write old shapes. Land schema changes by running `npm run db:init` (idempotent
ALTERs) before the next tick fires.
