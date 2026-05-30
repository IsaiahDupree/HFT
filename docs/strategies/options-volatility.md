# Options & Volatility

> **Family:** 9 — Options & volatility
> **Variants covered:** delta-hedged MM (gamma scalping) · vol surface arbitrage · implied-vs-realized (variance risk premium) · binary option MM (Polymarket as digitals) · skew & term-structure trades · 0DTE options
> **Repo modules:** `src/lib/strategies/vol-scalp.ts` (binary-vol scalp on Polymarket — live); options venue adapter for Alpaca / Deribit not yet wired
> **Cross-asset coverage:** US equities options (Alpaca) · crypto options (Deribit — not in repo) · prediction-market binaries (Polymarket — implemented) · vol-of-vol products (VIX-style, not in repo)

---

## 1. TL;DR

Options give you a *separable* exposure to direction (delta), volatility
(vega), time decay (theta), and convexity (gamma). The strategies in
this family monetize the *non-delta* exposures while staying
direction-neutral.

Six core variants:

1. **Delta-hedged market making / gamma scalping** — sell or buy options, continuously hedge delta with the underlying. Profit if *realized* vol differs from *implied* vol you transacted at. The variance risk premium trade in pure form.
2. **Vol surface arbitrage** — within an asset, different strikes/expiries have different implied vols. The "surface" of IVs has structural patterns (smile, skew, term-structure); deviations from the typical pattern create arb.
3. **Implied vs realized (variance risk premium)** — straight bet that IV > RV on average. Sell variance swaps or strangles; harvest the IV-RV gap.
4. **Binary option MM** — Polymarket and similar markets are *digital* options. The vol surface trade ports: thin books, wide spreads, retail-accessible.
5. **Skew & term-structure trades** — the IV skew (puts more expensive than calls in equities; flat-to-call-skewed in crypto) deviates predictably around macro events.
6. **0DTE** — same-day-expiry options have ~$1T daily notional in SPX/SPY as of 2024. Different dynamics: gamma is enormous, theta bleeds instantly. Separate beast.

**The hard truth about options strategies:** they earn small steady
gains 95% of the time and lose enormously the other 5%. The
unmodeled tail risk is what separates "looks great in backtest" from
"profitable for a decade." Risk-control infrastructure matters more
than alpha discovery.

The repo's existing `src/lib/strategies/vol-scalp.ts` already does the
binary-vol variant on Polymarket. The other variants require an options
venue adapter that doesn't yet exist.

---

## 2. Mechanism

### 2.1 The Greeks crash-course (just enough to navigate)

For an option (call or put) with price `V` as a function of underlying
price `S`, volatility `σ`, time `t`, and rates `r`:

| Greek | Definition | Intuition |
|---|---|---|
| **Delta** | `∂V/∂S` | Sensitivity to underlying price. Calls: 0 to +1. Puts: -1 to 0. |
| **Gamma** | `∂²V/∂S²` | Rate of change of delta. Always positive for long options; tells you how fast delta changes as `S` moves. |
| **Vega** | `∂V/∂σ` | Sensitivity to volatility. Long options are long vega. |
| **Theta** | `∂V/∂t` | Time decay. Long options bleed value as time passes. |
| **Rho** | `∂V/∂r` | Sensitivity to interest rates. Usually small except on long-dated. |

**Delta hedging:** sell `N` calls, buy `N × delta` of underlying. The
net position is delta-zero — small underlying moves don't change PnL
*from delta*. But you're still exposed to vega, theta, gamma. The
*difference* between realized and implied vol, integrated through gamma,
is your PnL.

### 2.2 Gamma scalping (the canonical delta-hedged MM trade)

**Position:** long N straddles (long call + long put at same strike) →
long vega, long gamma, short theta.

**The math:**
- Each tick, the underlying moves Δ`S`.
- Your delta changed by `gamma × ΔS` over the move.
- Re-hedge: buy/sell `gamma × ΔS` of underlying.
- Each re-hedge is a "buy low, sell high" or "sell high, buy low" → small PnL realization.

**Aggregated:** the realized PnL from gamma re-hedging = `0.5 × gamma ×
ΔS² × N`. Summed over the option's life:

```
gamma_PnL = ∫ 0.5 × Γ(t) × σ²_realized(t) × S² dt
theta_drag = ∫ Θ(t) dt
net_PnL = gamma_PnL + theta_drag
```

Long straddle PnL goes positive if `σ²_realized > σ²_implied`. That's
the bet.[^schwab_gamma]

