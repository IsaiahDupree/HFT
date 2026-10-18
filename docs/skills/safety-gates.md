# Safety gates — reject-code reference

The router runs 5 gates in order. Every gate rejection writes an
`order_events` row with the code in the `error` field. Use this file to
explain a rejection or design a strategy that won't trip them.

## The pipeline

```
submit(order)
  └─ 1. Idempotency check       → DUPLICATE_CLIENT_ORDER_ID
  └─ 2. Halt gate               → HALTED
  └─ 3. Capsule gate (optional) → CAPSULE_*
  └─ 4. Global RiskEngine.check → RISK_*
  └─ 5. Adapter dispatch        → NO_ADAPTER / ADAPTER_UNAVAILABLE / UNSUPPORTED / ADAPTER_ERROR
```

## Codes

### 1. Idempotency
- **`DUPLICATE_CLIENT_ORDER_ID`** — `order.clientOrderId` was already submitted in this router's lifetime. **Fix:** generate a fresh UUID per intent. Don't reuse.

### 2. Halt
- **`HALTED`** — The kill switch is engaged. `RiskEngine.halted=true`. **Fix:** Resume with `DELETE /api/risk/halt` once the underlying issue is understood. Resume also re-rolls the daily loss baseline so a `DAILY_LOSS`-triggered halt doesn't immediately re-trip.

### 3. Capsule
- **`CAPSULE_NOT_FOUND`** — `order.capsuleId` doesn't exist in the `capsules` table. **Fix:** Drop the capsuleId or create the capsule first.
- **`CAPSULE_NOT_ACTIVE`** — Capsule status is `draft`, `paused`, `stopped`, or `closed`. **Fix:** `PATCH /api/capsules/[id] { "status": "paper" }` or `"live"`.
- **`CAPSULE_VENUE_NOT_ALLOWED`** — `order.venue` isn't in capsule's `allowed_venues` list. **Fix:** Update the capsule or pick a different venue.
- **`CAPSULE_SYMBOL_NOT_ALLOWED`** — `order.symbol` isn't in capsule's `allowed_symbols` (null = any). **Fix:** Update the capsule's allowed_symbols.
- **`CAPSULE_MAX_OPEN_POSITIONS`** — `open_positions >= max_open_positions`. **Fix:** Close a position first or raise the cap.
- **`CAPSULE_MAX_TRADES_PER_DAY`** — `trades_today >= max_trades_per_day`. **Fix:** Wait for UTC midnight or raise the cap.
- **`CAPSULE_MAX_POSITION_PCT`** — adding `order.size * refPrice` would push deployed capital over `max_position_pct * capital_allocated`. **Fix:** Reduce order size or raise the pct. SELLs are always allowed past this gate (they reduce deployed capital).
- **`CAPSULE_COOLDOWN`** — last trade on `(capsule_id, symbol, side)` was less than `min_seconds_between_trades` ago. **Fix:** Wait, or set cooldown to 0.
- **`CAPSULE_DAILY_LOSS`** — `daily_pnl_usd <= -max_daily_loss_usd`. **Fix:** Wait for UTC midnight rollover or raise the cap.

### 4. Global risk engine
- **`RISK_HALTED`** — same as `HALTED` (the engine is the source of truth).
- **`RISK_INVALID_QTY`** — `order.size <= 0`.
- **`RISK_INVALID_PRICE`** — `order.refPrice <= 0`.
- **`RISK_FORBIDDEN_SYMBOL`** — symbol matches `RISK_FORBIDDEN_SYMBOLS` env list.
- **`RISK_ORDER_NOTIONAL`** — `size * refPrice > RISK_MAX_ORDER_USD`. **Fix:** Reduce order size or raise the env. Default $250.
- **`RISK_ORDER_RATE`** — more than `RISK_MAX_ORDERS_PER_MIN` orders approved in the last 60s. **Fix:** Slow down or raise the env. Default 60.
- **`RISK_DAILY_LOSS`** — `equity - day_start_equity <= -RISK_MAX_DAILY_LOSS_USD`. **Fix:** Acknowledge the loss + resume the kill switch (which also re-rolls the day). Default -$200.
- **`RISK_POSITION_NOTIONAL`** — projected position notional > `RISK_MAX_POSITION_USD`. Default $1000.
- **`RISK_MAX_POSITIONS`** — opening a new symbol would exceed `RISK_MAX_OPEN_POSITIONS`. Default 20.
- **`RISK_CONCENTRATION`** — projected position / equity > `RISK_MAX_CONCENTRATION_PCT`. Default 0.25.

### 5. Adapter dispatch
- **`NO_ADAPTER`** — no adapter registered for `order.venue`. **Fix:** check `router.registeredVenues()`.
- **`ADAPTER_UNAVAILABLE`** — adapter exists but `isAvailable()` returned false. Usually missing creds. **Fix:** Polymarket needs `POLYMARKET_PRIVATE_KEY`; Coinbase needs `COINBASE_CDP_KEY_NAME` / `COINBASE_CDP_KEY_FILE` / `COINBASE_CDP_PRIVATE_KEY`.
- **`UNSUPPORTED`** — adapter's `capabilities[order.type]` is false. **Fix:** Polymarket only supports `FOK_BASKET`; Coinbase only supports `MARKET`; SimAdapter supports all three.
- **`ADAPTER_ERROR`** — adapter threw or returned `kind: "rejected"`. The reason is propagated. **Fix:** read the venue-specific error in the order_events row.

## How to engage the kill switch

```bash
curl -X POST http://localhost:3000/api/risk/halt \
  -H 'content-type: application/json' \
  -d '{"reason":"deploying new strategy code","mode":"liquidate"}'
```

Modes:
- **`pause_new_only`** — set halt flag, take no broker action.
- **`close_and_pause`** — set halt flag + flatten positions only.
- **`liquidate`** (default) — set halt flag + cancel pending + flatten positions.

The kill switch calls `cancelAll()` on every registered adapter in parallel.
A single failed `cancelAll()` does NOT abort the halt — the flag is set
regardless so subsequent submits are still blocked.

## How to resume

```bash
curl -X DELETE http://localhost:3000/api/risk/halt
```

This:
1. Clears `RiskEngine.halted`.
2. Re-rolls the day-PnL baseline so a `DAILY_LOSS`-triggered halt doesn't
   immediately re-trip. **The daily-loss cap is unchanged** — future orders
   still gate against the new running window.
