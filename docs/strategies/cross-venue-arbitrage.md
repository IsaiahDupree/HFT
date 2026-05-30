# Cross-Venue Arbitrage

> **Family:** 2 — Cross-venue arbitrage
> **Variants covered:** CEX-CEX spot · perp-spot basis (cash-and-carry) · funding-rate cross-exchange · triangular crypto · equities NBBO/SOR · Polymarket complement-sum · Polymarket vs CEX oracle
> **Repo modules:** `src/lib/strategies/complement-sum-arb.ts`, `src/lib/hft/basis.ts`, `src/lib/hft/polymarket-btc.ts`, `src/lib/onchain/bridges.ts`
> **Cross-asset coverage:** US equities (Alpaca) · crypto spot (Coinbase, others) · crypto perps (dYdX, Hyperliquid, Paradex) · prediction markets (Polymarket)

---

## 1. TL;DR

Same instrument, two prices. Buy the cheap one, sell the dear one. The
strategy is conceptually trivial; the engineering is not. Every variant
fights the same four-line cost model:

```
arb_profit = price_dear − price_cheap
            − fees_buy_side − fees_sell_side
            − transfer_cost (if you must move inventory between venues)
            − staleness_loss (price moved between observation and execution)
            − partial_fill_loss (one leg fills, the other doesn't)
```

If this nets positive after honest plug-ins for *all* terms — including
withdrawal fees, gas, and the probability-weighted partial-fill scenario —
you have an arbitrage. Most apparent arbs don't survive the audit.

This dossier covers seven concrete variants spanning all four asset
classes the repo touches.

---

## 2. The seven variants

### 2.1 CEX-CEX spot arb (intra-asset, two venues)

You see BTC bid on Venue A at $73,450 and offered on Venue B at $73,440.
Buy on B, sell on A — $10 / BTC gross.

**Reality check (2025 retail tier):** spreads between top-5 CEXes for
BTC/ETH compress to <1 bp during US/EU overlap. Profitable arbs appear at
3-5 AM UTC, around exchange-specific events (listings, halts, deposit
freezes), and in long-tail pairs (anything below $200M daily volume).

**Speed requirement:** T2 (5-30ms cross-venue). At T3 (REST polling), you
see the arb after Citadel/Wintermute/Jump have closed it.

**The hidden cost most people miss:** withdrawal fees + lockup time. If
you need to move inventory between venues to rebalance, withdrawal cost
(0.0002 BTC + 10 min wait) dwarfs the per-arb edge. The pros run with
*pre-funded* inventory on every venue they trade and never move it.

### 2.2 Perp-spot basis (cash-and-carry)

Hold long spot + short perp (or vice versa). The position is delta-neutral.
You earn the *funding rate* paid between perp longs and shorts. See
`src/lib/hft/basis.ts` for the math.

When `basis > 0` (perp trades above spot, "contango"): funding flows from
longs to shorts. Strategy = long spot, short perp.
When `basis < 0` ("backwardation"): reverse.

**Edge magnitude:** annualized 15-40% on capital during 2024-2025 bull
phases; 5-15% during quiet periods; can go negative (you pay) during sharp
deleveraging events.[^amber] The dYdX-trade backtest in the source repo
showed 19% annualized.

**Speed requirement:** T3-T4. Re-evaluating every 1-15 minutes is plenty;
the position holds for hours-to-days.

**Failure modes:**
- **Liquidation cascade.** When perp longs get liquidated en masse, perp price drops faster than spot; if you were short the perp (i.e. expecting positive basis to mean-revert), your perp leg gains, but if you've sized the basis trade incorrectly, your spot losses can exceed perp gains during a flash crash. Use cross-margin and conservative leverage.
- **Funding rate sign flip.** A 24-hour stable funding rate of +30 bps/8h can flip to −20 bps/8h in a single funding window during deleveraging. The carry inverts and you start *paying*. Mitigation: re-evaluate `basis` and `nextFundingRate` every funding window, and have rules to close the trade if either flips against you for two consecutive windows.
- **Borrow rate for spot side.** If you used leverage on the spot side (margin), the borrow cost can eat the funding-rate carry. Always compute net: `funding_carry − spot_borrow_cost`.