**MM variant:** instead of going long-only, the MM *sells* options at
the ask and *buys* them at the bid. The MM's net position is hedged
delta-neutral; their PnL = spread captured × number of options traded −
(any realized vs implied vol exposure × hedging cost).

A well-tuned options MM earns ~3-8 bps per option round-trip *plus or
minus* the IV-RV gap on the unwound inventory.

**Reality check:** options spreads have compressed dramatically; this
is mostly an institutional-MM trade. Retail playing this in equity
options usually fails to capture enough spread to offset transaction
costs. Crypto options (Deribit) have wider spreads and remain
accessible.[^resonanz2024]

### 2.3 Vol surface arbitrage

For a single underlying, options at different strikes/expiries form a
*surface* in `(strike, time-to-expiry, IV)` space. The surface has
structural patterns:

- **Smile / smirk**: OTM puts and calls usually have higher IV than ATM. Equities: puts > calls (negative skew). Crypto: often flat or call-skewed.
- **Term structure**: IV varies with expiry; usually upward-sloping (longer expiry = higher IV) in calm markets, inverted near events.
- **No-arbitrage constraints**: prices must satisfy butterfly inequality, calendar inequality, etc. Violations = arb.

**Trades:**
- **Butterfly arb**: if a call butterfly (long lower strike, short 2× middle strike, long upper strike) costs *negative* (i.e., you receive premium), that's pure arbitrage — the position has positive payoff in all scenarios. Mostly seen on illiquid strikes; rare on liquid.
- **Calendar arb**: a long-dated option costs less than a short-dated option of the same strike. Almost never happens; if it does, buy the cheap one, sell the dear.
- **Skew normalization**: when skew deviates from its typical level (e.g. equity-put skew during a panic), trade it back: sell expensive puts vs. ATM, expect skew to compress.

**Where this works:**
- Equities: butterflies and calendars are mostly auto-arbed; skew trades are a slower, more interesting alpha source.
- Crypto: Deribit's IV surface has structural anomalies; less competition than equities.

### 2.4 Implied vs Realized (Variance Risk Premium)

The persistent observation: across most markets, `IV > RV` on average.
The difference is the "variance risk premium" (VRP).[^carr2009]

**Why it persists:**
- Risk-averse investors *demand* protection (long puts, long calls for hedging directional exposure); they pay a premium for it.
- Variance / vol is a real exogenous risk; risk-averse market-makers demand compensation for taking it.

**Magnitude:** VRP on SPX is typically 3-5 vol points (e.g. RV 15%, IV
18-20%). The premium is bigger during low-vol regimes and *compresses
or inverts* during high-vol regimes.

**Trades:**
- **Sell ATM straddles, delta-hedge**: harvest VRP directly. Annual return 8-15% on capital with Sharpe 1.0-2.0 *until* a tail event; max-loss events historically exceed -800% of position notional.[^quantpedia_vrp]
- **Sell variance swaps**: cleaner exposure to VRP than straddles; institutional only.
- **VIX / VVIX trades**: VIX futures roll yield captures VRP indirectly; expensive (TVIX, UVXY decay) but accessible to retail.

**Hedging the tail:** the only way to make VRP-harvesting honest is
to buy deep OTM puts as catastrophe insurance. Reduces the gross VRP
but caps the tail loss.

### 2.5 Binary option market making (Polymarket digitals)

Polymarket binary outcomes — "Will BTC be above $X at time T" — are
*digital options*: payoff = $1 if condition holds, $0 otherwise.

Black-Scholes digital option price:

```
C_digital = exp(-r × T) × N(d2)
            where d2 = [ln(S/K) + (r - σ²/2)T] / (σ × √T)
```

This gives a "fair" implied probability. Polymarket prices often
diverge from BS-fair because:
- Liquidity premium (thin books).
- Resolution uncertainty (regulatory / UMA dispute risk).
- Behavioral biases (event narratives skew prices).

`src/lib/strategies/vol-scalp.ts` exploits this by computing BS-implied
fair from current CEX price and σ, then trading against Polymarket's
diverging quote.

**Variants implementable on top:**
- **Skew between adjacent strikes** on Polymarket multi-strike events ("BTC above $73k AND BTC above $74k AND ..."). The implied skew between adjacent strikes is a tradeable mispricing.
- **Term-structure arb across events** on different resolution dates targeting the same kind of event.

### 2.6 Skew and term-structure trades

