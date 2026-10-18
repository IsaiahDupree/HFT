# I analyzed 1000 Polymarket bots with Claude. Here's how they make $100K/month

**Source:** Daniro (@Dan1ro0) on X / Twitter — https://twitter.com/Dan1ro0/status/[id-unknown]
**Posted:** 2026-05-25 1:25 PM
**Views at archive time:** 8,313
**Archived:** 2026-05-26 by classifier validation pass
**Skepticism notes (read first):**

- Author handle `@Dan1ro0` describes themselves as "Buy at the peak, sell at the bottom" / "public relations | @zscdao" — promo profile, not an independent analyst
- The "1000 bots through Claude" claim is unverifiable; no methodology or dataset shared
- Every wallet URL embedded in the article has `?via=dan-kwpx` — paid-affiliate referral parameter pointing to a Polymarket tracker product. Treat the wallet selections as **marketing curation**, not statistically-sampled examples
- The "$100K/month" headline is unsourced — none of the wallets shown have PnL panels confirming that monthly rate verbatim
- The article's technical claims (Bayesian update, Kelly sizing, Stoikov execution) are real and well-known quant techniques — those parts are credible. The wallet success-rate claims are not independently verified

**Why archive it anyway:** Despite the marketing tilt, the article catalogs **six bot archetypes** that map directly onto microstructure signals we can measure, and it names **5 specific wallets** including two we hadn't seen yet. The frameworks are useful even if the curation is paid.

---

## Wallets mentioned (all have `?via=dan-kwpx` referral param stripped here)

| # | Handle | Article claim | In our DB? |
|---|---|---|---|
| 1 | `@bonereaper` | "By the time you finish reading this headline, a bot has already repriced reality four times" — $100/min example | YES — classified `hft_bot` |
| 2 | `@0x6e1d5040d0ac73709b0621f620d2a60b80d2d0f` (39-char) | "This guy definitely knows how to use [the lag]" | YES — classified `conviction_trader`, $2M realized, near-resolution scraping |
| 3 | `@0xb55fa1296e6ec55d0ce53d93b9237389f11764d4-1777575277609` (Hermes) | "Arb between 5/15 min" example | YES — tracked, classified |
| 4 | `@0xce25e214d5cfe4f459cf67f08df581885aae7fdc-1777575398144` | "Trader using Stoikov-style logic" — adaptive inventory-aware execution | **NEW** |
| 5 | `@flippingsharks` | "10 days — $46k PnL" screenshot | **NEW** |

---

## The thesis in one sentence

> "Polymarket reprices slower than the underlying asset moves on Binance. The lag is just a few seconds and it keeps tightening as more bots pile into the market."

**Concrete example claim:** A 15-minute BTC contract sitting at 50/50; BTC drops 0.6% on Binance over 30 seconds; "real" probability that BTC closes lower → ~78%; but Polymarket shows 54/46. 20+ points of edge on a binary contract, captured by a bot listening to Binance's feed at tens-of-millisecond latency.

---

## The author's 6 bot archetypes

**1. Pure Arbitrage Bot**
Buys both sides when YES + NO < $1.00 (e.g., Up @ 45¢ + Down @ 46¢ = 91¢, payout $1, profit on any outcome). Earns from price structure, not forecasting.

**2. Directional Arbitrage Bot**
Starts from an arbitrage base, then loads up the stronger side. Arb becomes a protective frame for a directional bet — one side is the main position, the other is the hedge.

**3. Repricing / Fair Value Bot**
Builds its own fair-value estimate from the underlying (Binance/Chainlink) and compares to Polymarket. If BTC jumps but the contract hasn't updated, buy the undervalued side. **Repricing speed decides everything.**

**4. Cross-Timeframe Bot**
Trades several related markets at once (5m + 15m BTC). Captures the lag between timeframes — one contract already shows the new reality, the other still trades on the old one.

**5. Imbalance Bot**
Hunts for structural imbalance: skew between sides, uneven repricing, a weak order book. Builds positions around the skew, not around direction.

**6. Near-Resolution Bot**
Enters in the final phase when the outcome is nearly settled but the winning side trades at 0.98–0.99 instead of 1.00. High win rate, but tail risk: a sharp reversal in the last second wipes out many small wins.

---

## The author's computation chain

> signal → Bayesian update → fair value → edge check → cross-market comparison → execution → sizing

**Bayesian update (verbatim from article):**

```python
def bayes_update(prior, like_true, like_false):
    num = like_true * prior
    den = num + like_false * (1 - prior)
    return num / den

posterior = bayes_update(0.41, 0.78, 0.24)
# → 56%
```

**Net edge check (verbatim):**

```python
def net_edge(model_p, market_price, cost):
    return model_p - market_price - cost

edge = net_edge(0.56, 0.47, 0.015)
# → 7.5%
```

**Cross-market spread z-score (verbatim):**

```python
spread_now = 0.12
mu = 0.03
sigma = 0.025
z = (spread_now - mu) / sigma  # → 3.60
```

**Fractional Kelly (verbatim):**

```python
def fractional_kelly(p, b, lam=0.25):
    f_star = (b * p - (1 - p)) / b
    return max(lam * f_star, 0)

size = fractional_kelly(0.61, 1.8)
```

---

## The author's "stack: 28 tools across 6 layers"

| Layer | What | Author's specifics |
|---|---|---|
| 1 — Brain | AI strategist for prob estimation + edge sizing | Claude + Qwen3-Coder + parallel instances via Claude Squad |
| 2 — Orchestration | Bull Agent vs Bear Agent vs Risk Manager (veto) | Consensus-based trade + size approval |
| 3 — Data & Signals | Price + macro + on-chain feeds | OpenBB (100+ sources), Binance, fredapi |
| 4 — Market Intelligence | Whale trackers + leaderboards + pre-built bots | Polyscope, Polywhaler, HyperBuildX (Rust, sub-100ms) |
| 5 — Backtest & Simulation | Historical replay with fees/slippage | "The layer most retail bots skip" |
| 6 — Risk / Sizing | Fractional Kelly + kill switches | Inventory limits, drawdown caps |

---

## The author's "humans vs bots: the data" claim

Same strategy, same market, same time — bots pull ~2× human PnL. Four claimed reasons:

1. **Late entries** — by the time a human spots the lag, the window has closed
2. **Inconsistent sizing** — humans oversize when confident, undersize when uncertain (inverse of Kelly)
3. **Fatigue** — bots don't degrade at hour 72
4. **Drawdown psychology** — humans abandon working strategies after losses OR double down; bots with hard kill switches do neither

---

## The article's conclusion (verbatim)

> "The market of opinions is dead. Long live the market of speed."
>
> "These bots don't make money because they know the future. They make money because they see market structure faster than most people realize the price has already gone wrong."
>
> "Humans read headlines. Quant bots reprice reality."

---

## Companion report

See `daniro-2026-05-25-report.md` (same directory) for gap-analysis: which of the author's 6 archetypes + 6 layers we already have, which are gaps worth building, and the classifier results for the 2 new wallets.