### 2.3 Funding-rate cross-exchange arb

Two exchanges quote different funding rates on the same perp (e.g. dYdX
funding +30 bps/8h vs Hyperliquid +5 bps/8h on ETH-PERP). The strategy:
short the high-funding venue + long the low-funding venue (with matching
notional). You collect the *spread* in funding, net of fees.[^coinglass]

**Edge magnitude:** typically 2-8 bps per 8-hour window when meaningful
spreads exist; can be 20+ bps during stressed events. Annualized 10-25%
on capital before fees.

**Speed requirement:** T3-T4. The funding mechanism settles on a clock
(every 1h or 8h depending on venue), so you don't need tick-level
execution.

**Failure modes:**
- **Spread collapses.** Other arbs close it before your funding window prints. Mitigation: enter only when spread > `entry_threshold` (e.g. 5 bps after fees).
- **One-leg liquidation.** Independent margin accounts; if one venue has a flash spike, that leg can liquidate while the other doesn't. The remaining naked leg has full directional exposure. Mitigation: lower per-leg leverage; set hard stop on max gross exposure.
- **Funding rate prediction error.** You sized the trade on `nextFundingRate` but the *realized* rate at settlement is different (especially on venues with dynamic funding formulas). Mitigation: prefer venues with deterministic funding (dYdX) over predictive (Binance) for this trade.

### 2.4 Triangular crypto

Three pairs forming a cycle: `BTC/USDT`, `ETH/USDT`, `ETH/BTC`. If the
implied cross rate `(BTC/USDT) × (ETH/BTC)` differs from `(ETH/USDT)`, you
can trade the cycle for a riskless profit (modulo fees).

**Edge magnitude:** virtually extinct on majors at top CEXes (<0.5 bps).
Appears occasionally on DEXes (Solana, Uniswap-style AMMs) where MEV
extractors front-run; profitable for retail only when the arb edge exceeds
priority-fee competition.

**Speed requirement:** T0-T1 on CEX. T2-T3 on DEX (via private RPC + bundle
submission to a builder).

**Verdict:** mostly out of scope for this repo. Listed here for taxonomic
completeness. Don't pursue unless you have a co-located/private-mempool
setup.

### 2.5 Equities NBBO / Smart Order Routing (SOR)

Reg NMS Rule 611 requires brokers to route orders to the venue showing the
best displayed price (the NBBO).[^regnms] The arb retail traders can
participate in here is *narrow*:

- **Inverted-fee venues.** Some exchanges (EDGA, BX) charge takers and pay makers; others (EDGX, BZX) do the inverse. Routing rebate optimization can capture 0.1-0.3 cents/share — but only if you have direct exchange access. Through Alpaca, you don't.
- **Sub-penny price improvement.** Internalizers (Citadel, Virtu, etc.) pay for retail order flow. Your "best execution" via Alpaca usually receives small price improvement (~0.1 bps). You don't capture this as profit; it's baked into your fills.

**Verdict for retail / this repo:** classical NBBO arb is *gone*. Brokers
already enforce it. The remaining adjacent edges:

- **Dual-listed name arb** (e.g. ADRs vs home market): genuine but needs cross-market access. Out of repo scope without IBKR or similar.
- **ETF NAV arb**: see §2.7 below.

### 2.6 Polymarket complement-sum (implemented in this repo)

A binary market resolves to $1 for one side, $0 for the other. If
`ask(YES) + ask(NO) < $1`, buying both sides guarantees a positive payout
at resolution.

```
gross_profit_per_pair = 1 − (ask_YES + ask_NO)
net_profit_per_pair  = gross − fees − slippage
```

**This is implemented:** `src/lib/strategies/complement-sum-arb.ts`. The
defaults (`max_combined = 0.97`, `min_profit_usd = 0.02`) are conservative
and have been live-validated.

**Edge magnitude:** 1-4% per arb cycle on Polymarket binaries; appears
sporadically (a few times per day on active markets, more during volatility).
Annualized depends entirely on how often you can rotate capital — typical
operator backtests showed 40-100% on small ($1k-$10k) capital, decaying
hard above $50k.