**Equity skew** (post-1987):
- OTM puts trade at higher IV than ATM or OTM calls.
- The "skew" widens during fear, compresses during complacency.
- Skew-normalization trade: when skew is at the 90th percentile of historical, sell put-skew (e.g. sell OTM puts vs. buy ATM puts in a put-spread structure). Expect skew to compress.

**Crypto skew**:
- BTC historically had *positive* skew (calls richer than puts) during bull markets — opposite of equities.
- Recently this has flattened or inverted.
- Trade: when call-skew is at historical extreme, sell calls vs ATM.

**Term-structure trades:**
- IV curve is upward-sloping in calm markets, often inverted during events.
- "Curve trade": sell front-month, buy 2nd-month → harvest the contango of vol-of-time-to-expiry.

### 2.7 0DTE — Same-day-expiry options

SPX 0DTE expanded from 3 expiries/week in 2022 to 5 expiries/week
(Mon-Fri) in 2024. Daily notional traded: $1T+.[^resonanz2024]

**Distinct features:**
- Gamma is *enormous* near expiry; small underlying moves cause large delta changes.
- Theta decays to zero linearly through the day.
- Used by retail for short-dated bets; used by institutions for gamma exposure to intraday moves.

**Trades:**
- **0DTE gamma scalping** (buying the gamma) — pure realized-vs-implied vol play, intra-day.
- **0DTE strangle selling** — harvest the theta into close; tail risk concentrated to a single day.
- **0DTE dispersion** (sell index 0DTE vol, buy single-name 0DTE vol) — bet that index vol underperforms basket-of-singles vol.

**Reality:** 0DTE PnL distribution is the most extreme — biggest
single-day Sharpe in any options strategy, but biggest single-day
disasters. Retail bias: bet small.

---

## 3. Where it works

| Variant | Venue | Verdict | Notes |
|---|---|---|---|
| Gamma scalping (long-vol) | Deribit BTC/ETH options | ⚠️ | Spreads tighter than 2021; vol mostly meets implied |
| Gamma scalping (long-vol) | Alpaca equity options | ❌ for retail | Spreads compressed; transaction costs dominate |
| Options MM (sell + hedge) | Deribit | ⚠️ institutional | Optiver, Genesis, Wintermute dominate |
| Options MM | Alpaca | ❌ | Wholesale market-makers internalize 90% of retail flow |
| Vol surface arb (butterflies/calendars) | Anywhere | ⚠️ rare | Mostly auto-arbed; appears in illiquid strikes |
| Skew normalization | SPX, BTC | ✅ | Slower edge; persistent |
| Variance risk premium (sell IV) | SPX, BTC, ETH | ⚠️ tail risk | Requires hedging; otherwise blow-up risk |
| Polymarket binary MM | Polymarket | ✅ | Implemented in vol-scalp.ts |
| 0DTE strangle sell | SPX options | ⚠️ tail risk | Capacity high; risk concentrated |
| 0DTE dispersion | SPX vs basket | ⚠️ institutional | Requires multi-leg execution + larger capital |

**Capital scale:**
- Deribit options MM: $100k+ for meaningful capacity.
- Skew/VRP harvesting (with tail hedge): $50k+ on equities, $25k+ on crypto.
- Polymarket binaries: $500-$10k (capacity-bounded).
- 0DTE: $10k+ but small position size.

---

## 4. Edge magnitude

| Variant | Typical edge | Annualized return | Sharpe (before tail) | Notes |
|---|---|---|---|---|
| Gamma scalping (Deribit BTC/ETH, retail) | 0-2% per option | 5-15% | 0.5-1.0 | Edge thin; competition heavy |
| Skew normalization (SPX puts) | 1-3 vol pts per cycle | 8-15% | 0.8-1.5 | Slow; capital-efficient |
| VRP harvesting (SPX, hedged) | 2-4 vol pts realized | 6-12% | 1.0-2.0 (until tail) | Tail destroys decade in a day |
| VRP harvesting (BTC, Deribit) | 3-8 vol pts realized | 10-25% | 0.8-1.5 | More vol of vol than equities |
| Polymarket binary MM (vol-scalp) | 50-300 bps per cycle | 30-100% | 1.0-3.0 | Capacity-bounded |
| 0DTE strangle sell | 0.5-2% premium per day | 50-150% annualized (if no blow-up) | 1.5-3.0 in calm | Tail concentration |
| 0DTE dispersion | 5-15 bps per trade | 8-20% | 0.6-1.2 | Multi-leg complexity |

**The tail-event reality:** vol-selling strategies typically show 12+
months of profitable backtests *before* the first big loss. Don't be
fooled. Position size assuming the next 10-σ event happens next month.

---

