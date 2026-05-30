# Basis & Funding Trading

> **Family:** 7 — Basis & funding trading
> **Variants covered:** Perp-spot cash-and-carry · Cross-exchange funding spread · Futures-spot calendar roll · Borrow-lend rate arbitrage
> **Repo modules:** `src/lib/hft/basis.ts` (math primitive — `computeBasis`); the engine wrapping it is the missing piece this doc specifies.
> **Cross-asset coverage:** crypto spot (Coinbase, Binance) · crypto perps (dYdX, Hyperliquid, Paradex, Binance USDM) · crypto futures (CME BTC/ETH, OKX/Binance quarterly) · borrow markets (Aave, Compound, CEX margin)

---

## 1. TL;DR

Two prices for "the same thing" should converge. The basis trade
captures the convergence. The funding trade captures the *funding
payments* that *force* the convergence on perpetual futures.

The three retail-accessible variants:

1. **Perp-spot cash-and-carry.** Long spot + short perp (or vice versa); the perp's funding-rate mechanism pays the spread between perp and spot to one side. Delta-neutral on paper.
2. **Cross-exchange funding spread.** Two venues with different funding rates on the same perp → long the low-funding venue, short the high. Earn the funding *spread*, not the absolute rate.
3. **Futures-spot calendar roll.** Long dated future + short spot (or short future + long spot). The basis converges as the future approaches expiry. Industry-standard for TradFi; mostly institutional in crypto (CME).

Less common but tradeable for the systematic operator:

4. **Borrow-lend rate arbitrage.** Aave borrow rate < CEX margin rate (or vice versa) → borrow on the cheap side, lend on the dear side. Tiny edges (10-50 bps APR) but very low risk.

**The lethal misperception.** Cash-and-carry is *called* "delta-neutral"
and "low-risk arbitrage." It is neither in practice. A BIS 2023 working
paper[^bis2023] showed that **even at 10× leverage — far below what
exchanges allow — the futures leg would have been liquidated in over
half the months sampled.** The basis trade routinely blows up during
deleveraging events; March 2024's $2.8B and December 2024's Hyperliquid
flash crash[^hyperliquid_dec2024] are the most recent examples.

The "edge" is real (5-40% APR in normal regimes), but the *risk-adjusted*
edge is much smaller than the gross APR suggests once you honestly model
liquidation risk and funding-rate sign flips.

---

## 2. Mechanism

### 2.1 Perp-spot cash-and-carry (the canonical retail trade)

Perpetual futures have no expiry. To keep their price close to spot, a
*funding rate* is periodically exchanged between longs and shorts:

```
funding_payment_per_window = position_notional × funding_rate
```

Funding rate is positive (longs pay shorts) when perp > spot (contango).
Negative (shorts pay longs) when perp < spot (backwardation). The funding
mechanism is the *force* that closes the basis.

**The trade in two lines:**
- `basis = perp − spot > 0` AND `funding > 0` → **short the perp, long the spot.** Collect funding payments from longs.
- `basis < 0` AND `funding < 0` → **long the perp, short the spot.** Collect funding payments from shorts.

**Why it's allegedly delta-neutral.** Spot leg = exposure +1; perp leg =
exposure ±1 (matched). Net delta = 0. Spot price moves don't change PnL
because long and short cancel. You earn only the funding rate, paid each
window (1h on dYdX, 8h on Binance, etc.).

**Why "delta-neutral" lies in practice.** Several failure modes:

- **Asymmetric leverage.** The perp leg uses leverage (often 3-10×); the spot leg uses 1× cash. A 5% move down liquidates the perp's short with 10× leverage well before any spot stop. You're left with naked long spot at the bottom.
- **Different liquidation engines.** Spot has no liquidation; perp does. When perp gets liquidated, the spot leg is no longer hedged.
- **Funding rate flips.** The funding-rate sign you sized for may flip mid-trade. You enter expecting to *collect* funding; the rate goes negative; you're now *paying* funding. If you stay in, you pay; if you exit, you eat the closing spread on both legs.
- **Exchange counterparty risk.** Spot at Coinbase, perp at Binance — if either has a withdrawal freeze (FTX, etc.), the hedge breaks.
- **Liquidation cascades.** A March 2024 cascade liquidated $2.8B in 24h.[^march2024_cascade] If your perp is in that batch, your "delta-neutral" trade has become a one-legged spot long at the bottom.

### 2.2 The funding-rate mechanics per venue

Funding rates are computed differently per venue. The same gross basis
implies different optimal trades depending on venue mechanics:

| Venue | Funding interval | Funding-rate formula | Notes |
|---|---|---|---|
| dYdX v4 | 1h (block-by-block, but settles hourly) | premium component + interest rate | Most predictable; dynamic but smooth |
| Binance USDM | 8h | (premium index) + (clamped interest rate) | Caps at ±0.75% per 8h → 3× per day max |
| Hyperliquid | 1h | similar to dYdX, premium + interest | Deep books; tight basis converges fast |
| Paradex | 1h | mark-based premium + flat interest | Lower volume; sometimes wider basis |
| OKX USDT-M | 8h | premium index + interest | Similar to Binance |
| Bybit | 8h | premium index + interest | Similar to Binance |