**Failure modes (ranked):**
1. **Partial fill.** One leg fills at $0.45, the other moves to $0.58 before your second order lands. You're now long one side (unhedged) with no arb. Mitigation: market-IOC both legs simultaneously; cap notional per arb at the *minimum* depth of the two sides; have a hedge-or-exit policy if a partial-fill is detected.
2. **Resolution risk.** Market resolves ambiguously, takes weeks, or is voided. You're stuck with capital trapped. Mitigation: avoid markets where resolution criteria are unclear; check Polymarket UMA history for the market category.
3. **Fee miscalibration.** The Polymarket relayer / CLOB fee schedule has trapdoors (settlement fees, gas surcharges on bridges). If your detector underestimates fees by 50 bps, your "arb" is breakeven. Mitigation: use the implemented detector's `feeBps` input and pull live fees from `src/lib/polymarket/category.ts`.

### 2.7 Polymarket vs CEX oracle (latency arb)

Polymarket has binary markets like "Will BTC be above $73,500 at 4:00 PM
UTC?" The fair value at any time is a function of the CEX spot price and a
binary option model. If Polymarket's market price disagrees materially with
the CEX-implied fair value, there's an edge.

**This is implemented:** `src/lib/hft/polymarket-btc.ts` produces the
CEX-implied fair; the comparison with Polymarket's order book gives the
edge. Listed under arbitrage because it's *cross-venue* — you're trading
the Polymarket leg against the implied price from CEX (without necessarily
holding a CEX leg).

**Caveat:** this is *quasi-arbitrage*. You're not hedged unless you also
trade a CEX option or a perp at the strike. Without the hedge, you've taken
a directional position dressed as an arb. The detector should flag the
unhedged variant as "signal-driven directional" not "arb."

---

## 3. Edge magnitude (gross, before all costs)

| Variant | Asset | Typical edge / cycle | Cycles / day | Annualized estimate | Reference |
|---|---|---|---|---|---|
| CEX-CEX spot BTC | crypto | 1-5 bps | 5-30 | 5-15% | Operator data; varies hugely |
| CEX-CEX spot long-tail | crypto | 5-50 bps | 1-10 | 10-40% | Operator data |
| Perp-spot basis (BTC, ETH) | crypto | basis 5-30 bps + funding 5-30 bps/8h | continuous hold | 15-40% | Amberdata [^amber] |
| Funding-rate cross-exchange | crypto | 2-10 bps per 8h spread | 3/day | 10-25% | CoinGlass [^coinglass] |
| Triangular crypto on majors | crypto | <0.5 bps | rare | sub-1% | Operator data |
| Equities NBBO via Alpaca | equities | none reliably accessible | n/a | n/a | — |
| ETF NAV arb (institutional) | equities | 0.5-3 bps | 5-50 | 5-15% (requires APs) | Springer J. Asset Mgmt 2025 [^etf] |
| Polymarket complement-sum | binaries | 100-400 bps gross | 1-5 (variable) | 40-100% small cap | This repo's operator backtests |
| Polymarket vs CEX BTC oracle | binaries | 50-300 bps | 2-20 | 30-80% | This repo's operator backtests |

**Honesty check:** these are *gross* numbers. Subtract 30-50% for
realistic fee/latency/partial-fill drag, then another 20% for the months
your strategy doesn't work. The "what actually happened" annualized number
for a careful operator is typically 30-60% of the gross.

---

## 4. The four cost categories

Every variant must pass:

```
arb_profit > fees_total + transfer_cost + staleness_loss + partial_fill_EV
```

### 4.1 Fees total

- Maker/taker fees per leg.
- Settlement fees (Polymarket CLOB settles on Polygon; gas matters).
- Withdrawal fees if rebalancing.
- Funding payments (perp basis trades): integrate over hold period.

The repo's `src/lib/hft/edge.ts` is set up for the maker/taker split. For
cross-venue arb, sum the per-leg costs.

### 4.2 Transfer cost

The cost to move inventory between venues if/when you need to rebalance.

- Crypto: withdrawal fees (BTC ~$5, ETH ~$2 base + gas, USDC on Polygon <$0.01).
- Equities: ACATS transfer days; not arb-relevant.
- Polymarket: USDC on Polygon for funding; bridge cost if coming from L1 (use the implementation in `src/lib/onchain/bridges.ts`).