## 5. What kills it

Ranked by frequency for tail-exposed strategies.

1. **Single-day tail event.** A 5σ move on a 1× leveraged short-strangle erases years of premium-collection. Mitigation: long OTM puts as cat-insurance; cap position size at "I can lose 100% of it."
2. **Vol-of-vol spikes.** Even if your delta-hedging is perfect, sudden IV spikes (VIX from 15 to 40 in a day) hammer short-vol positions through vega. Mitigation: short vega ≤ 30% of equity; long-vega hedge.
3. **Skew direction wrong.** You sold put-skew expecting normalization; instead, fear deepens and skew widens further. Mitigation: stop-loss on skew at 95th percentile.
4. **Transaction costs on hedge re-balances.** Gamma scalping requires N hedges per day; each costs spread + commission. A 20-rebalance day on tight-spread underlyings = 20× hedge cost; can dominate gamma PnL on small notional.[^profitmart]
5. **Pin risk.** Options expiring at-the-money have undetermined exercise; one side or the other gets unexpectedly assigned. Mitigation: close ATM options before expiry; don't carry through.
6. **Margin call cascades.** Brokerage margin requirements scale with portfolio vol; a vol spike triggers margin call right when you need cash for hedging. Mitigation: portfolio-margin account with substantial reserve.
7. **Polymarket-specific: resolution risk.** Binary MM positions carry through resolution; an ambiguous resolution voids the trade. Mitigation: close MM inventory N hours before resolution.
8. **Liquidity disappearing.** During regime shifts, options books vanish; closing a position requires crossing wide spreads. Mitigation: position sizing such that you can hold to expiry if needed.

---

## 6. Parameters

A unified options strategy module per variant.

### 6.1 Gamma scalping / options MM

| Param | Units | Default | Range | Purpose |
|---|---|---|---|---|
| `target_vega_usd_per_pct_vol` | USD | 1000 | [100, 100_000] | Total vega exposure cap |
| `hedge_band_delta` | dimensionless | 0.05 | [0.01, 0.20] | Re-hedge when net delta exceeds |
| `min_iv_rv_ratio_to_long_vega` | dimensionless | 0.95 | [0.7, 1.1] | Buy options if IV/RV < this |
| `max_iv_rv_ratio_to_short_vega` | dimensionless | 1.30 | [1.0, 2.0] | Sell options if IV/RV > this |
| `min_dte` | days | 7 | [1, 60] | Skip too-near expiries (theta domination) |
| `max_dte` | days | 90 | [7, 365] | Skip too-far (low gamma) |
| `transaction_cost_bps` | bps | 5 | [0, 50] | Estimated hedge cost |
| `pause_during_vol_event` | bool | true | — | Halt around macro prints |

### 6.2 Variance risk premium harvesting

| Param | Units | Default | Range | Purpose |
|---|---|---|---|---|
| `entry_iv_premium_ratio` | dimensionless | 1.15 | [1.05, 1.50] | Sell vol if IV ≥ ratio × trailing RV |
| `strike_offset_atm_pct` | percent | 0 (ATM) | [0, 5] | OTM offset for strangles |
| `expiry_days` | days | 30 | [7, 90] | Tenor |
| `tail_hedge_otm_pct` | percent | 10 | [3, 30] | OTM put as cat-insurance |
| `tail_hedge_size_pct` | percent | 25 | [10, 100] | Hedge size as % of short premium |
| `max_short_vega_usd` | USD | 50_000 | [1_000, 1_000_000] | Total short-vega cap |
| `stop_loss_at_vix` | VIX level | 40 | [25, 60] | Hard stop if VIX exceeds |

### 6.3 Skew normalization

| Param | Default | Range | Purpose |
|---|---|---|---|
| `skew_metric_percentile_entry` | 90 | [70, 99] | Enter at percentile of historical |
| `skew_metric_percentile_exit` | 50 | [30, 80] | Close at percentile |
| `expiry_target_days` | 30 | [7, 90] | Tenor |
| `position_vega_usd` | 10_000 | [1_000, 100_000] | Per-trade size |

### 6.4 Polymarket binary MM / vol-scalp (existing implementation)

(See `src/lib/strategies/vol-scalp.ts` for actual production defaults.)

| Param | Default | Range | Purpose |
|---|---|---|---|
| `min_edge_bps` | 50 | [10, 500] | Min mispricing to act |
| `time_to_resolution_min` | 10 | [1, 1440] | Resolution-window filter |
| `max_position_per_market_usd` | 200 | [10, 10_000] | Per-market cap |
| `cex_implied_confidence_cutoff` | 0.85 | [0.60, 0.99] | Skip if CEX-implied prob outside [1-cutoff, cutoff] |

