# HFT market-making for Polymarket — handbook → our system

Distilled from the zostaff "How to Build an HFT Bot for Polymarket" handbook (claims 0.3%/day ≈
9%/month from pure market-making + event-driven on binary CLOBs). Reference impl: `sources/hft-pm`
(the author published the **framework** but pulled the **alpha** — the calibration params). This is
the rigorous, citable version of the **market-making edge our own research already flagged as +EV**
(see `BLUEPRINT.md` / `INTEGRATION.md`).

## Why prediction markets are a different game
- **Bounded payoff**: every contract resolves to 0 or 1; price = probability; terminal variance is
  exactly `p(1-p)`. No GBM. Black-Scholes doesn't apply — **work in logit space** `x = ln(p/(1-p))`.
- **Thin, isolated books**: microstructure effects 10-100× equities; spreads wide; longshot premium
  near 0/1 from inventory risk (a position at p=0.02 is 50× leverage).
- Two tractable edges: **pure market-making** (earn the spread) and **event-driven** (react to news).
  Cross-venue arb is explicitly excluded as over-contested (closes in seconds).

## The core math (now in `src/lib/strategies/as-market-maker.ts`, 13/13 tests)
| Piece | What it gives | Our port |
|---|---|---|
| **Avellaneda-Stoikov** | reservation price `r = S − qγσ²(T−t)` + half-spread; inventory auto-skews quotes | `asQuotes` |
| **Logit-space reformulation** | AS valid on p∈(0,1); quotes widen near boundaries; soft-wall drift | `logitSpaceQuotes` (returns null past the boundary inventory cap) |
| **Microprice** (Stoikov) | imbalance-weighted fair value, martingale-by-construction | `microprice` |
| **VPIN** (binary-normalized) | adverse-selection toxicity gate — widen/withdraw when high | `vpinPM` |
| **Boundary inventory cap** | `|q| ≤ M·√(p(1-p))` — the longshot premium is a *position-size* constraint | inside `logitSpaceQuotes` |
| **Polymarket V2 fees** | taker fee peaks at p=0.5; **maker rebate by category — Finance pays 50%** | `takerFee` / `makerRebate` / `breakevenAlpha` / `effectiveHalfSpread` |
| **Kelly (binary)** | `f* = (q−c)/(1−c)`, fractional + boundary-capped; Bayesian shrink for posterior variance | `kellyFraction` / `positionSize` |

## What we wired into the live arena (now)
- **`polymarket_market_maker` is now fee-aware** (`src/lib/arena/sim.ts:decidePolyMarketMaker`): it
  **never quotes inside the round-trip taker fee** and **folds the maker rebate into its edge**, with
  a per-market `FeeCategory` mapped from `classifyMarket`. The handbook's single most directly-actionable
  edge: *trade where the rebates are richest* (Finance 50% > Sports/Politics 25% > Crypto 20%; Geopolitics
  is fee-free). If a market can't profit after fees, the MM now holds instead of bleeding.

## What's framework vs. alpha (be honest)
The handbook **withholds the numbers that matter**: `β_OFI`, the VPIN threshold, the κ/σ_b calibration,
the inventory-vs-signal skew weighting. Those are fit from *your own* captures and **must pass**:
- **delay-injection** (+100/500/2000ms — Sharpe must degrade smoothly, not collapse → look-ahead),
- **timestamp-shuffle** (Sharpe → 0),
- **regime-split** (V1 vs V2 cutover 28-Apr-2026 is a hard boundary — don't pool),
- **purged combinatorial CV → PBO < 0.3, Deflated Sharpe > 0.95**.
"A strategy that works in backtest but fails on +100ms delay injection is not 90% good — it is 0% good."

## The honest gap to a *faithful* MM
Our arena sim is **snapshot/bar-based** — no L2 order book, no queue position. A true AS maker needs
the handbook's **event-driven backtester with queue tracking + per-fill maker/taker accounting** (§10).
So today the library is used as (a) the **fee/rebate economics** the live MM respects, and (b) a
**tested foundation** for a proper L2 backtester. Next moves, in order of leverage:
1. **L2 order-book sim** (port §10 `Backtester`) so AS/logit/VPIN quoting can be *validated* with the
   delay-injection + CPCV suite before any capital.
2. **Live WS L2 feed** (`wss://ws-subscriptions-clob.polymarket.com/ws/market`) with reconnect +
   heartbeat watchdog + REST reconcile (§10.5) → real microprice/OFI/VPIN.
3. **Calibrate** β_OFI, κ, σ_b on our own V2 captures; gate go-live on PBO/DSR.
4. Route MM capital to the **Finance category** first (50% rebate) and `post_only=True` always.

Roadmap acceptance ladder (handbook §16): Data → Simulator → Naive MM → Signals → Events → Validation
→ Paper (2 weeks tracking) → Tiny live ($100, $10/market). Don't skip phases.