**Optimization:** pre-fund each venue with target inventory and *never
rebalance during arb sessions*. Rebalance during low-vol windows (Asian
night for crypto) when the opportunity cost of out-of-position inventory
is low.

### 4.3 Staleness loss

Price moves between your observation of the opportunity and your execution
of both legs. For each leg, expected staleness loss ≈
`σ × √(t_obs→ack) × √(t_obs→ack / 2)`.

At T2 (10ms round-trip), σ = 50 bps/day, staleness loss ≈ 0.05 bps. Tiny.

At T3 (200ms round-trip), staleness loss ≈ 0.7 bps. Often eats the whole
edge on tight CEX-CEX arbs.

At T4 (5s polling), staleness loss ≈ 5-10 bps. Restricts you to variants
where edge is ≥ 30 bps (Polymarket complement-sum qualifies, CEX-CEX spot
on majors does not).

### 4.4 Partial-fill expected loss

Probability-weight: `P(partial) × E[loss | partial]`.

- For IOC (immediate-or-cancel) orders simultaneously on both legs, `P(partial)` is the probability *one* fills and the other gets canceled or returns 0 fill. On Polymarket binary IOC, this is ~5-15% per cycle.
- `E[loss | partial]` is the cost to either close out the orphan leg at market (which can be wide) or hold it as a naked directional position (and accept the variance).

Rule of thumb: if `P(partial) × (spread_orphan/2) > arb_edge / 3`, the arb
is not robust enough — skip.

---

## 5. What kills cross-venue arb (ranked by how often)

1. **Withdrawal/transfer costs > you accounted for.** "I'll just move BTC from Coinbase to Binance to capture this." The withdrawal fee + lockup + opportunity cost makes it negative.
2. **Latency tier wrong for the variant.** Trying CEX-CEX spot from T3 polling. Won't work; the edge already closed.
3. **Partial-fill cascade.** One leg fills, second is rejected, you scramble to hedge, slippage on the hedge erases the day's PnL. Mitigation: per-cycle notional cap = `min(depth_a, depth_b) × safety_factor` where safety_factor is 0.5-0.8.
4. **Venue downtime mid-arb.** Venue B halts trades after you bought on A. You're stuck with one leg. Mitigation: kill-switch on venue-error rate per minute; do not enter new arb cycles if either venue's error rate > 1%.
5. **Counterparty risk on stuck positions.** Funds locked at the bad-quote venue while it sorts out an exchange-level issue. Lessons: keep your "trapped capital" at any one venue < 20% of your total arb capital.
6. **Fee schedule change.** Coinbase changes its tier breakpoints; your arb that was +2 bps net is now −1 bps. Mitigation: re-derive per-venue fees from the live API daily, not from a hard-coded constant.
7. **Phantom liquidity / spoofing.** The size you saw at the dear venue vanishes before your sell hits. Mitigation: discount displayed depth by 50% for venues with known spoof-prone books; use trade-history-based fill simulation in backtests.

---

## 6. Parameters

A single "cross-venue arb engine" handles all spot-like variants
(complement-sum, CEX-CEX, ETF-NAV) with a common parameter set. Basis and
funding-rate trades have their own additional params.

### 6.1 Common (all variants)

| Param | Units | Default | Range | Purpose |
|---|---|---|---|---|
| `min_edge_bps` | bps | 5 | [1, 200] | Minimum *net* edge to take the trade |
| `max_notional_usd` | USD | 5000 | [100, 100_000] | Cap per-cycle notional |
| `safety_factor` | dimensionless | 0.7 | [0.3, 1.0] | Multiplier on `min(depth_a, depth_b)` |
| `max_cycles_per_min` | 1/min | 6 | [1, 60] | Rate limit, anti-Bot detection |
| `max_open_cycles` | int | 3 | [1, 20] | Concurrent unresolved arbs |
| `latency_budget_ms` | ms | 500 | [50, 5000] | Skip if observed > inferred budget |
| `venue_error_kill_pct` | percent | 2.0 | [0.5, 10.0] | Halt if any venue error rate exceeds |
| `partial_fill_hedge_policy` | enum | `close_at_market` | `close_at_market` / `hold_naked` / `wait_5s_then_close` | What to do on partial |