### 6.5 0DTE

| Param | Default | Range | Purpose |
|---|---|---|---|
| `entry_time_window` | "10:30-15:30 ET" | — | Trade only mid-day (open + close are too gappy) |
| `strike_offset_atm_pct` | 0.5 | [0.1, 3.0] | Strangle offset |
| `max_loss_per_trade_pct_capital` | 1 | [0.1, 5.0] | Per-trade stop |
| `max_concurrent_0dte` | 3 | [1, 20] | Concurrency |
| `close_by_time` | "15:55 ET" | — | Hard close before close-cross |

---

## 7. Fill model (backtesting)

### 7.1 Option fills

Use IOC limit at mid + small offset. For backtest:

```
P(fill at mid) = 0.4
P(fill at mid + 0.5 × spread) = 0.5
P(no fill) = 0.1
```

For illiquid strikes (deep OTM), reduce all probabilities by 50%.

### 7.2 Hedge fills (underlying)

Same as standard equity/crypto fill model. Use TWAP for hedge slugs >
$10k notional; market for smaller.

### 7.3 Pin-risk injection

For backtesting expiry events: if your option ends within 0.5 × ATM
straddle distance from the strike, randomly assign with 50% probability.
Compute the resulting cash-or-asset flow.

### 7.4 Vol-event injection

Inject a vol spike (`+10 vol pts` in single day) randomly with
`p = 0.02` per backtest month. Models the events real history
underrepresents.

### 7.5 Counterparty / liquidity injection

For backtests of strategies relying on liquidity at expiration (e.g.
close a strangle 1 hour before expiry), inject `P(no liquidity) = 0.05`
that forces you to hold to expiry.

---

## 8. Backtest design

### 8.1 Data

| Variant | Data | Source |
|---|---|---|
| Gamma scalping, IV-RV strategies | Full IV surface history per asset (per strike, per expiry, per day) + underlying tick | OptionMetrics (paid), Deribit history API (free), CBOE (paid) |
| Vol surface arb | Same | Same |
| VRP harvesting | IV history + realized-vol estimates | Same; realize-vol from underlying ticks |
| Skew normalization | Skew metric history (often 25Δ put IV − 25Δ call IV) | Same |
| Polymarket | Per-market book + CEX price + resolution | Polymarket WS + Coinbase WS |
| 0DTE | Intraday IV per strike + underlying tick | Mostly CBOE / vendor; sparse historical pre-2023 |

### 8.2 Metrics

- **Per-trade PnL distribution** — skew is everything. Vol strategies have negative skew (small wins, big losses).
- **Tail-conditional return**: average return on worst 5% of months.
- **Max drawdown event**: not just magnitude, but recovery time.
- **Sharpe with bootstrap confidence interval**: tail-heavy distributions have wide CI; report it.
- **Calmar ratio** (CAGR / max DD) — better than Sharpe for tail-heavy strategies.

### 8.3 Walk-forward

Quarterly. Vol regimes shift; parameters fit on 2020-2021 are likely
wrong for 2025.

### 8.4 Look-ahead traps

- **Don't use the post-expiry "true" realized vol** to gate entries. Use only RV computable from data up to entry time.
- **Don't backtest with constant vol-of-vol assumption.** Inject realistic vol-of-vol regimes.
- **Don't ignore weekends / market closure** — IV ticks down across closed periods predictably; this affects strategy gross-of-cost edge.

---

## 9. Code skeleton

The repo already has `src/lib/strategies/vol-scalp.ts` for binary
option MM. Below is skeleton for **delta-hedged gamma scalping** —
the most-applicable additional variant once an options venue adapter
is wired.

### 9.1 Greeks utility — `src/lib/strategies/options/greeks.ts`