**Key insight:** at the same gross basis, **hourly venues (dYdX,
Hyperliquid) close the basis faster** because the funding mechanism
applies more often. A 30 bp basis on dYdX is usually closed within
4-8h; the same on Binance can persist 24+ hours through multiple
funding windows.

**Implication for the trade:** hourly-funding venues are the *better*
side of a cross-exchange spread trade if you're shorting (you want
basis to close fast so you can reset); 8h-funding venues are the better
side if you're aiming for stable carry.

### 2.3 Cross-exchange funding spread

Two perps for the same underlying on different venues quote different
funding rates. The trade:

- **Short** the high-funding venue (collect funding from longs there).
- **Long** the low-funding venue (pay less funding to shorts there).

Net = the *spread* between the two funding rates, paid each period.
Delta-neutral *if* the two perps' prices stay tracking (they should —
both are pegged to the same spot underlying).

**Numerical example (real, March 2025):**
- dYdX ETH-PERP funding: +30 bps/8h-equivalent
- Hyperliquid ETH-PERP funding: +10 bps/8h-equivalent
- Spread: 20 bps/8h × 3 windows/day × 365 = **219% gross APR**

Real after fees (10 bps maker round-trip per side, twice a day rebalance):
~150% APR. Real after liquidation insurance buffer and funding-rate
mean reversion: realistic 30-60% APR sustained.

**Why does the spread exist?** Different venues have different user
bases:
- Retail-heavy venues (Binance, Bybit) tend toward high funding during retail bull-FOMO.
- Institutional-heavy venues (CME, more recently Paradex) have less directional retail flow → tighter funding.
- New venues (Hyperliquid, dYdX v4) attract sophisticated LPs first → tighter funding earlier in their lifecycle.

The spread persists *because* arb capital is finite, on-/off-ramps are
slow, and the trade has real liquidation risk.

### 2.4 Futures-spot calendar roll

A dated futures contract (e.g. CME BTC December future) trades at a
*forward premium* to spot:

```
F(t, T) = S(t) × exp((r − q) × (T − t))
```

where `r` is the risk-free rate, `q` is the "convenience yield" (often
negative for crypto = "storage cost"), and `T − t` is time to expiry.

**The trade:** if `F − S > theoretical_basis + fees + funding_cost`,
short the future + long the spot. As `t → T`, the basis converges to
zero (since `F(T, T) = S(T)`). Capture the gross basis decay.

**In crypto:**
- CME BTC and ETH quarterly contracts trade at 2-15% annualized basis to spot, depending on regime.
- OKX, Binance, Deribit offer quarterly futures with similar dynamics.
- A 10% annualized basis on a 3-month contract = ~2.5% gross profit if held to expiry.

**Why retail rarely runs it:** requires futures account (CME) or large
capital to deploy on quarterly contracts (often $10k+ per contract).
Also, **basis can widen mid-trade** during stress; the trade requires
the operator to hold through drawdown.

### 2.5 Borrow-lend rate arbitrage

Crypto lending markets (Aave, Compound, CEX margin) quote different
borrow/lend rates for the same underlying:

| Asset | Aave borrow APR | CEX margin borrow APR | Typical spread |
|---|---|---|---|
| USDC | 4-12% | 0-30% (volatile) | 5-15% during stress |
| ETH | 1-3% | 0.5-5% | 1-3% |
| WBTC | 1-2% | 0.5-3% | 0.5-2% |

**The trade:** borrow on the cheap side, lend on the dear side. Net the
spread minus gas/withdraw costs.

**Constraints:**
- Aave deposits earn variable rates; the spread is not locked in.
- CEX margin lending often has variable rates too.
- Gas cost on Aave entries/exits is the killer for small notional.

**Reality:** this trade nets 30-100 bps APR for most pairs; only worth
running at $100k+ notional. Useful as a *yield bottom* — capital not
deployed in any other strategy can earn this baseline.

---

## 3. Where it works

| Variant | Venue combos | Verdict | Notes |
|---|---|---|---|
| Perp-spot cash-and-carry | Coinbase (spot) + dYdX/Hyperliquid (perp) | ✅ | Most retail-accessible; this is the "starter basis trade" |
| Perp-spot cash-and-carry | Binance spot + Binance USDM perp | ⚠️ | Same exchange → no withdraw risk, but tier-locked rebates required for thin margins |
| Cross-exchange funding spread | dYdX + Hyperliquid | ✅ | Both hourly funding; cross-perp basis stays tight |
| Cross-exchange funding spread | Binance + dYdX | ✅ | Different funding intervals; biggest spreads but more rebalance overhead |
| Cross-exchange funding spread | Paradex + anyone | ⚠️ | Paradex volume thinner; less competitive |
| Futures-spot calendar roll | CME futures + Coinbase spot | ⚠️ | Requires CME account (institutional); not retail-accessible without Tradovate/IBKR |
| Futures-spot calendar roll | OKX quarterly + spot | ⚠️ | Available; tied up in quarterly contracts |
| Borrow-lend rate arbitrage | Aave + Coinbase margin | ✅ | Slim but reliable; useful baseline |