### 6.2 Perp-spot basis-specific

| Param | Units | Default | Range | Purpose |
|---|---|---|---|---|
| `entry_basis_bps` | bps | 8 | [2, 30] | Open trade only if `|basis_bps|` ≥ |
| `exit_basis_bps` | bps | 2 | [0, 15] | Close trade when `|basis_bps|` falls to |
| `min_funding_apr` | percent | 8 | [3, 50] | Require this much funding carry to bother |
| `max_leverage` | dimensionless | 2 | [1, 5] | On the perp leg |
| `funding_flip_close_n` | int | 2 | [1, 5] | Close if funding rate flips sign N windows in a row |
| `max_hold_hours` | hours | 168 (7d) | [4, 720] | Force-close beyond |

### 6.3 Funding-rate cross-exchange-specific

| Param | Units | Default | Range | Purpose |
|---|---|---|---|---|
| `min_spread_bps_per_window` | bps | 5 | [2, 30] | Open if `\|rate_a − rate_b\|` × hours_per_window ≥ |
| `min_combined_apr` | percent | 12 | [5, 50] | Require this APR after exchange fees |
| `n_windows_to_evaluate` | int | 3 | [1, 10] | Require spread to be stable over last N windows |

---

## 7. Fill model (backtesting)

### 7.1 Spot-like variants (complement-sum, CEX-CEX, ETF-NAV)

Use IOC simultaneously on both legs with realistic ack latency:

```
ack_latency ~ truncated_normal(μ=200ms, σ=50ms, min=20ms, max=2s)
P(partial_fill) = function_of(displayed_depth, your_notional, time_to_first_change_in_book)
```

When `notional / displayed_depth > 0.5`, expect 20-40% partial fill. When
< 0.1, expect <5% partial.

### 7.2 Basis/funding (continuous-hold)

- Spot leg: assume immediate market-order fill at top-of-book ± half-spread.
- Perp leg: same.
- Funding payments: settle at each funding window using `nextFundingRate` snapshot taken 5 seconds before settlement (since exchanges update the realized rate from observed mark at settlement).

### 7.3 Common: liquidation risk simulation

For any basis/funding trade with leverage, simulate intraday vol shocks:
draw `n = 10` shocks per backtest day from your historical regime, each
applied as a ±3σ instantaneous mid-move. If your perp leg liquidates under
any shock, the trade is closed at the liquidation price and PnL adjusted.

---

## 8. Backtest design

### 8.1 Data sources

| Variant | What you need | Source |
|---|---|---|
| CEX-CEX spot | top-of-book bid/ask per second per venue per pair | Tardis.dev, or capture WS live |
| Perp-spot basis | spot mid, perp mid, funding rate (8h or 1h) | Same; dYdX Indexer free for dYdX |
| Funding rate cross-exchange | funding rate history per exchange | dYdX Indexer, Binance, Hyperliquid, OKX APIs |
| Polymarket complement-sum | YES + NO book snapshots per condition per minute | Polymarket WS + REST (free) |
| Polymarket vs CEX | Polymarket book + CEX spot mid | Same + Coinbase WS |

### 8.2 Metrics

- **Net PnL** after all costs (fees, transfer, staleness, partial).
- **Win rate** (% of attempted cycles that closed profitably).
- **Avg edge captured / arb gross** (how much of the apparent gross arb you actually realize).
- **Max consecutive losers** (for stop-loss tuning).
- **Capital utilization** (avg deployed / max capital).
- **Latency-binned edge** — bucket edges by observed-to-ack-ms and confirm you don't have a "fast-arb" survivorship bias.

### 8.3 Walk-forward

Re-tune `min_edge_bps` and `safety_factor` quarterly. Crypto venue
landscape shifts (new venues, fee schedule changes); fixed parameters from
2023 are likely wrong in 2025.

### 8.4 Look-ahead traps

- **Don't use the same WS snapshot for both legs.** That assumes simultaneous observation; reality has venue-to-venue clock skew. Use per-venue WS with separate timestamps.
- **Don't use closing fills as fill prices.** Fill at the *opposite* of the order side's best at the time of order send + ack latency.
- **Don't ignore venue clock skew.** Some venues' "timestamp" is order-receipt, others is matching-engine. Normalize to one clock if you can; otherwise discount your edge by `σ × √(skew)`.

