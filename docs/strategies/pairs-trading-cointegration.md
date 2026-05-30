# Pairs Trading via Cointegration

> **Family:** 3 — Statistical arbitrage (pairs / cointegration / mean-reversion)
> **Variants covered:** Engle-Granger pairs · Johansen baskets · ETF pair arb · cross-asset pairs (equity vs commodity proxy) · lead-lag pairs · Ornstein-Uhlenbeck-fitted spread trading
> **Repo modules:** *none yet — this doc seeds the implementation*
> **Cross-asset coverage:** US equities (Alpaca) · ETFs · crypto spot (Coinbase, others) · cross-asset pairs

---

## 1. TL;DR

Two assets that historically move together but currently disagree will, on
average, agree again. Buy the laggard, short the leader, wait for them to
re-converge.

The strategy works if and only if the *spread* between the two prices is
**cointegrated** — formally stationary, informally mean-reverting on a
predictable timescale. Most apparent pairs are not cointegrated; selection
is the entire game.

The three pillars:

1. **Selection.** Use a statistical test (Engle-Granger ADF, or Johansen
   for baskets) to find pairs whose spread is stationary, then fit an
   Ornstein-Uhlenbeck model to estimate the *half-life* of mean reversion.
2. **Sizing.** Hedge ratio `β` from the cointegrating regression: short
   `1 unit` of A and long `β units` of B (or vice versa).
