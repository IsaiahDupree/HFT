# Capsules — per-agent risk envelopes

A capsule binds a chunk of capital to an agent (or strategy) and enforces
per-agent limits the global risk engine can't see. Borrowed from
TradingBot/Star Algorithm's `src/capsules/` pattern.

## Lifecycle

```
draft → paper / live ⇄ paused → stopped | closed
```

- **`draft`** — created but not active. Router rejects with `CAPSULE_NOT_ACTIVE`.
- **`paper`** — active for sim/paper venues.
- **`live`** — active for any venue including polymarket/coinbase.
- **`paused`** — operator pause. Router rejects.
- **`stopped`** / **`closed`** — terminal. Router rejects.

## Fields

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `capital_allocated_usd` | REAL | required | Bankroll bound to this capsule. |
| `capital_deployed_usd` | REAL | 0 | How much is in open positions. Updated by reconciler / router. |
| `capital_available_usd` | REAL | = allocated | Cash available. |
| `max_daily_loss_usd` | REAL | 0 (off) | Capsule auto-blocks new buys when `daily_pnl_usd <= -this`. |
| `max_total_drawdown_usd` | REAL | 0 (off) | Reserved — not yet wired. |
| `max_position_pct` | REAL | 0 (off) | Max single-position notional / `capital_allocated`. Only enforced on BUYs. |
| `max_open_positions` | INT | 0 (off) | Cap on `open_positions`. |
| `max_trades_per_day` | INT | 0 (off) | Cap on `trades_today`. |
| `allowed_venues` | JSON array | required | `['sim']`, `['polymarket']`, `['polymarket','coinbase']`, etc. |
| `allowed_symbols` | JSON array \| NULL | NULL = any | If set, every order must have `symbol` in this list. |
| `min_seconds_between_trades` | REAL | 0 (off) | Cooldown per `(symbol, side)`. |

## Realtime fields (updated externally)

- `current_pnl_usd` — cumulative cash flow since inception.
- `daily_pnl_usd` — realized PnL today (resets at UTC midnight). The `CAPSULE_DAILY_LOSS` gate fires when this drops below `-max_daily_loss_usd`.
- `open_positions` — count of symbols with non-zero position.
- `trades_today` — count of fills today.

The router writes fills into `order_events` but does **not** auto-update
these fields. A future fill-journal step (or the reconciler) should patch
them via `updateRealtime()`.

## Creating a capsule

```bash
curl -X POST http://localhost:3000/api/capsules \
  -H 'content-type: application/json' \
  -d '{
    "name": "Aurora Cross — paper",
    "agentId": 5,
    "capitalUsd": 500,
    "allowedVenues": ["sim"],
    "maxDailyLossUsd": 50,
    "maxPositionPct": 0.5,
    "maxOpenPositions": 5,
    "maxTradesPerDay": 100
  }'
```

Then activate:
```bash
curl -X PATCH http://localhost:3000/api/capsules/<id> \
  -H 'content-type: application/json' \
  -d '{"status": "paper"}'
```

## Wiring into a router submit

```ts
import { getDefaultRouter } from "@/lib/venue/router";

const router = getDefaultRouter();
const verdict = await router.submit({
  clientOrderId: crypto.randomUUID(),
  venue: "sim",
  symbol: "BTC-USD",
  side: "BUY",
  type: "MARKET",
  size: 1,
  refPrice: 100,
  capsuleId: "<the-capsule-uuid>",
  agentId: 5,
});
```

The capsule gate fires **after** the halt gate and **before** the global
risk engine. So `HALTED` always wins; capsule rejections always come before
`RISK_*` rejections.

## What capsules are NOT

- **Not a position tracker.** `capital_deployed_usd` and `open_positions`
  reflect what we've told the capsule, not what's actually on the venue.
  The reconciler closes that loop.
- **Not a global gate.** Orders without a `capsuleId` skip this layer
  entirely. Only the global RiskEngine catches those.
- **Not a daily P&L source of truth.** That's `evolution_log` summed by
  date. The capsule's `daily_pnl_usd` is a running mirror.

## Common patterns

| Goal | Capsule shape |
|------|---------------|
| **Sim-only strategy** | `allowed_venues=['sim']`, status `paper`. |
| **Paper-trade real venues** (rejects accidental live submits) | `allowed_venues=['sim']` even though strategy code targets `polymarket`. Router rejects with `CAPSULE_VENUE_NOT_ALLOWED`. |
| **Single-symbol focus** | `allowed_symbols=['BTC-USD']`. |
| **Rate-limited HF strategy** | `min_seconds_between_trades=60`, `max_trades_per_day=200`. |
| **Strict bankroll bound** | `max_position_pct=0.10` so no single position is >10% of allocated. |