---

## 9. Code skeleton

The repo's `complement-sum-arb.ts` already implements §2.6 cleanly. For
other variants, the same shape applies. Below is a skeleton for the
**general** spot-like arb detector that the engine consumes:

```ts
// src/lib/hft/arb/spot-arb.ts
import type { Venue } from "../venues";
import { evaluateEdge } from "../edge";

export type SpotLeg = {
  venue: Venue;
  bid: number;       // best bid (you'd SELL into this)
  ask: number;       // best ask (you'd BUY from this)
  bidDepthUsd: number;
  askDepthUsd: number;
  feeBpsMaker: number;
  feeBpsTaker: number;
};

export type SpotArbOpportunity = {
  buyVenue: string;
  sellVenue: string;
  buyPrice: number;
  sellPrice: number;
  grossEdgeBps: number;
  netEdgeBps: number;
  maxNotionalUsd: number;
  reason: string;
};

export function detectSpotArb(
  legs: SpotLeg[],
  cfg: { minEdgeBps: number; safetyFactor: number; staleness_bps: number },
): SpotArbOpportunity | null {
  if (legs.length < 2) return null;

  // Best ask to buy from
  const buyLeg = legs.reduce((a, b) => (b.ask < a.ask ? b : a));
  // Best bid to sell into
  const sellLeg = legs.reduce((a, b) => (b.bid > a.bid ? b : a));

  if (buyLeg.venue.name === sellLeg.venue.name) return null;

  const grossEdgeBps = (sellLeg.bid - buyLeg.ask) / buyLeg.ask * 10000;
  if (grossEdgeBps <= 0) return null;

  // Crossing the spread on both legs (IOC). Use taker fees.
  const feesBps = buyLeg.feeBpsTaker + sellLeg.feeBpsTaker;
  const netEdgeBps = grossEdgeBps - feesBps - cfg.staleness_bps;

  if (netEdgeBps < cfg.minEdgeBps) return null;

  const maxNotional = Math.min(buyLeg.askDepthUsd, sellLeg.bidDepthUsd) * cfg.safetyFactor;

  // Final gate via the canonical edge formula.
  const edge = evaluateEdge({
    notionalUsd: maxNotional,
    expectedEdgeBps: grossEdgeBps,
    spreadBps: 0,             // we're not paying spread; it's the arb source
    slippageBps: cfg.staleness_bps / 2,
    latencyPenaltyBps: cfg.staleness_bps / 2,
    adverseSelectionBps: 0,   // arb, not directional
    side: "taker",
    fillsPerDay: 1,
    fillRate: 0.85,           // partial-fill discount
  });
  if (!edge.passes) return null;

  return {
    buyVenue: buyLeg.venue.name,
    sellVenue: sellLeg.venue.name,
    buyPrice: buyLeg.ask,
    sellPrice: sellLeg.bid,
    grossEdgeBps,
    netEdgeBps,
    maxNotionalUsd: maxNotional,
    reason: `buy ${buyLeg.venue.name} @ ${buyLeg.ask}, sell ${sellLeg.venue.name} @ ${sellLeg.bid}, net ${netEdgeBps.toFixed(2)} bps`,
  };
}
```

For basis trades, the existing `src/lib/hft/basis.ts` is the math core; an
engine wrapper that pulls `spot`, `perp`, `nextFundingRate` per venue and
opens/closes via the venue router is the missing piece. Sketch:

```ts
// src/lib/hft/arb/basis-engine.ts
import { computeBasis, type BasisInputs } from "../basis";

export type BasisEntrySignal = {
  asset: string;
  spotVenue: string;
  perpVenue: string;
  side: "long-basis" | "short-basis";
  notionalUsd: number;
  expectedCarryBpsPerDay: number;
};

export function evaluateBasisEntry(
  inputs: BasisInputs & { asset: string; spotVenue: string; perpVenue: string },
  cfg: { entryBasisBps: number; minFundingApr: number; notionalUsd: number },
): BasisEntrySignal | null {
  const r = computeBasis(inputs);
  if (Math.abs(r.basisBps) < cfg.entryBasisBps) return null;
  if (Math.abs(r.fundingApr) < cfg.minFundingApr) return null;
  if (r.preferredLeg === "flat") return null;
  return {
    asset: inputs.asset,
    spotVenue: inputs.spotVenue,
    perpVenue: inputs.perpVenue,
    side: r.preferredLeg,
    notionalUsd: cfg.notionalUsd,
    expectedCarryBpsPerDay: r.carry24hBps,
  };
}
```

