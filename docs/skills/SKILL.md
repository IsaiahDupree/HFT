# PolymarketAutomation skill — quick reference

A control plane for AI-driven Polymarket + Coinbase trading. Format borrowed
from [Polymarket/agent-skills](https://github.com/Polymarket/agent-skills):
this file loads first (~200 lines, must-know only); per-topic deep dives load
on demand.

## What this app is

A Next.js 15 + SQLite control plane with two trading venues (Polymarket,
Coinbase) plus a sim venue. Every order flows through a 5-gate router so
neither LLM-suggested trades nor human mistakes can bypass safety.

## Mental model

```
strategy_version (stage: sim|paper|live)
        ↓
   Capsule (per-agent risk envelope)
        ↓
   ExecutionRouter ── 5 gates ──→ VenueAdapter (sim / polymarket / coinbase)
                                              ↓
                                  order_events (append-only, hash-chained)
```

## The 5 router gates (in order)

1. **Idempotency** — same `clientOrderId` never fires twice.
2. **Halt** — `RiskEngine.halted=true` (set by `KillSwitch.haltAll()`) rejects everything.
3. **Capsule** — if `order.capsuleId` set: allowed-venues, allowed-symbols, position pct, open positions, trades-per-day, cooldown, daily loss.
4. **Global risk** — notional cap, daily loss, order rate, position notional, max open positions, concentration, forbidden symbols.
5. **Adapter capabilities + submit** — short-circuits with `UNSUPPORTED` if the adapter doesn't implement the requested `order.type`.

Every gate decision writes a row to `order_events`. Verify the chain with `GET /api/venue/health`.

## When you're asked to...

| Task | Read |
|------|------|
| "Place a paper trade" | [venue-router.md](./venue-router.md), [capsules.md](./capsules.md) |
| "Halt trading" / "kill switch" | [safety-gates.md](./safety-gates.md) |
| "Why was this order rejected?" | [safety-gates.md](./safety-gates.md) — reject-code reference |
| "Promote this strategy to live" | [release-stages.md](./release-stages.md) |
| "Add a third venue" | [venue-router.md](./venue-router.md) — VenueAdapter pattern |
| "Cross-venue arb" | [cross-venue-arb.md](./cross-venue-arb.md) |
| "Run a backtest" | [backtesting.md](./backtesting.md) |
| "Deploy" / "Dockerize" | [../../DEPLOY_RUNBOOK.md](../../DEPLOY_RUNBOOK.md) |

## Environment knobs

**Per-venue safety (these still apply on top of the router gates):**

| Env | Default | Effect |
|-----|---------|--------|
| `ALLOW_TRADE` | unset | Set to `1` to allow live Polymarket orders. Otherwise DRY_RUN. |
| `MAX_TRADE_USD` | `25` | Per-Polymarket-trade cap. |
| `MAX_DAILY_USD` | `100` | Polymarket rolling 24h cap (from `evolution_log`). |
| `COINBASE_ALLOW_TRADE` | unset | **Separate** from Polymarket's — set to `1` to allow live Coinbase orders. |
| `COINBASE_MAX_TRADE_USD` | `25` | Per-Coinbase-trade cap. |
| `COINBASE_MAX_DAILY_USD` | `100` | Coinbase rolling 24h cap. |

**Global risk engine (`src/lib/risk/limits.ts`):**

| Env | Default | Effect |
|-----|---------|--------|
| `RISK_DISABLED` | unset | `1` = bypass all global checks (per-venue caps still apply). |
| `RISK_MAX_ORDER_USD` | `250` | Notional cap per submit. |
| `RISK_MAX_DAILY_LOSS_USD` | `200` | Trips `DAILY_LOSS` rejection. |
| `RISK_MAX_ORDERS_PER_MIN` | `60` | Rolling rate cap. |
| `RISK_MAX_CONCENTRATION_PCT` | `0.25` | Max position notional / equity. |
| `RISK_FORBIDDEN_SYMBOLS` | `""` | CSV blocklist. |

## Five operations you'll do most often

```bash
npm run test:paper           # end-to-end paper-mode proof (no creds needed)
npm run worker:reconcile     # diff venue truth vs local DB
npm run backtest -- --version <id> --token <token_id>
curl -X POST http://localhost:3000/api/risk/halt \
  -d '{"reason":"manual","mode":"liquidate"}'                 # kill switch
curl -X DELETE http://localhost:3000/api/risk/halt            # resume
```

## Do NOT

- Loosen `ALLOW_TRADE` / `COINBASE_ALLOW_TRADE` gates without explicit user say-so. Those exist because the project ran for weeks before live trading was authorized.
- Bypass the router for a "quick test" — there's no quick test. The router writes `order_events` so a bypass leaves a gap in the audit log.
- Add new venues without `capabilities` flags and a `cancelAll()` implementation. The kill switch depends on `cancelAll()` working on every registered adapter.
- Commit anything from `data/`, `.env.local`, or `coinbase_cloud_api_key.json`. See [../../SECURITY.md](../../SECURITY.md).

## File map

```
src/lib/
├── venue/         router + adapters + order_events
├── risk/          RiskEngine + KillSwitch + limits
├── capsules/      per-agent risk envelopes
├── stages/        sim → paper → live ladder
├── reconcile/     pure diffOrders() + venue-specific loops
└── backtest/      market_snapshot replay + arena scoring
```