```ts
// Black-Scholes pricing + Greeks. Pure functions.

export type BSInputs = {
  spotPrice: number;
  strike: number;
  ttExpiryYears: number;
  riskFreeRate: number;          // continuously compounded
  volatility: number;            // annualized, e.g. 0.20 for 20%
  type: "call" | "put";
};

export type BSGreeks = {
  price: number;
  delta: number;
  gamma: number;
  vega: number;     // per 1pp vol change
  theta: number;    // per day
};

function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}
function erf(x: number): number {
  // Abramowitz & Stegun approximation
  const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
  const a4 = -1.453152027, a5 =  1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

export function blackScholes(inp: BSInputs): BSGreeks {
  const { spotPrice: S, strike: K, ttExpiryYears: T, riskFreeRate: r, volatility: σ, type } = inp;
  if (T <= 0) {
    const intrinsic = type === "call" ? Math.max(0, S - K) : Math.max(0, K - S);
    return { price: intrinsic, delta: type === "call" ? (S > K ? 1 : 0) : (S < K ? -1 : 0), gamma: 0, vega: 0, theta: 0 };
  }
  const d1 = (Math.log(S / K) + (r + 0.5 * σ * σ) * T) / (σ * Math.sqrt(T));
  const d2 = d1 - σ * Math.sqrt(T);
  let price: number, delta: number, theta: number;
  if (type === "call") {
    price = S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
    delta = normCdf(d1);
    theta = (-S * normPdf(d1) * σ / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * normCdf(d2)) / 365;
  } else {
    price = K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
    delta = normCdf(d1) - 1;
    theta = (-S * normPdf(d1) * σ / (2 * Math.sqrt(T)) + r * K * Math.exp(-r * T) * normCdf(-d2)) / 365;
  }
  const gamma = normPdf(d1) / (S * σ * Math.sqrt(T));
  const vega = S * normPdf(d1) * Math.sqrt(T) / 100;  // per 1pp
  return { price, delta, gamma, vega, theta };
}

/** Solve for implied vol via Newton's method given a market price. */
export function impliedVol(marketPrice: number, inp: Omit<BSInputs, "volatility">, initialGuess = 0.3): number {
  let σ = initialGuess;
  for (let i = 0; i < 50; i++) {
    const greeks = blackScholes({ ...inp, volatility: σ });
    const diff = greeks.price - marketPrice;
    if (Math.abs(diff) < 1e-6) return σ;
    const vega = greeks.vega * 100;  // back to per-1.0
    if (vega < 1e-10) break;
    σ -= diff / vega;
    if (σ < 0.001) σ = 0.001;
    if (σ > 5) σ = 5;
  }
  return σ;
}
```

### 9.2 Gamma scalping engine — `src/lib/strategies/options/gamma-scalp.ts`

```ts
import { blackScholes, type BSGreeks } from "./greeks";

export type OptionPosition = {
  optionSymbol: string;
  strike: number;
  ttExpiryYears: number;
  type: "call" | "put";
  qty: number;                  // contracts (positive = long)
  entryIv: number;
  entryPrice: number;
};

export type ScalpState = {
  position: OptionPosition;
  underlyingPriceLastHedge: number;
  underlyingDeltaHeld: number;  // shares of underlying held for hedge
  realizedGammaPnl: number;
  thetaDecay: number;
};

export type ScalpDecision =
  | { kind: "rehedge"; deltaShift: number; targetQty: number }
  | { kind: "noop" }
  | { kind: "close"; reason: string };

export type ScalpCfg = {
  hedgeBandDelta: number;       // re-hedge when |net delta| > this
  maxLossPctNotional: number;   // close at this loss
  closeOnIvRvBreakdown: boolean; // close if IV drops below realized post-entry
};

export function gammaScalpDecide(
  state: ScalpState,
  currentSpot: number,
  currentIv: number,
  riskFreeRate: number,
  cfg: ScalpCfg,
): ScalpDecision {
  const g: BSGreeks = blackScholes({
    spotPrice: currentSpot,
    strike: state.position.strike,
    ttExpiryYears: state.position.ttExpiryYears,
    riskFreeRate,
    volatility: currentIv,
    type: state.position.type,
  });

  // Net delta = position delta × qty + held hedge
  const netDelta = g.delta * state.position.qty * 100 + state.underlyingDeltaHeld;  // ×100 for shares-per-contract
  if (Math.abs(netDelta) > cfg.hedgeBandDelta * Math.abs(state.position.qty * 100)) {
    const target = -(g.delta * state.position.qty * 100);   // desired hedge
    const deltaShift = target - state.underlyingDeltaHeld;
    return { kind: "rehedge", deltaShift, targetQty: target };
  }

  // PnL check
  const mtm = g.price * state.position.qty - state.position.entryPrice * state.position.qty;
  const notional = Math.abs(state.position.qty) * state.position.entryPrice;
  if (mtm < -cfg.maxLossPctNotional / 100 * notional) {
    return { kind: "close", reason: "max-loss threshold" };
  }

  if (cfg.closeOnIvRvBreakdown && currentIv < state.position.entryIv * 0.85) {
    return { kind: "close", reason: "IV decayed below 85% of entry" };
  }

  return { kind: "noop" };
}
```