---

## 10. Implementation path here

Concrete sequence to extend the repo's arb coverage.

**Step 1 — Generalize complement-sum into a spot-arb engine.** Lift the
`detectSpotArb` shape above into `src/lib/hft/arb/spot-arb.ts`. Existing
`src/lib/strategies/complement-sum-arb.ts` becomes a *caller* that
constructs the two-leg view from a Polymarket binary's YES + NO sides.

**Step 2 — Basis engine.** Add `src/lib/hft/arb/basis-engine.ts` per the
skeleton above. Pulls `spot` from Coinbase WS, `perp` + `nextFundingRate`
from dYdX or Hyperliquid Indexer. Test fixtures in
`tests/unit/basis-engine.test.ts` should cover (a) contango entry, (b)
backwardation entry, (c) funding-flip exit trigger.

**Step 3 — Funding cross-exchange.** Add
`src/lib/hft/arb/funding-spread.ts` that compares same-pair funding rates
across `dydx`, `hyperliquid`, `paradex`. Output is a `FundingSpread` with
buy-side + sell-side venue picks; the executor opens IOC perps on each.

**Step 4 — Wire all three into a unified arb router.** A new file
`src/lib/hft/arb/router.ts` runs all three detectors per tick, ranks by
`netEdgeBps × maxNotionalUsd`, picks the top opportunity that doesn't
conflict with already-open positions, and dispatches to the appropriate
venue adapter via `src/lib/venue/router.ts`.

**Step 5 — UI surface.** Add a panel to `src/app/hft/page.tsx` showing
live arb opportunities and engine state; route metric updates through
`src/app/api/hft/compare/route.ts`.

**Step 6 — Backtests.** For each engine, add a script in `scripts/`:
- `scripts/backtest-spot-arb.ts`
- `scripts/backtest-basis.ts`
- `scripts/backtest-funding-spread.ts`

Outputs land in `docs/*-results.json` (gitignored by `docs/*-results.json`
glob).

**Step 7 — Kill switches.** Each engine registers a `kill()` method with
`src/lib/risk/kill-switch.ts`. On kill, complement-sum closes both legs at
market; basis closes both legs at market and pays whatever spread; funding
cross-exchange closes both legs simultaneously.

---

## 11. Asset-specific gotchas

### Equities (Alpaca)

- **The "arb" available is mostly fee-tier optimization through SOR**, which Alpaca handles for you. Not a strategy you build.
- **ETF NAV arb requires Authorized Participant status.** Out of retail reach.
- **Dual-listed name arb** (e.g. RIO on LSE vs ASX) requires multi-broker, multi-currency setup. Not in scope.
- **Single-name event arb** (merger arb on announced deals) is technically cross-venue (deal price vs market price) but is *event-driven* — see Family 8.

### Crypto spot

- **Withdrawal lockups can swallow your edge.** Pre-fund every venue. Don't try to "chase" inventory.
- **API key permissions matter.** Some venues (Coinbase, Kraken) require explicit "withdraw" permission for cross-venue inventory; lock down that scope until you've validated the engine on a paper account.
- **Tax accounting.** Every cross-venue arb cycle is two trades; FIFO/HIFO accounting can produce wash-sale-like behavior. Talk to a tax person before scaling.

### Crypto perps

- **Initial margin vs maintenance margin matter.** Basis trades sit through funding cycles; if maint-margin tightens during a vol spike, you can be liquidated mid-trade. Use cross-margin where supported; size for 2x maint-margin headroom.
- **Auto-deleveraging (ADL).** When an insurance fund runs dry, profitable positions get force-closed to cover losses. Mitigation: use venues with deep insurance funds (Binance, dYdX); set conservative position sizes.
- **Mark price vs index price.** Some venues liquidate on mark, others on index. The discrepancy can be 50-200 bps during flash events. Know your venue's liquidation rule before sizing.