**Capital scale:**
- Perp-spot cash-and-carry: $1k → $500k. Above $500k, your spot leg moves the spot price during entry/exit (book impact); below $1k, fees eat the trade.
- Cross-exchange funding spread: $5k → $1M. Higher minimum because two open positions = double the per-leg fees.
- Futures-spot calendar roll: $25k → $1M+ (CME min contract size).
- Borrow-lend rate arb: $50k → $5M. Below $50k, gas + minimum-deposit thresholds eat margins.

**Latency tier:**
- All basis/funding trades are **T3-T4.** Funding settles on a slow clock; basis convergence is hours-to-days; you re-evaluate every 1-15 minutes. None require sub-second decisions.

---

## 4. Edge magnitude

| Variant | Typical APR (gross) | After fees/liquidation buffer | Source |
|---|---|---|---|
| Perp-spot cash-and-carry (BTC, normal regime) | 8-25% | 5-15% | Amberdata 2024 [^amber] |
| Perp-spot cash-and-carry (alt, ETH) | 10-40% | 6-25% | Same |
| Cross-exchange funding spread (BTC) | 15-50% | 10-30% | CoinGlass [^coinglass] |
| Cross-exchange funding spread (alt) | 30-150% | 20-80% | Bocconi BSIC 2024 [^bsic] |
| Futures-spot calendar roll (CME BTC, normal) | 3-15% | 2-10% | CME standard data |
| Borrow-lend rate arb | 0.3-2% | 0.2-1.5% | Operator data |

**Reality check — the BIS 2023 finding[^bis2023]:**

> "With leverage of just ten times (far below the maximum offered on
> many exchanges), the futures leg of a cash-and-carry strategy would
> have faced liquidation in over half the months in the sample."

Read again: at **10× leverage** (most ops use 3-5×, but this is well
within normal range), the trade liquidates **>50% of months**. The
gross APR numbers above are *before* the catastrophic-month drawdown
that liquidations cause. A trade quoting 30% APR that loses 80% of
position notional once a year due to liquidation has a realized APR of
*negative*.

**Honest annualized return** for a careful operator using 3× leverage,
conservative entry thresholds, and proactive exit on funding-flip:
8-20% APR on perp-spot cash-and-carry; 20-50% on cross-exchange funding
spreads. Higher numbers in headlines/marketing are gross.

---

## 5. What kills it

Ranked by frequency.

1. **Liquidation cascade on the perp leg.** A 5-10% spot move down triggers mass long liquidations; perp price decouples from spot for 30-300s as the cascade plays out; your short-perp leg may be auto-deleveraged (ADL) at unfavorable prices while spot is still falling. Net: you exit the perp at a worse price than the basis-trade thesis assumes.

   *Mitigation:* low leverage (2-3×); cross-margin where available; *insurance fund quality matters* — Binance > dYdX > Hyperliquid > smaller venues in ADL safety.

2. **Funding-rate sign flip.** You sized the trade for +30 bps/8h funding; the rate flips to −20 bps/8h during a deleveraging event; you're now paying instead of earning. If you stay, you bleed funding; if you exit, you eat the closing spread × 2 legs.

   *Mitigation:* monitor funding rate hourly; exit if rate flips against you for 2 consecutive windows AND `|funding_apr| > min_funding_apr_threshold`. Hard-code an exit threshold separate from entry.

3. **Counterparty failure.** FTX in 2022 is the textbook case — operators with cash-and-carry trades on FTX (spot or perp) lost the FTX leg. Mitigation: diversify across venues; cap any single venue's share of total trade book at 25%; treat any centralized venue's solvency as a non-zero risk.

4. **Bridge / withdrawal freeze.** USDC bridge between L1 and L2 (Polygon) can be congested or paused. If you need to rebalance between Aave (Ethereum L1) and Coinbase (off-chain), the bridge wait can be hours-to-days. Your basis trade is exposed during the wait.

5. **Insurance fund depletion / ADL.** When an exchange's insurance fund runs dry, profitable opposite-side positions get auto-deleveraged. Mitigation: prefer venues with deep, public insurance funds. Read the venue's ADL policy *before* sizing.

6. **Spot leg slippage on rebalance.** Periodic rebalance (e.g. weekly) means selling/buying spot. Slippage on the spot leg eats into the funding earnings. Mitigation: use execution algos (see execution-algos.md) for any rebalance > $10k notional.

7. **Mark price vs index price divergence.** Some venues liquidate on *mark* (a smoothed index); others on *index* (raw oracle). During flash events, mark and index can diverge 50-200 bps. Sizing for liquidation distance must use the correct one for your venue.