### 9.3 VRP harvest — `src/lib/strategies/options/vrp.ts`

```ts
export type VrpEntrySignal = {
  asset: string;
  ivPremium: number;            // IV - RV in vol points
  proposedStructure: "atm_straddle" | "10pct_strangle";
  expiryDays: number;
  tailHedgeOtmPct: number;
  estimatedAnnualReturn: number;
};

export function evaluateVrpEntry(
  currentIv: number,
  trailingRv: number,
  cfg: { entryRatio: number; expiryDays: number; tailHedgeOtmPct: number },
): VrpEntrySignal | null {
  if (currentIv < trailingRv * cfg.entryRatio) return null;
  const ivPremium = currentIv - trailingRv;
  const annualReturn = ivPremium * (365 / cfg.expiryDays);  // crude
  return {
    asset: "SPX",  // example
    ivPremium,
    proposedStructure: "10pct_strangle",
    expiryDays: cfg.expiryDays,
    tailHedgeOtmPct: cfg.tailHedgeOtmPct,
    estimatedAnnualReturn: annualReturn,
  };
}
```

---

## 10. Implementation path here

1. **Add `src/lib/strategies/options/` directory** with the three modules in §9.
2. **Add options venue adapter** — `src/lib/venue/adapters/alpaca-options.ts` for equity options (Alpaca added options trading in 2024), or `deribit.ts` for crypto options.
3. **Wire to `src/lib/hft/venues.ts`** — add options venues with fee schedules.
4. **Add IV history loader** — `scripts/fetch-iv-history.ts` pulls IV surface from data vendor, persists to `data/iv-surface.db` or similar.
5. **Backtest harness:**
   - `scripts/backtest-gamma-scalp.ts` — replay historical IV + underlying ticks; simulate hedge cost.
   - `scripts/backtest-vrp.ts` — historical IV vs realized; tail-injection backtest.
6. **UI surface:** `/hft/vol` page showing live IV surface for tracked assets, current VRP, active gamma-scalp positions.
7. **Tests:**
   - `tests/unit/black-scholes.test.ts` — Greeks vs textbook values; implied-vol Newton solver convergence.
   - `tests/unit/gamma-scalp.test.ts` — rehedge decision logic; close-on-IV-breakdown.
   - `tests/unit/vrp.test.ts` — entry threshold logic; tail-hedge sizing.
   - `tests/integration/gamma-scalp-flow.test.ts` — mock options venue → end-to-end scalp cycle.
8. **Risk integration:** vol-strategy positions go through `src/lib/risk/kill-switch.ts` with vol-specific guards (vega cap, gross-vega-by-asset, VIX-level kill).
9. **Capsule wiring:** options strategies opt into the agentic-layer allocator just like other families; the allocator routes capital based on risk-adjusted arena performance.

---

## 11. Asset-specific gotchas

### US equity options (Alpaca)

- **PDT rule** applies to options too; <$25k account = 4-day-trades-per-5-day rolling.
- **Wholesalers route 90% of retail flow** — your fill quality is usually fine, but you don't see the inside quote that wholesalers see. Spread on your screen is wider than the *real* inside.
- **Earnings IV crushes** are aggressive; long-vol positions into earnings often lose despite "correct" direction.
- **Pin risk** at expiry: equities can pin at strikes; check for unusual concentration in OI at ATM strikes the day of expiry.

### Crypto options (Deribit)

- **Settlement in coin, not USD.** Deribit ETH options settle in ETH; price-of-ETH risk slips into PnL even on supposedly delta-hedged positions if you don't hedge the coin denomination.
- **Wider IV surfaces** than equities; more opportunity for vol surface arb but also more noise.
- **Funding-rate-like effect from perpetual options** (some venues have these now); not yet standardized.

### Polymarket binaries (the implemented variant)

- Already covered in vol-scalp.ts.
- Key gotcha: **resolution lag**. Markets can take days/weeks to resolve due to UMA dispute window.

### 0DTE

- **Theta acceleration through the day.** A 0DTE strangle sold at 10:00 ET decays predictably through 15:55 ET.
- **Power-hour vol** (15:00-16:00 ET on SPX) is the peak realized-vol window; close strangles before unless you're committed to holding through.
- **Hedge slippage** is huge at the close (closing auction prints big); plan hedges to avoid 15:55-16:00 ET.

---

## 12. Open questions worth answering (research directions)