### Polymarket binaries

- **Already covered in §2.6.** Three callouts:
  - **CFTC/SEC regulatory action** can void markets retroactively. Diversify across markets.
  - **Resolution lag** (UMA dispute period: 48h-1wk). Capital is locked until resolution.
  - **The "fee" Polymarket charges** is the maker rebate diff, not a stated taker fee — read `src/lib/polymarket/category.ts` and the Polymarket fee docs in `docs/polymarket/`.

---

## 12. Open questions worth answering (research directions)

1. **CEX-CEX arb on long-tail pairs** — is there a robust pipeline for the bottom-1000 pairs by volume? They have wider spreads but also more partial-fill risk.
2. **Cross-venue arb with on-chain bridges (LiFi, etc.).** `src/lib/onchain/bridges.ts` exists; can the arb engine actually use it within the latency budget? Probably not for sub-minute arbs; might work for the perp-spot basis if rebalancing.
3. **Polymarket sports/election binaries.** The complement-sum detector currently targets generic binaries; sports markets have different liquidity profiles (concentrated around game-time) and may need a sport-specific detector.
4. **Basis trade with options hedge.** Adding a long-call (or long-put for short-basis) to the basis trade caps the liquidation risk. Currently no options venue is wired; Deribit integration would unlock this.

---

## 13. References

[^regnms]: SEC, Regulation NMS (Rule 611, Order Protection Rule), 2005, updated 2024. [Wikipedia overview](https://en.wikipedia.org/wiki/Regulation_NMS) · [InnReg blog: How Regulation NMS Shapes Equity Execution for Fintechs](https://www.innreg.com/blog/regulation-nms).

[^amber]: Amberdata. "The Ultimate Guide to Funding Rate Arbitrage." [blog.amberdata.io](https://blog.amberdata.io/the-ultimate-guide-to-funding-rate-arbitrage-amberdata).

[^coinglass]: CoinGlass. "What is Funding Rate Arbitrage?" [coinglass.com/learn](https://www.coinglass.com/learn/what-is-funding-rate-arbitrage).

[^etf]: "Cointegration-based pairs trading: identifying and exploiting similar exchange-traded funds." *Journal of Asset Management* (Springer Nature), 2025. [Springer link](https://link.springer.com/article/10.1057/s41260-025-00416-0).

**Other primary sources**
- Liu, J.-H. "High-Frequency Arbitrage and Profit Maximization Across Cryptocurrency Exchanges." Medium, 2024. [medium.com/@gwrx2005](https://medium.com/@gwrx2005/high-frequency-arbitrage-and-profit-maximization-across-cryptocurrency-exchanges-4842d7b7d4d9).
- Gate Learn. "Perpetual Contract Funding Rate Arbitrage Strategy in 2025." [gate.com/learn/articles](https://www.gate.com/learn/articles/perpetual-contract-funding-rate-arbitrage/2166).
- BSIC. "Perpetual Complexity: An Introduction to Perpetual Future Arbitrage Mechanics (Part 1)." [bsic.it](https://bsic.it/perpetual-complexity-an-introduction-to-perpetual-future-arbitrage-mechanics-part-1/).
- ScienceDirect. "Exploring Risk and Return Profiles of Funding Rate Arbitrage on CEX and DEX." [sciencedirect.com](https://www.sciencedirect.com/science/article/pii/S2096720925000818).

**Related modules in this repo**
- `src/lib/strategies/complement-sum-arb.ts` — Polymarket complement-sum (implemented).
- `src/lib/hft/basis.ts` — basis math.
- `src/lib/hft/polymarket-btc.ts` — CEX-implied fair for Polymarket BTC binaries.
- `src/lib/onchain/bridges.ts` — on-chain transfer helpers for inventory rebalancing.
- `src/lib/venue/router.ts` — venue adapter routing the engine sends to.
- `src/lib/hft/edge.ts` — the cost-edge inequality every arb cycle must pass.
- `tests/unit/complement-sum-arb.test.ts` — pattern for arb-detector unit tests.