8. **Tax/accounting overhead.** Each basis-trade cycle is many trades (entry × 2 legs, rebalances, exit × 2 legs, funding settlements). If you're domiciled where each transaction is a tax event, the tax overhead can dwarf the trade's edge.

---

## 6. Parameters

A single basis-engine handles all four variants with shared and per-variant params.

### 6.1 Shared

| Param | Units | Default | Range | Purpose |
|---|---|---|---|---|
| `max_leverage` | dimensionless | 3 | [1, 10] | On the leveraged leg (typically perp) |
| `liquidation_buffer_pct` | percent | 50 | [20, 200] | Equity buffer above maint margin |
| `max_trade_book_pct_per_venue` | percent | 25 | [10, 50] | Diversification cap |
| `rebalance_cron_hours` | hours | 24 | [1, 168] | How often to mark-to-market and resize |
| `force_close_drawdown_pct` | percent | 5 | [1, 20] | Auto-flatten if drawdown exceeds |
| `min_position_usd` | USD | 1000 | [100, 10_000] | Don't open below this size |
| `max_position_usd` | USD | 50_000 | [1000, 1_000_000] | Per-pair cap |

### 6.2 Perp-spot cash-and-carry-specific

| Param | Default | Range | Purpose |
|---|---|---|---|
| `entry_basis_bps` | 10 | [5, 50] | Min absolute basis (perp-spot) to open |
| `exit_basis_bps` | 2 | [0, 20] | Close when basis closes to |
| `entry_funding_apr_pct` | 8 | [3, 50] | Min annualized funding to bother |
| `exit_funding_flip_windows` | 2 | [1, 5] | Close if funding flips for N consecutive windows |
| `min_volume_24h_usd` | 1_000_000 | [100_000, 100_000_000] | Liquidity filter |

### 6.3 Cross-exchange funding spread-specific

| Param | Default | Range | Purpose |
|---|---|---|---|
| `entry_spread_bps_per_window` | 8 | [3, 30] | Min funding-rate spread to open |
| `exit_spread_bps_per_window` | 2 | [0, 10] | Close when spread compresses to |
| `n_stable_windows_required` | 3 | [1, 10] | Wait until spread persists |
| `max_funding_window_skew` | 2.0 | [1.0, 8.0] | If one venue is 1h-funding and other is 8h, skew ratio cap |

### 6.4 Futures-spot calendar roll-specific

| Param | Default | Range | Purpose |
|---|---|---|---|
| `entry_annualized_basis_pct` | 5 | [2, 30] | Min annualized basis to open |
| `target_hold_to_expiry_days` | 60 | [7, 365] | Plan to hold this long |
| `early_close_basis_pct` | 1.5 | [0.5, 10] | Close if basis closes to (skip waiting for expiry) |

### 6.5 Borrow-lend rate arb-specific

| Param | Default | Range | Purpose |
|---|---|---|---|
| `min_spread_apr_pct` | 0.5 | [0.1, 5] | After gas/fees |
| `gas_cost_buffer_usd` | 30 | [5, 200] | Round-trip gas estimate |
| `protocol_risk_buffer_pct` | 10 | [1, 50] | Discount for smart-contract risk |
| `min_lock_period_days` | 1 | [0, 30] | Don't open if rate volatility within window > buffer |

---

## 7. Fill model (backtesting)

### 7.1 Entry / exit

Use IOC market or marketable-limit on both legs simultaneously. For
backtest, assume:

```
spot_fill_price = spot_ask + (entry_size / spot_top_size) × spot_spread_bps × 0.5
perp_fill_price = perp_bid − (entry_size / perp_top_size) × perp_spread_bps × 0.5
```

(swap signs for short-side entries). Cap impact at 1 bp per 10% of
top-of-book size consumed (Bouchaud square-root model[^bouchaud2018]).

### 7.2 Funding settlements

At each funding-window timestamp, settle:

```
funding_pnl = position_notional × funding_rate × (window_hours / 24)
```

Use the *realized* funding rate at the window timestamp (typically
exchanges publish this 5s before settlement; use the snapshot, not a
forward-looking estimate).

### 7.3 Mark-to-market

PnL = `(spot_current − spot_entry) × spot_qty` + `(perp_entry − perp_current) × perp_qty`
+ `Σ funding_payments` − `Σ trading_fees`.

For backtest, mark spot and perp at mid every minute; for liquidation
checks, mark at *worst-side* (bid for longs, ask for shorts) every tick.

### 7.4 Liquidation simulation

Most important fill-model component for honest backtests. At each tick:

```
perp_liquidation_price = perp_entry × (1 − 1/leverage + maint_margin_pct)  // for shorts
                                              (+ 1/leverage − maint_margin_pct) for longs
```