1. **Polymarket multi-strike skew arb.** Markets like "BTC price range" expose adjacent strikes; the implied skew between them is sometimes mispriced. Worth a systematic backtest.
2. **Deribit BTC term-structure trade.** When near-month IV inverts vs 2-month, calendar-spread harvest can be profitable. Capacity ~$50k-$500k.
3. **Crypto VRP timing.** Equity VRP is stable; crypto VRP regime-shifts more often (bull markets compress; bear markets expand). Build a regime classifier.
4. **0DTE dispersion on SPX vs single-name ETFs (XLF, XLE, etc.).** When index vol underperforms basket vol, sell index 0DTE, buy basket 0DTE.
5. **LLM-tagged news + vol prediction.** Could an LLM-driven event-tagger (cf. `src/lib/agents/oracle-llm.ts`) predict IV surface moves around news events?

---

## 13. References

[^schwab_gamma]: Charles Schwab. "What Is Gamma Scalping?" [schwab.com/learn](https://www.schwab.com/learn/story/gamma-scalping-primer) · MenthorQ guide [menthorq.com/guide/gamma-scalping-and-delta-hedging](https://menthorq.com/guide/gamma-scalping-and-delta-hedging/).

[^carr2009]: Carr, P., & Wu, L. (2009). "Variance Risk Premia." *Review of Financial Studies* 22(3), 1311-1341. [Bloomberg/NYU PDF](https://engineering.nyu.edu/sites/default/files/2019-01/CarrReviewofFinStudiesMarch2009-a.pdf).

[^quantpedia_vrp]: Quantpedia. "Volatility Risk Premium Effect." [quantpedia.com/strategies](https://quantpedia.com/strategies/volatility-risk-premium-effect) — includes the historical -800% tail-loss warning.

[^resonanz2024]: Resonanz Capital. "Same-Day Options, Same-Day Alpha? Institutional Lessons from 0DTE's Boom." [resonanzcapital.com/insights](https://resonanzcapital.com/insights/same-day-options-same-day-alpha-institutional-lessons-from-0-dtes-boom).

[^profitmart]: Profitmart. "Gamma Scalping: Real-Time Delta & Gamma Hedging Techniques." [profitmart.in/blog](https://profitmart.in/blog/gamma-scalping-and-hedging/) — practitioner overview.

**Other primary sources**
- AFA Journal. "Where does gamma hedge drive the intraday market move?" (June 2024). [afajof.org](https://afajof.org/management/viewp.php?n=129472).
- OptionVisualizer. "Gamma Scalping & Delta Hedging." [optionvisualizer.com/documentation](https://www.optionvisualizer.com/documentation/strategies/gamma-scalping).
- Cube Exchange. "What Is Gamma Scalping?" [cube.exchange/what-is](https://www.cube.exchange/what-is/gamma-scalping-strategies).
- QuantStrategy.io. "Gamma Scalping Strategy: Profiting from Changes in Option Delta and Market Movement." [quantstrategy.io/blog](https://quantstrategy.io/blog/gamma-scalping-strategy-profiting-from-changes-in-option/).
- Predicting Alpha. "Understanding Implied Volatility vs. Realized Volatility in Options Trading." [predictingalpha.com](https://www.predictingalpha.com/implied-vs-realized-volatility/).
- Macrosynergy. "Realistic volatility risk premia." [macrosynergy.com](https://macrosynergy.com/research/realistic-volatility-risk-premia/).
- The Hedge Fund Journal. "Harvesting the S&P 500 Volatility Risk Premium." [thehedgefundjournal.com](https://thehedgefundjournal.com/harvesting-the-s-p-500-volatility-risk-premium/).
- Imperial College London. "Harvesting Volatility Risk Premium." (Lu Shibo 2024 dissertation.) [imperial.ac.uk](https://www.imperial.ac.uk/media/imperial-college/faculty-of-natural-sciences/department-of-mathematics/math-finance/Shibo_Lu_01210524.pdf).

**Related modules in this repo**
- `src/lib/strategies/vol-scalp.ts` — Polymarket binary vol-scalp (live).
- `src/lib/strategies/orderbook-imbalance.ts` — useful as confirm-signal for entries on binary MM.
- `src/lib/hft/polymarket-btc.ts` — BS-style fair-value computation for Polymarket binaries (used by vol-scalp).
- event-driven.md §2.2 — pre-print vol-selling overlaps with VRP harvesting; cross-reference.
- microstructure-signals.md §2.5 (VPIN) — kill-switch input for vol-selling around toxic-flow regimes.
- execution-algos.md — IS executor with options-aware fill model for entering complex option spreads.