3. **Trading.** Enter at z-score > 2σ (the spread is "too far"), exit at
   z-score < 0.5σ (it's reconverged). Hard-stop at z-score > 4σ
   (cointegration probably broke).

Latency tier: **T3-T4.** Half-lives are typically hours to days. This is
a strategy you can run from a laptop on a 1-minute cadence and still
beat the median quant fund's Sharpe in the family.

---

## 2. Mechanism

### 2.1 Cointegration — what it formally means

Two non-stationary price series `x_t` and `y_t` are **cointegrated** if
there exists a constant `β` such that:

```
spread_t = y_t − β · x_t
```

is **stationary** (mean-reverting around a constant) even though `x_t` and
`y_t` individually wander forever.

Cointegration ⊋ correlation. Correlated series can drift apart
permanently (BTC and ETH are correlated in returns but their *log-price
ratio* can drift for years). Cointegrated series cannot drift apart
permanently by definition.

### 2.2 Engle-Granger: the workhorse test

The two-step procedure[^eg1987] for testing whether two series are
cointegrated:

**Step 1 — Run OLS:**

```
y_t = α + β · x_t + ε_t
```

`β` is the **hedge ratio** (also called the cointegrating coefficient).

**Step 2 — Test the residual `ε̂_t = y_t − α̂ − β̂ · x_t` for stationarity:**

Use the Augmented Dickey-Fuller (ADF) test on `ε̂`. If the ADF
p-value is below your threshold (commonly `0.05`), reject the unit-root
null and conclude `ε̂` is stationary → the pair is cointegrated.

**Asymmetry.** OLS treats `y` as the dependent variable. Reversing the
regression (`x` on `y`) gives a *different* `β`. Production pipelines run
the test in both directions and use the one with the smaller ADF p-value,
or use Johansen (which is symmetric).

### 2.3 Johansen: for baskets of more than two

Johansen[^j1988] generalizes to `n ≥ 2` series and is symmetric (no
"dependent" variable). It fits a Vector Error Correction Model (VECM):

```
Δy_t = Π · y_{t−1} + Σ Γ_i · Δy_{t−i} + ε_t
```

The rank of `Π` equals the number of cointegrating relationships. Two
likelihood-ratio tests (trace and maximum-eigenvalue) test the null of
rank ≤ r vs rank > r.

**Use Johansen when:**
- You have a basket of 3+ assets (e.g. three-stock pair on dual-listed names).
- You want a symmetric test (no arbitrary "dependent" choice).
- You need to identify multiple cointegrating vectors in the same basket.

**Use Engle-Granger when:**
- You have exactly 2 assets and want the simplest pipeline.
- Your `β` interpretation needs to be unambiguous (Johansen produces a
  cointegrating matrix that can be hard to interpret economically).

### 2.4 Modeling the spread as Ornstein-Uhlenbeck

Once cointegration is established, model the spread `s_t = y_t − β · x_t`
as an Ornstein-Uhlenbeck (OU) process:

```
ds_t = θ · (μ − s_t) · dt + σ · dW_t
```

where:
- `μ` = long-run mean of the spread
- `θ` = speed of mean reversion
- `σ` = instantaneous volatility

Fit via discrete-time regression of `Δs_t` on `s_{t−1}`:

```
Δs_t = α + ρ · s_{t−1} + ε_t
```

Then `θ = −ρ / Δt`, `μ = α / θ`, and:

**Half-life of mean reversion**[^huan]:

```
half_life = ln(2) / θ = −ln(2) · Δt / ρ
```

The half-life tells you the typical timescale: if `half_life = 4 hours`,
your z-score-2 entry should plausibly close back to zero in ~4 hours
*on average* (it's a half-life, not a deadline). If `half_life > 30 days`,
the pair is borderline; capital efficiency is bad and structural breaks
are likelier than mean reversion within your holding horizon.

### 2.5 Z-score entry and exit

Compute the *rolling z-score* of the spread:

```
z_t = (s_t − μ_t) / σ_t
```

where `μ_t` and `σ_t` are the rolling-window mean and std of the spread
(window length typically `2 × half_life` or longer).

**Entry rules (classical):**
- `z > +2` → spread is too high. **Short** the spread = short `y`, long `β · x`.
- `z < −2` → spread is too low. **Long** the spread = long `y`, short `β · x`.

**Exit rules (classical):**
- `|z| < 0.5` → spread reconverged. Close.

**Stop-loss:**
- `|z| > 4` → spread is *expanding*; cointegration probably broke. Close
  the position and remove the pair from the universe until you re-test.

**Tuning the thresholds:** there's a literature on optimal-stopping bounds
for OU processes that give entry/exit bounds maximizing expected
profit-per-unit-time[^hudsonthames]. For an MVP, the `2σ entry / 0.5σ exit
/ 4σ stop` set works as a starting point. Re-tune per asset class.

### 2.6 Dynamic / time-varying cointegration

A 2022 line of research[^arxiv2021] argues that cointegration parameters
change over time in crypto (more than in equities), so a static
Engle-Granger β fitted on 6 months of data can be wrong by mid-window.
Two responses:

- **Rolling re-fit.** Re-estimate `β` and `θ` every N bars (e.g. weekly).
- **Kalman-filter the β.** Treat β as a hidden state that follows a random
  walk; update β via Kalman filter as new prices arrive.

For T3-T4 deployment with hours-to-days half-lives, weekly re-fit is
usually enough. Kalman β is overkill for retail.

---

## 3. Where it works

| Asset class | Venue | Verdict | Notes |
|---|---|---|---|
| US equities — paired single names | Alpaca | ✅ classic territory | KO/PEP, GS/MS, UPS/FDX, MA/V. Half-lives often days. |
| US equities — sector ETFs | Alpaca | ✅ | XLF/IAI, XLE/XOP, QQQ/SPY. Half-lives hours-to-days. |
| US equities — cross-listed / ADR | IBKR (not Alpaca) | ✅ | RIO/BHP, TSM ADR vs Taiwan, GLEN London vs ADRs. Needs multi-market access. |
| US equities — dual-class | Alpaca | ✅ | GOOG vs GOOGL is the textbook case (same company, voting vs non-voting). |
| Equities + futures | IBKR | ✅ | SPY vs ES (S&P futures), QQQ vs NQ. Half-lives minutes-to-hours. |
| Crypto spot | Coinbase, Binance | ✅ in some pairs | BTC/ETH log-ratio is famously *not* stationary for long stretches; XBT/XBT-on-other-exchange is. Be selective. |
| Crypto — tokens of same protocol | DEX/CEX | ⚠️ regime-dependent | UNI/SUSHI, AAVE/COMP. Cointegration can break around protocol announcements. |
| Crypto — wrapped vs native | Coinbase + on-chain | ✅ | WBTC vs BTC, stETH vs ETH. Near-cointegrated by construction (collateralized peg). |
| Cross-asset — equity vs commodity proxy | mixed brokers | ✅ | GLD vs GDX (gold ETF vs gold miners), OIH vs XOP. Half-lives days-to-weeks. |
| Polymarket binaries | Polymarket | ❌ | Binary payoff structure breaks the OU spread model. The complement-sum arb is the right tool here, not pairs. |

**Capital scale:**
- $5k → $250k per pair on equities (Alpaca PDT minimum + sane sizing).
- $1k → $100k per pair on crypto.
- Above $250k you start moving the spread on entry/exit; use a TWAP/POV
  execution overlay (cf. Family 6).

---

## 4. Edge magnitude

| Variant | Typical Sharpe (live, after costs) | Annualized return on dedicated capital | Source |
|---|---|---|---|
| Equity pairs (single names, well-selected) | 0.8-1.5 | 5-15% | Industry-standard quant survey results |
| Sector ETF pairs | 0.5-1.2 | 4-10% | Same |
| Crypto pairs (dynamic cointegration) | 1.0-2.5 (in-sample); 0.4-1.2 live | 10-25% | Hudson & Thames retrospectives + arxiv 2109.10662 [^arxiv2021] |
| ETF-NAV arb (authorized participant) | 2.0-4.0 | 5-15% (low vol) | Springer JAM 2025 [^etf] |
| Wrapped / pegged crypto pairs | 1.5-3.0 | 3-8% (very low vol) | Operator backtests |
| GOOG/GOOGL dual-class | 1.0-2.0 | 2-6% | Standard textbook example |

**Decay over time:** equity pairs from classic literature (KO/PEP) still
mean-revert but the edge has compressed to half what it was in 2005. Crypto
pairs offer fresher edges *but* with more frequent structural breaks. The
"easy" historical Sharpe ≥ 2 strategies are very crowded.

---

## 5. What kills it

Ranked by how often these end pairs strategies.

1. **Structural break in cointegration.** One of the two stocks announces M&A, gets de-listed, splits, or fundamentally repositions. The spread is no longer mean-reverting; you're left with a non-stationary spread and a position that keeps losing.
   - Detection: rolling re-test of cointegration (weekly ADF). If p-value drifts above your threshold for 2 consecutive windows, exit.
   - Real-world examples: AT&T / Verizon broke after AT&T's media demerger. CHK / SWN broke after CHK's bankruptcy. ETH/ETC was never cointegrated post-fork.

2. **Selection bias (data dredging).** You tested 5,000 pairs and 250 came back as "cointegrated" — but at p=0.05 you'd expect 250 false positives. Mitigation: Bonferroni-correct (`p_threshold = 0.05 / n_pairs_tested`), or use False Discovery Rate. Better: pre-filter pairs by *fundamental* relationship (same sector, same supply chain, dual-listed), then test.

3. **Half-life longer than your holding tolerance.** Spread is "cointegrated" but with a 60-day half-life. You enter at z=+2, draw down to z=+3 by week 2, capital costs eat you, and you're forced to close at a loss before reversion. Mitigation: filter pairs to `half_life < hold_capacity_days` (e.g. 14 days for a retail operator).

4. **Hedge-ratio drift.** `β` was 1.2 when you entered; by week 3 it's 0.9. The spread you're trading is now mispriced. Mitigation: rolling β re-fit or Kalman update; close & re-enter if `|β_new − β_entry| / β_entry > 0.15`.

5. **Borrow availability.** Short leg of the pair gets hard-to-borrow; rate spikes from 1% to 30% annualized. The carrying cost erases the mean-reversion edge. Mitigation: monitor borrow rates daily (Alpaca exposes this); avoid pairs where the short leg has a low float.

6. **Earnings / news asymmetry.** A pair like KO/PEP has near-simultaneous earnings; you're fine. But KO/MCD have unrelated event cadences — KO earnings can blow open the spread while MCD doesn't move. Mitigation: hold flat into known earnings of either side; resume after the reaction settles.

7. **Order timing on entry/exit.** Pairs strategies are "slow" but the *entry* is sensitive. Half a percent slippage on each leg compounds: a 4% spread mean-reversion edge becomes a 3% net edge. Mitigation: use IOC limit orders inside-the-spread for entry; accept a fraction of cycles will not fill and skip them.

---

## 6. Parameters

A single pairs-trading engine governs all variants. Per-pair overrides
are allowed.

### 6.1 Universe / selection

| Param | Default | Range | Purpose |
|---|---|---|---|
| `lookback_days` | 180 | [60, 730] | History used for cointegration test |
| `adf_pvalue_max` | 0.05 | [0.01, 0.10] | Cointegration threshold |
| `min_half_life_days` | 0.5 | [0.1, 5] | Floor (filters spurious noise) |
| `max_half_life_days` | 14 | [3, 60] | Ceiling (filter slow pairs) |
| `min_correlation` | 0.6 | [0.4, 0.9] | Pre-filter before ADF |
| `pair_universe_strategy` | `sector_or_industry` | `sector_or_industry` / `unconstrained` / `manual_list` | How to limit pairs tested |
| `bonferroni_correct` | `true` | bool | Multiply p-threshold by 1/n_pairs |

### 6.2 Entry / exit / risk

| Param | Default | Range | Purpose |
|---|---|---|---|
| `z_entry` | 2.0 | [1.5, 3.0] | Open at \|z\| ≥ |
| `z_exit` | 0.5 | [0.0, 1.0] | Close at \|z\| ≤ |
| `z_stop` | 4.0 | [3.0, 6.0] | Cointegration-break stop |
| `max_hold_days` | 21 | [3, 90] | Time-stop (close even if no reversion) |
| `zscore_window` | `2 × half_life` | [10, 500] bars | Rolling z computation |
| `notional_per_leg_usd` | 5000 | [500, 100_000] | Per-side dollar size |
| `max_open_pairs` | 5 | [1, 50] | Concurrency cap |
| `gross_exposure_cap_usd` | 50_000 | depends | Net of leverage |

### 6.3 Hedge / rebalance

| Param | Default | Range | Purpose |
|---|---|---|---|
| `beta_refit_days` | 7 | [1, 30] | Re-run cointegration regression every N days |
| `beta_drift_threshold_pct` | 15 | [5, 50] | Close & re-enter if β changes more than |
| `hedge_method` | `ols` | `ols` / `tls` / `kalman` | β estimation flavor |
| `rebalance_on_pnl_swing_pct` | 5 | [1, 20] | Re-balance shares if marked PnL drift exceeds |

---

## 7. Fill model (backtesting)

### 7.1 Entry

Use IOC limit orders inside-the-spread on both legs simultaneously. If one
fills and the other doesn't within `t_partial_window` (default 5s), cancel
the filled side at market.

For backtesting:

```
P(fill | crossing spread) = 1.0
P(fill | inside spread by 1 tick) = 0.6
P(fill | inside spread by 2 ticks) = 0.3
```

Adjust per venue based on historical book-fill ratios.

### 7.2 Hold

Mark-to-market at mid; charge financing on the short leg
(`borrow_rate × notional × dt`); for equities, dividends accrue/owed per
leg.

### 7.3 Exit

Same as entry. Be aware that *exit* fills happen at less attractive prices
than entry on average because z-score reversion is highly autocorrelated
with declining urgency.

### 7.4 Slippage / market impact

For `notional_per_leg < 0.1 × ADV_at_top_of_book`: assume zero impact.

For larger: linear impact model `Δprice / price ≈ k × (notional / ADV)`
with `k ≈ 0.5 bps per percent of ADV`. Liberally tested in equities; use
similar for crypto on top-50 pairs.

---

## 8. Backtest design

### 8.1 Data

| Variant | Data | Source |
|---|---|---|
| Equity pairs | Daily close (sufficient for >1d half-life); 1-min for intra-day half-lives | Alpaca historical (free), Polygon, or yfinance |
| ETF pairs | Same | Same |
| Crypto pairs | 1-min OHLCV, 5+ years | Coinbase historical, Binance, CoinAPI |
| Cross-asset | Daily | yfinance, FRED for macro proxies |
| Borrow rates | Daily | Alpaca shortable list + rate (live only; backtest must approximate) |

### 8.2 The walk-forward setup

1. **Universe selection window.** Use first 12 months to identify candidate pairs (cointegration test, half-life filter, sector/sanity filter).
2. **Out-of-sample test window.** Months 13-18. Trade the chosen pairs with parameters set during selection.
3. **Roll.** Slide forward 6 months. Re-select universe (some pairs drop out as cointegration breaks); re-fit β; re-test.
4. **Aggregate.** Combine out-of-sample windows into a single equity curve. Compute Sharpe, drawdown, win rate on this curve only.

This is the only way to get an honest pairs Sharpe. Single-window
in-sample results lie because the *selection* of pairs is itself a fit.

### 8.3 Metrics

- **Sharpe (out-of-sample, post-cost)** — primary.
- **Max drawdown and recovery time.**
- **Average pair-lifetime in the active universe** — short = the strategy churns through pairs; long = good selection.
- **Pair-level PnL distribution** — the strategy should *not* be carried by one pair.
- **Time-to-mean-reversion vs predicted half-life** — sanity check on OU fit.

### 8.4 Look-ahead traps

- **Don't use future data for β fitting.** Fit β on data ending at `t`, trade with that β at `t+1`.
- **Don't use full-sample ADF for selection in the live universe.** Selection must use only data available at universe-selection time.
- **Survivorship bias.** Use a universe of tickers as they existed at the *start* of each window, including delisted names with appropriate handling (force-close at delisting price).

---

## 9. Code skeleton

Sketched as a new module the repo doesn't yet have. Place under
`src/lib/strategies/pairs/` because it has enough internal structure to
warrant its own subdirectory.

### 9.1 Core math (`src/lib/strategies/pairs/cointegration.ts`)

```ts
// Pure functions. No I/O. Caller supplies price series.

export type SeriesRegressionResult = {
  alpha: number;
  beta: number;
  residuals: number[];
};

export function olsHedge(y: number[], x: number[]): SeriesRegressionResult {
  if (y.length !== x.length || y.length < 30) {
    throw new Error("olsHedge: need same-length series ≥ 30 obs");
  }
  const n = y.length;
  const ybar = mean(y);
  const xbar = mean(x);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - xbar) * (y[i] - ybar);
    den += (x[i] - xbar) ** 2;
  }
  const beta = num / den;
  const alpha = ybar - beta * xbar;
  const residuals = y.map((yi, i) => yi - alpha - beta * x[i]);
  return { alpha, beta, residuals };
}

/** Augmented Dickey-Fuller — returns t-stat and p-value approximation. */
export function adf(series: number[], lags = 1): { tStat: number; pValue: number } {
  // ΔS_t = α + ρ * S_{t-1} + Σ γ_i ΔS_{t-i} + ε_t
  // Implementation: OLS with regressors; t-stat on ρ; lookup MacKinnon CV.
  // See e.g. statsmodels.tsa.stattools.adfuller for the canonical implementation.
  // For prod, prefer wrapping an established lib (e.g. simple-statistics + custom
  // implementation, or call out to a Python micro-service).
  // ... (full implementation omitted from skeleton)
  throw new Error("implement: ADF — port from Hamilton (1994) or wrap a stats lib");
}

export type CointegrationResult = {
  cointegrated: boolean;
  hedgeRatio: number;        // β
  adfPValue: number;
  halfLifeBars: number | null;
  meanResidual: number;
  stdResidual: number;
};

export function testCointegration(
  y: number[], x: number[], pThreshold = 0.05,
): CointegrationResult {
  const reg = olsHedge(y, x);
  const adfResult = adf(reg.residuals);
  const cointegrated = adfResult.pValue < pThreshold;
  const hl = halfLifeOU(reg.residuals);
  return {
    cointegrated,
    hedgeRatio: reg.beta,
    adfPValue: adfResult.pValue,
    halfLifeBars: hl,
    meanResidual: mean(reg.residuals),
    stdResidual: std(reg.residuals),
  };
}

/** OU half-life via Δs ~ α + ρ s_{t-1}. */
export function halfLifeOU(spread: number[]): number | null {
  if (spread.length < 50) return null;
  const ds: number[] = [];
  const sLag: number[] = [];
  for (let i = 1; i < spread.length; i++) {
    ds.push(spread[i] - spread[i - 1]);
    sLag.push(spread[i - 1]);
  }
  const reg = olsHedge(ds, sLag);
  const rho = reg.beta;
  if (rho >= 0) return null; // no mean reversion
  return -Math.log(2) / rho;
}

function mean(a: number[]): number { return a.reduce((s, v) => s + v, 0) / a.length; }
function std(a: number[]): number {
  const m = mean(a);
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
  return Math.sqrt(v);
}
```

### 9.2 Signal generation (`src/lib/strategies/pairs/signals.ts`)

```ts
import { type CointegrationResult } from "./cointegration";

export type PairTick = {
  ts: number;
  yPrice: number;
  xPrice: number;
  rollingMean: number;     // rolling mean of spread
  rollingStd: number;
  hedgeBeta: number;
  fitResult: CointegrationResult;
};

export type PairSignal =
  | { kind: "open"; side: "long-spread" | "short-spread"; zScore: number; reason: string }
  | { kind: "close"; reason: string }
  | { kind: "stop"; reason: string }
  | { kind: "noop" };

export type PairSignalCfg = {
  zEntry: number;     // 2.0
  zExit: number;      // 0.5
  zStop: number;      // 4.0
  betaDriftPct: number; // 15
};

export function pairSignal(
  tick: PairTick,
  state: { open: boolean; entryBeta: number | null; ageBars: number; maxHoldBars: number },
  cfg: PairSignalCfg,
): PairSignal {
  const { yPrice, xPrice, rollingMean, rollingStd, hedgeBeta } = tick;
  const spread = yPrice - hedgeBeta * xPrice;
  const z = (spread - rollingMean) / rollingStd;

  // Cointegration broken? Stop.
  if (!tick.fitResult.cointegrated) {
    return { kind: "stop", reason: "cointegration broke" };
  }

  // β drift detection (when open).
  if (state.open && state.entryBeta !== null) {
    const drift = Math.abs(hedgeBeta - state.entryBeta) / state.entryBeta;
    if (drift > cfg.betaDriftPct / 100) {
      return { kind: "stop", reason: `β drift ${(drift*100).toFixed(1)}% > threshold` };
    }
  }

  // Time stop.
  if (state.open && state.ageBars > state.maxHoldBars) {
    return { kind: "close", reason: "time stop" };
  }

  // z-score stop.
  if (state.open && Math.abs(z) > cfg.zStop) {
    return { kind: "stop", reason: `|z|=${z.toFixed(2)} > z_stop` };
  }

  // Exit.
  if (state.open && Math.abs(z) < cfg.zExit) {
    return { kind: "close", reason: `|z|=${z.toFixed(2)} < z_exit` };
  }

  // Entry.
  if (!state.open && Math.abs(z) > cfg.zEntry) {
    return {
      kind: "open",
      side: z > 0 ? "short-spread" : "long-spread",
      zScore: z,
      reason: `|z|=${z.toFixed(2)} > z_entry, β=${hedgeBeta.toFixed(3)}`,
    };
  }

  return { kind: "noop" };
}
```

### 9.3 Selection (`src/lib/strategies/pairs/select.ts`)

```ts
import { testCointegration } from "./cointegration";

export type PairCandidate = { ySymbol: string; xSymbol: string; yPrices: number[]; xPrices: number[] };
export type PairSelectionCfg = {
  pThreshold: number;
  minHalfLifeBars: number;
  maxHalfLifeBars: number;
  bonferroni: boolean;
};

export type SelectedPair = {
  ySymbol: string; xSymbol: string;
  hedgeBeta: number;
  halfLifeBars: number;
  adfPValue: number;
  meanResidual: number;
  stdResidual: number;
};

export function selectPairs(
  candidates: PairCandidate[],
  cfg: PairSelectionCfg,
): SelectedPair[] {
  const effThreshold = cfg.bonferroni ? cfg.pThreshold / candidates.length : cfg.pThreshold;
  const out: SelectedPair[] = [];
  for (const c of candidates) {
    const r = testCointegration(c.yPrices, c.xPrices, effThreshold);
    if (!r.cointegrated) continue;
    if (r.halfLifeBars === null) continue;
    if (r.halfLifeBars < cfg.minHalfLifeBars) continue;
    if (r.halfLifeBars > cfg.maxHalfLifeBars) continue;
    out.push({
      ySymbol: c.ySymbol, xSymbol: c.xSymbol,
      hedgeBeta: r.hedgeRatio,
      halfLifeBars: r.halfLifeBars,
      adfPValue: r.adfPValue,
      meanResidual: r.meanResidual,
      stdResidual: r.stdResidual,
    });
  }
  return out.sort((a, b) => a.adfPValue - b.adfPValue);
}
```

### 9.4 Engine wiring

Tie signals → orders through `src/lib/venue/router.ts`. The router already
knows about Alpaca (equities) and the crypto venues; the pairs engine just
needs to express "short 100 shares of A, long β × 100 / β shares of B."

The "venue" for an equity pair via Alpaca is just `alpaca`. For a
crypto pair across two CEXes, each leg routes to its own venue.

---

## 10. Implementation path here

1. **Add `src/lib/strategies/pairs/` directory** with the three modules from §9.
2. **Add Alpaca adapter to `src/lib/venue/adapters/alpaca.ts`** — this is the missing equities venue adapter. Use the Alpaca SDK or the existing alpaca MCP for read; for execution, wrap the official `@alpacahq/alpaca-trade-api`.
3. **Add Alpaca to `src/lib/hft/venues.ts`** with appropriate fee tiers (commission-free for equity trades; $0.65/contract for options).
4. **Universe scripts:**
   - `scripts/select-pairs-equities.ts` — pull S&P 500 + ETF set from Alpaca, run cointegration on all sector-bucket pairs, persist top-N to `data/pairs-equities.json`.
   - `scripts/select-pairs-crypto.ts` — pull top-50 USD pairs from Coinbase + Binance + Hyperliquid; persist to `data/pairs-crypto.json`.
5. **Backtest harness** — `scripts/backtest-pairs.ts` with walk-forward as described in §8.2. Outputs `docs/pairs-results.json` (gitignored).
6. **Live engine** — `src/lib/strategies/pairs/engine.ts` orchestrates per-pair state machines; reads selection from `data/pairs-*.json`; writes orders via venue router.
7. **Kill switch** — register with `src/lib/risk/kill-switch.ts`. On kill: close all open pairs at market, halt new entries until manually re-armed.
8. **UI surface** — add a panel to `src/app/hft/page.tsx` showing per-pair state (open / closed / cool-down / dead), current z-score, days-in-trade, mark-to-market PnL.
9. **Tests** — `tests/unit/pairs-cointegration.test.ts` (cointegration math against known fixtures), `tests/unit/pairs-signals.test.ts` (signal generation on synthetic OU series), `tests/integration/pairs-flow.test.ts` (selection → signal → mock-execute round-trip).

---

## 11. Asset-specific gotchas

### Equities (Alpaca)

- **Dividend handling.** When the long leg pays a dividend, you receive cash; the short leg, when paying a dividend, costs you cash. Equity pairs with asymmetric dividend timing can have spurious "spread jumps" on ex-dividend dates. Mitigation: dividend-adjust the spread (use total-return series rather than raw prices).
- **Corporate actions.** Splits, spin-offs, mergers break the pair. Universe must be re-screened around announced corporate actions.
- **Hard-to-borrow names.** Even cointegrated pairs become uneconomic if the short leg costs 20% annualized to borrow. Skip pairs where the short side is hard-to-borrow or has a borrow rate > expected mean-reversion edge.
- **Short-sale restrictions** (SHO Reg T circuit breaker). Names that triggered a -10% in a day get short-sale restricted for the next day. Mitigation: avoid initiating new short legs in restricted names.

### Crypto

- **Funding rates (if pair uses perps).** A pair like dYdX-ETH-PERP vs Hyperliquid-ETH-PERP requires netting funding flows; signs depend on direction.
- **Network risk.** If the two sides are on different chains (e.g. ETH on Ethereum vs ETH on Solana wrapping), there's settlement risk between the two chains. Prefer pairs on the same network or same custodian.
- **24/7 markets.** No EOD-mark; rolling window must be expressed in bars, not "trading days." Convert your equity-derived parameters: e.g. "5-day rolling" = `5 × 24 × 60 = 7200 minutes` of 1-min bars.
- **Listing / delisting risk.** A coin can be delisted from one of the two pair venues; your hedge is suddenly unhedgeable.

### Cross-asset (e.g. GLD/GDX)

- **Different trading hours.** Equity ETFs trade 9:30-16:00 ET; crypto trades 24/7; futures have their own calendars. The "spread" needs a consistent timestamp aggregation; consider sampling at the closing time of the slower-trading instrument.
- **Macro drivers.** Many cross-asset pairs (gold/miners, oil/oil-services) get blown apart by macro events (rate decisions, OPEC announcements, geopolitics). The cointegration test won't catch this *ex ante*. Hold flat across known macro print windows.

---

## 12. Concrete starter pair list

For an MVP, start with these. They're well-documented in the literature
and have known stable-ish cointegration:

| Pair | Asset | Typical half-life | Notes |
|---|---|---|---|
| KO / PEP | equities | 5-15 days | Classic textbook pair; cointegration has weakened post-2020 but still trades |
| MA / V | equities | 3-10 days | Both payment networks; very similar exposure |
| GOOG / GOOGL | equities | 0.5-3 days | Same company, voting vs non-voting; spread is "premium for voting rights" |
| QQQ / SPY | ETFs | 2-7 days | Index ETFs with overlapping but distinct constituents |
| GLD / GDX | gold | 5-20 days | Gold ETF vs miners; β > 1 typically; cointegration breaks during gold rallies |
| XLF / IAI | ETFs | 5-15 days | Banks vs broker-dealers |
| WBTC / BTC | crypto | minutes-hours | Pegged; mean reversion is fast but edge is small (bridge fees) |
| stETH / ETH | crypto | hours-day | Pegged-ish (Lido staking derivative); occasional de-peg events |
| BTC-Coinbase / BTC-Binance | crypto | minutes | Same asset, different venue; covers cross-venue spread |
| ETH-PERP-dYdX / ETH-PERP-Hyperliquid | crypto perps | minutes-hours | Tight cointegration; funding spread adds carry |

Skip these (commonly attempted, usually fail):

| Pair | Why it fails |
|---|---|
| BTC / ETH (log-ratio) | Not cointegrated long-run; rotates regime |
| Any two altcoins | Spurious correlation; cointegration is a chimera over more than 2-3 months |
| KO / MCD | Cointegrated 2010-2018, broken since; pandemic-era consumer-pattern shift |

---

## 13. Open questions worth answering (research directions)

1. **Crypto wrapped-token pairs** — how often does WBTC truly depeg, and is the half-life predictable? Could become a high-Sharpe, low-vol contributor.
2. **Adding a momentum filter to z-entry.** Pairs that diverge with high cross-asset *momentum* (i.e. spread is widening fast) are more likely to keep widening. Filter out trade signals where spread *velocity* is in the same direction as the divergence.
3. **Kalman β vs rolling OLS β on crypto.** Worth a controlled A/B; intuition says Kalman wins because crypto regimes shift more.
4. **Triplet (Johansen 3-way)** baskets for equity sector ETFs — XLF + XLI + SPY, for instance. Could capture relative-sector rotations.
5. **Cross-asset stress hedges.** During risk-off, equities and gold often *both* spike toward inverse correlation; a "stress-only" pairs strategy could be a hedge for the rest of the book.

---

## 14. References

[^eg1987]: Engle, R. F., & Granger, C. W. J. (1987). "Co-integration and error correction: representation, estimation, and testing." *Econometrica*, 55(2), 251-276.

[^j1988]: Johansen, S. (1988). "Statistical analysis of cointegration vectors." *Journal of Economic Dynamics and Control*, 12(2-3), 231-254.

[^huan]: Liu, I. *et al.* `OrnsteinUhlenbeckHalfLife` — pairs trading R package. [rdrr.io](https://rdrr.io/github/ivanliu1989/RQuantTrader/man/OrnsteinUhlenbeckHalfLife.html).

[^hudsonthames]: Hudson & Thames. "Optimal Stopping in Pairs Trading: Ornstein-Uhlenbeck Model." [hudsonthames.org/optimal-stopping-in-pairs-trading-ornstein-uhlenbeck-model/](https://hudsonthames.org/optimal-stopping-in-pairs-trading-ornstein-uhlenbeck-model/) — derivation of optimal entry/exit bounds, plus broader cointegration intro at [an-introduction-to-cointegration/](https://hudsonthames.org/an-introduction-to-cointegration/).

[^arxiv2021]: "Evaluation of Dynamic Cointegration-Based Pairs Trading Strategy in the Cryptocurrency Market." arXiv:2109.10662. [arxiv.org/abs/2109.10662](https://arxiv.org/abs/2109.10662).

[^etf]: "Cointegration-based pairs trading: identifying and exploiting similar exchange-traded funds." *Journal of Asset Management* (Springer Nature), 2025. [Springer link](https://link.springer.com/article/10.1057/s41260-025-00416-0).

**Other primary sources**
- "An Application of the Ornstein-Uhlenbeck Process to Pairs Trading." arXiv:2412.12458. [arxiv.org/abs/2412.12458](https://arxiv.org/abs/2412.12458) — recent (Dec 2024) walk through OU calibration.
- Malchevskiy, S. "Pairs Trading with Cryptocurrencies." Towards Data Science. [medium.com/data-science](https://medium.com/data-science/pairs-trading-with-cryptocurrencies-e79b4a00b015).
- Sesen AI. "Cointegration and Pairs Trading: When Time Series Move Together." [sesen.ai/blog](https://sesen.ai/blog/cointegration-pairs-trading).
- QuantConnect. "Cointegration-Enhanced Crypto" community algorithm. [quantconnect.com/league](https://www.quantconnect.com/league/17226/2024-q2/cointegration-enhanced-crypto/).
- Towards Data Science. "Constructing Cointegrated Cryptocurrency Portfolios." [towardsdatascience.com](https://towardsdatascience.com/constructing-cointegrated-cryptocurrency-portfolios-d0a27922891e/).

**Related modules in this repo**
- *(no pairs modules yet — this doc is the implementation seed)*
- `src/lib/venue/router.ts` — the order-routing layer the engine will dispatch through.
- `src/lib/risk/kill-switch.ts` — register the pairs engine here for halt-all behavior.
- `src/lib/hft/edge.ts` — the cost-edge formula every pair entry must pass.
- `tests/unit/complement-sum-arb.test.ts` — pattern for detector tests; adapt for pairs signals.