If `perp_price` crosses the liquidation price during the tick, close
the perp at the liquidation price (NOT the next tick's mid — liquidation
fills are at the engine's chosen price, often the worst of the tick).
Spot leg becomes naked; PnL must be marked from then on with unhedged
spot risk.

**The BIS 2023 paper used exactly this model**[^bis2023] to derive the
"50% of months liquidate at 10× leverage" result. Any backtest claiming
20-30% APR with low drawdown should be checked: does it model
liquidations honestly?

### 7.5 Funding-rate sign-flip injection

For stress-testing: with probability `p_flip = 0.05` per funding window,
flip the realized funding rate. Models the deleveraging-event scenario
that pure historical replay underrepresents.

---

## 8. Backtest design

### 8.1 Data

| Variant | Data | Source |
|---|---|---|
| Perp-spot cash-and-carry | spot top-of-book, perp top-of-book, hourly funding rates, mark/index prices | Coinbase WS, dYdX Indexer (free), Hyperliquid API, Binance API |
| Cross-exchange funding spread | per-venue funding-rate history (multiple venues) | dYdX `/historicalFunding`, Binance `/fapi/v1/fundingRate`, Hyperliquid `/info` |
| Futures-spot calendar roll | spot prices, dated futures prices, expiry calendars | CME's historical, Deribit/OKX/Binance quarterly APIs |
| Borrow-lend rate arb | Aave rates per asset, CEX margin rate history | Aave subgraph, Coinbase, Binance margin docs |

### 8.2 Metrics

- **Annualized return on deployed capital** (not on max-possible capital — the trade isn't always open).
- **Sharpe (post-fee, post-liquidation, post-funding flip injection).**
- **Max drawdown.** Critical — basis trades can have 20-50% drawdown during cascade events even if they're "delta-neutral" on paper.
- **Liquidation rate** — fraction of trade-cycles ending in liquidation. Should be < 5% for a deployable strategy.
- **Days-in-position vs days-flat.** Capital efficiency.
- **Realized vs entry funding-rate** divergence. Indicates how well your entry-rate predicted realized.

### 8.3 Walk-forward

Crypto regimes shift fast. Quarterly walk-forward:
- Train on Q1 2024: tune `entry_basis_bps`, `entry_funding_apr_pct`, `max_leverage`.
- Test out-of-sample on Q2 2024.
- Roll quarterly.

Q1 2024's normal regime was a bull-FOMO period with consistently high
funding; the resulting params were *wrong* for Q2's deleveraging.
This is why a single-period backtest is misleading.

### 8.4 Look-ahead traps

- **Don't use realized funding rate to enter a trade.** The realized rate at window `t` is what the next funding window will pay, not the current. Use the *predicted* `nextFundingRate` available at trade time.
- **Don't liquidate at the next tick's mid.** Liquidations on real venues fill at the engine's chosen worst-of-tick price.
- **Don't ignore index-vs-mark divergence.** During flash events, mark and index can diverge; the venue's liquidation engine uses the mark, not the spot index.

---

## 9. Code skeleton

Builds on the existing `src/lib/hft/basis.ts` (which provides
`computeBasis(spot, perp, nextFundingRate, fundingHorizonHours)` →
`BasisResult`). The engine adds entry/exit decision logic, position
tracking, and liquidation simulation.

### 9.1 Engine module: `src/lib/hft/basis/engine.ts`

```ts
import { computeBasis, type BasisInputs, type BasisResult } from "../basis";
import type { Venue } from "../venues";

export type BasisPositionState = {
  positionId: string;
  asset: string;
  spotVenue: string;
  perpVenue: string;
  side: "long-basis" | "short-basis";  // long-basis = long spot + short perp
  spotQty: number;
  perpQty: number;
  entrySpot: number;
  entryPerp: number;
  entryFundingRate: number;
  entryTs: number;
  fundingPnlUsd: number;
  fundingFlipWindowCount: number;
  realizedPnlUsd: number;
  status: "open" | "closing" | "closed" | "liquidated";
};

export type BasisEngineCfg = {
  entryBasisBps: number;
  exitBasisBps: number;
  entryFundingApr: number;
  exitFundingFlipWindows: number;
  maxLeverage: number;
  liquidationBufferPct: number;
  positionUsd: number;
  forceCloseDrawdownPct: number;
};

export type BasisDecision =
  | { kind: "open"; side: "long-basis" | "short-basis"; basis: BasisResult; reasoning: string }
  | { kind: "close"; reason: string }
  | { kind: "hold"; reason: string };

export function evaluateBasisOpen(
  inputs: BasisInputs & { asset: string; spotVenue: string; perpVenue: string },
  cfg: BasisEngineCfg,
): BasisDecision {
  const r = computeBasis(inputs);
  if (Math.abs(r.basisBps) < cfg.entryBasisBps) {
    return { kind: "hold", reason: `basis ${r.basisBps.toFixed(2)} bps < entry threshold` };
  }
  if (Math.abs(r.fundingApr) < cfg.entryFundingApr / 100) {
    return { kind: "hold", reason: `funding APR ${(r.fundingApr * 100).toFixed(1)}% < threshold` };
  }
  if (r.preferredLeg === "flat") {
    return { kind: "hold", reason: "preferredLeg flat" };
  }
  return {
    kind: "open",
    side: r.preferredLeg,
    basis: r,
    reasoning: `basis ${r.basisBps.toFixed(2)} bps, funding APR ${(r.fundingApr * 100).toFixed(1)}%, ${r.preferredLeg}`,
  };
}

export function evaluateBasisExit(
  state: BasisPositionState,
  current: BasisInputs,
  cfg: BasisEngineCfg,
): BasisDecision {
  const r = computeBasis(current);

  // 1. Basis converged → close (profit taking)
  if (Math.abs(r.basisBps) < cfg.exitBasisBps) {
    return { kind: "close", reason: `basis converged: ${r.basisBps.toFixed(2)} bps` };
  }

  // 2. Funding flipped sign for N consecutive windows → close
  const expectedSign = state.side === "long-basis" ? +1 : -1;
  const fundingSign = Math.sign(r.fundingBpsHourly);
  if (fundingSign !== 0 && fundingSign !== expectedSign) {
    // funding flipped: increment counter outside (track in caller)
    if (state.fundingFlipWindowCount + 1 >= cfg.exitFundingFlipWindows) {
      return { kind: "close", reason: `funding flipped ${cfg.exitFundingFlipWindows} windows` };
    }
  }

  // 3. Drawdown exceeded → emergency close
  const ddPct = (state.realizedPnlUsd / cfg.positionUsd) * 100;
  if (ddPct < -cfg.forceCloseDrawdownPct) {
    return { kind: "close", reason: `drawdown ${ddPct.toFixed(2)}% < threshold` };
  }

  // 4. Liquidation imminent (perp side) → close defensively
  const distToLiq = computeDistanceToLiquidation(state, current.perp, cfg);
  if (distToLiq < cfg.liquidationBufferPct / 100) {
    return { kind: "close", reason: `liquidation buffer breached: ${(distToLiq * 100).toFixed(2)}%` };
  }

  return { kind: "hold", reason: "all gates passed" };
}

function computeDistanceToLiquidation(
  state: BasisPositionState,
  currentPerpPrice: number,
  cfg: BasisEngineCfg,
): number {
  const liqPrice = state.side === "long-basis"
    ? state.entryPerp * (1 + 1 / cfg.maxLeverage - 0.005)
    : state.entryPerp * (1 - 1 / cfg.maxLeverage + 0.005);
  const distance = Math.abs(currentPerpPrice - liqPrice) / state.entryPerp;
  return distance;
}
```

### 9.2 Cross-exchange funding spread engine: `src/lib/hft/basis/funding-spread.ts`

```ts
export type FundingObs = {
  venue: string;
  asset: string;
  windowHours: number;
  fundingRate: number;          // per window
  perpMid: number;
  ts: number;
};

export type FundingSpreadDecision =
  | {
      kind: "open";
      shortVenue: string;
      longVenue: string;
      spreadBpsPerDay: number;
      annualizedSpreadPct: number;
    }
  | { kind: "hold"; reason: string };

export function evaluateFundingSpread(
  observations: FundingObs[],  // same asset, multiple venues
  cfg: { minSpreadBpsPerDay: number; nStableWindowsRequired: number },
  stabilityHistory: Map<string, number[]>, // venue-pair → spread history (in bps/window)
): FundingSpreadDecision {
  if (observations.length < 2) return { kind: "hold", reason: "need ≥2 venues" };

  // Normalize all rates to bps/day
  const normalized = observations.map(o => ({
    venue: o.venue,
    bpsPerDay: o.fundingRate * (24 / o.windowHours) * 10_000,
    perpMid: o.perpMid,
  }));

  // Find max-spread pair
  let bestSpread = { high: normalized[0], low: normalized[0], spread: 0 };
  for (const h of normalized) for (const l of normalized) {
    const sp = h.bpsPerDay - l.bpsPerDay;
    if (sp > bestSpread.spread) bestSpread = { high: h, low: l, spread: sp };
  }

  if (bestSpread.spread < cfg.minSpreadBpsPerDay) {
    return { kind: "hold", reason: `best spread ${bestSpread.spread.toFixed(2)} bps/day < threshold` };
  }

  // Stability check: spread persisted across N windows
  const pairKey = `${bestSpread.high.venue}-${bestSpread.low.venue}`;
  const history = stabilityHistory.get(pairKey) ?? [];
  const stableWindows = history.filter(s => s >= cfg.minSpreadBpsPerDay).length;
  if (stableWindows < cfg.nStableWindowsRequired) {
    return { kind: "hold", reason: `stability ${stableWindows}/${cfg.nStableWindowsRequired}` };
  }

  return {
    kind: "open",
    shortVenue: bestSpread.high.venue,
    longVenue: bestSpread.low.venue,
    spreadBpsPerDay: bestSpread.spread,
    annualizedSpreadPct: bestSpread.spread * 365 / 10_000 * 100,
  };
}
```

### 9.3 Wire-up

The engine produces `BasisDecision` / `FundingSpreadDecision`; an
orchestrator pulls market data, calls the decision functions, and
routes orders through the existing `src/lib/venue/router.ts`:

```ts
// scripts/basis-tick.ts (pseudocode)
async function basisTick() {
  for (const asset of ["BTC", "ETH"]) {
    const spot = await coinbase.getSpot(asset);
    const perp = await dydx.getPerp(asset);
    const funding = await dydx.getNextFundingRate(asset);

    const decision = evaluateBasisOpen(
      { spot, perp: perp.mid, nextFundingRate: funding, fundingHorizonHours: 1, asset, spotVenue: "coinbase", perpVenue: "dydx" },
      DEFAULT_BASIS_CFG,
    );

    if (decision.kind === "open") {
      // Submit two legs simultaneously via execution-algos.md IS executor:
      await Promise.all([
        executor.submitSpot(asset, "coinbase", decision.side === "long-basis" ? "BUY" : "SELL", spotQty),
        executor.submitPerp(asset, "dydx", decision.side === "long-basis" ? "SELL" : "BUY", perpQty),
      ]);
      // Persist position state.
    }
  }
}
```

---

## 10. Implementation path here

1. **Create `src/lib/hft/basis/` directory.** Move the existing `src/lib/hft/basis.ts` (math primitive) → `src/lib/hft/basis/math.ts`. Re-export from a barrel index.
2. **Add `src/lib/hft/basis/engine.ts`** per §9.1. Pure decision-making; no I/O.
3. **Add `src/lib/hft/basis/funding-spread.ts`** per §9.2.
4. **Add data adapters:**
   - `src/lib/hft/basis/sources/coinbase-spot.ts` — wraps Coinbase WS for spot mid/ask/bid + volume.
   - `src/lib/hft/basis/sources/dydx-perp.ts` — wraps dYdX Indexer for perp mid + next funding rate.
   - `src/lib/hft/basis/sources/hyperliquid-perp.ts`, `binance-perp.ts` — similar.
5. **Add orchestrator script** `scripts/basis-tick.ts` that polls all venues every minute, runs the engine, and routes orders through `ExecutionRouter`.
6. **Cron wrapper:** `scripts/basis-loop.ts` that runs `basis-tick` on a schedule; integrates with `src/lib/risk/kill-switch.ts` for halt-all behavior.
7. **Position store:** persist `BasisPositionState` to SQLite (extend the existing `data/polymarket.db` schema or use a new DB file). Required so positions survive restarts.
8. **Liquidation simulator** for backtests: `src/lib/hft/basis/liquidation.ts` per §7.4. Critical that backtests use this — without it, results look 2-3× better than reality.
9. **Backtest harness:** `scripts/backtest-basis.ts` running on historical funding data. Output to `docs/basis-results.json` (gitignored).
10. **Tests:**
    - `tests/unit/basis-engine.test.ts` — entry/exit decision logic; funding-flip detection.
    - `tests/unit/basis-liquidation.test.ts` — liquidation math vs known venue formulas.
    - `tests/unit/basis-funding-spread.test.ts` — venue ranking, stability check.
    - `tests/integration/basis-flow.test.ts` — mock venue → end-to-end open → hold through funding cycle → close.
11. **UI surface:** `src/app/hft/basis/page.tsx` — live basis quotes per asset/venue-pair, open positions, funding accrued, distance-to-liquidation per position.
12. **Capsule wiring:** when the agentic-layer allocator (`src/lib/arena/allocator.ts`) routes capital to a "basis agent," the basis engine consumes that capsule for sizing (`positionUsd` = capsule's max_position_usd).

---

## 11. Asset-specific gotchas

### BTC (canonical asset)

- **Deepest perp + spot books** anywhere; cleanest basis trade.
- **Funding rates most studied;** historical data goes back to 2017+ for most venues.
- **Watch the CME bridge** — when CME spot ETFs and crypto-native venues are aligned vs misaligned, the basis term-structure shifts. Tracking BIS/Coinbase research helps.

### ETH

- **More retail-FOMO sensitive than BTC;** funding rates more volatile.
- **Staking yield interaction.** Some ETH spot positions could also earn staking yield (Lido stETH). This can stack on top of basis carry; check that your spot venue allows it.

### Solana, large-cap alts

- **Funding rates** can swing massively (200%+ APR during meme cycles); huge basis-trade potential AND huge liquidation risk.
- **Spot venue depth is poor;** book impact on entry/exit erodes more of the gross APR than for BTC.
- **Cross-venue funding spreads** are biggest on alts because retail concentrates on one or two venues per cycle.

### Cross-venue logistics (BTC across multiple venues)

- **WBTC <> BTC** — Coinbase has native BTC; some perps quote against WBTC (rare). This is a *different* asset for hedging purposes; spot WBTC + perp BTC has the WBTC-peg risk laid on top.
- **USDC vs USDT settlement.** Perp may settle in USDT, spot may be USDC. Stablecoin basis (USDC-USDT) on top of crypto basis adds a second source of drift.

### Borrow-lend specifics

- **Aave liquidation.** If you borrow on Aave and your collateral drops, Aave liquidates *your collateral* (charging a 5-15% fee). Don't borrow up to the limit.
- **Variable rate jumps.** Aave rates jump 5×+ during stress (when borrow demand spikes). Position your trade at <50% utilization.

---

## 12. Open questions worth answering (research directions)

1. **Funding-flip prediction.** Can a short-horizon classifier (input: recent funding moves, open interest, basis term-structure) predict funding-rate flips 1-2 windows ahead? Worth a backtest. If yes, exit *before* the flip instead of after.
2. **Basis term-structure across venues.** dYdX's 1h funding vs Binance's 8h means the basis dynamics differ; is there a "term-structure trade" combining both? Sketch: short hourly venue during basis spike (fast convergence), long 8h venue (slower convergence pays more).
3. **Borrow-lend + basis stacking.** Use Aave-borrowed USDC to fund a basis trade; the net edge is `basis_APR − Aave_borrow_APR`. When does this stack pencil? Probably during low-borrow-rate regimes.
4. **Cross-chain basis (Ethereum L1 + L2).** WBTC on Ethereum vs WBTC bridged to Arbitrum/Optimism can trade at different prices momentarily (bridge cost). Tiny, fast trade; needs bridge automation.
5. **Calendar-roll on Deribit options.** Long-dated Deribit call options replicate forward exposure; the implied forward vs spot is a "basis" too. Worth examining vs futures-spot.

---

## 13. References

[^bis2023]: BIS. "Crypto carry." BIS Working Paper No. 1087, 2023. [bis.org/publ/work1087.pdf](https://www.bis.org/publ/work1087.pdf). — The "10× leverage liquidates 50%+ of months" paper. Read this before deploying capital.

[^cepr]: CEPR. "Crypto carry: Market segmentation and price distortions in digital asset markets." VoxEU column summarizing the BIS work. [cepr.org/voxeu/columns/crypto-carry](https://cepr.org/voxeu/columns/crypto-carry-market-segmentation-and-price-distortions-digital-asset-markets).

[^amber]: Amberdata. "The Ultimate Guide to Funding Rate Arbitrage." [blog.amberdata.io](https://blog.amberdata.io/the-ultimate-guide-to-funding-rate-arbitrage-amberdata).

[^coinglass]: CoinGlass. "What is Funding Rate Arbitrage?" [coinglass.com/learn](https://www.coinglass.com/learn/what-is-funding-rate-arbitrage).

[^bsic]: Bocconi BSIC. "Perpetual Complexity: An Introduction to Perpetual Future Arbitrage Mechanics." [bsic.it](https://bsic.it/perpetual-complexity-an-introduction-to-perpetual-future-arbitrage-mechanics-part-1/).

[^bouchaud2018]: Bouchaud, J.-P., Bonart, J., Donier, J., & Gould, M. (2018). *Trades, Quotes and Prices.* Cambridge University Press. — Square-root impact law calibration.

[^march2024_cascade]: Industry coverage of March 2024 BTC flash crash, $2.8B liquidated in 24h. (Multiple sources — Bitget Academy / Hyrotrader.)

[^hyperliquid_dec2024]: Hyperliquid December 2024 flash crash event; $400M+ liquidated across Hyperliquid + Binance in 7% BTC move from $103,853 to $92,251.

**Other primary sources**
- Gate Learn. "Perpetual Contract Funding Rate Arbitrage Strategy in 2025." [gate.com/learn](https://www.gate.com/learn/articles/perpetual-contract-funding-rate-arbitrage/2166).
- ScienceDirect. "Exploring Risk and Return Profiles of Funding Rate Arbitrage on CEX and DEX." [sciencedirect.com](https://www.sciencedirect.com/science/article/pii/S2096720925000818).
- AEA. "Perpetual Futures and Basis Risk: Evidence from Cryptocurrency." 2026. [aeaweb.org/conference](https://www.aeaweb.org/conference/2026/program/paper/ByyFEfr4) — basis risk in liquidation cascades.
- arXiv:2512.01112. "Autodeleveraging: Impossibilities and Optimization." [arxiv.org](https://arxiv.org/pdf/2512.01112) — ADL dynamics.

**Related modules in this repo**
- `src/lib/hft/basis.ts` — `computeBasis()` math primitive (live). The engine extension above wraps it.
- `src/lib/venue/router.ts` — where the orchestrator routes orders.
- `src/lib/risk/kill-switch.ts` — register the basis engine here for halt-all.
- `src/lib/hft/edge.ts` — every basis trade must pass the cost-edge formula at entry.
- `docs/dydx-basis-results.json` (gitignored) — early backtest output from `scripts/test-dydx-basis.ts`-style sweeps; shows realistic mid-2026 BTC basis dynamics.
- cross-venue-arbitrage.md §2.2-2.3 — overview-level coverage of basis & funding-spread, deferred to this doc for math + engine.
