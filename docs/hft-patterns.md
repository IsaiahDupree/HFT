# HFT Trading Patterns — Research Dossier

> A practical survey of HFT-style trading patterns, organised by category, with
> emphasis on what actually works in crypto markets (CEX spot, perp CLOBs,
> on-chain CLOBs, prediction markets) at the latency tier a small/medium
> operator can realistically achieve.
>
> The lens: this repo runs Coinbase Advanced (live, REST/WS), dYdX v4 (testnet
> wired), Polymarket (live), with Hyperliquid and Paradex in the comparator but
> not yet adapter-wired. "Practical" here means: can a single operator with
> commodity hardware + a regular cloud VM make this work at $1k–$100k notional.

---

## 0. The only law: cost ≤ edge

Every pattern below reduces to the same inequality:

```
expected_edge_bps  >  fees_bps  +  spread_bps  +  slippage_bps  +  latency_bps  +  adverse_selection_bps
```

The components shift weight by pattern:

- **Maker patterns** earn the spread, so `spread_bps` is *negative* (income). Their cost is `adverse_selection_bps` — getting filled only because someone better-informed lifted you.
- **Taker patterns** pay the spread, so `spread_bps` is positive (cost). They're fast and certain; they pay every tick of slippage and every bp of fee.
- **Cross-venue patterns** add a `staleness_bps` term: how much the reference moved in the round-trip between observation and execution.

The catalog of "patterns" is mostly a catalog of which terms dominate and how to control them. There are no secret strategies — there are accounting honesties and execution disciplines that compound.

---

## 1. Latency tiers and which patterns live in each

| Tier | One-way wire ⟶ matching engine | Patterns viable | Examples |
|------|-------------------------------|-----------------|----------|
| **T0 — co-located silicon** | <50 µs | Queue-position MM, latency arb, sweep-detection MM | Citadel, Jane Street, Jump on Nasdaq / CME / DEC |
| **T1 — co-located VM** | 100 µs – 2 ms | Queue-aware MM on liquid pairs, fast cross-venue arb | Paradex Pro flow, Coinbase Exchange FIX, Hyperliquid via dedicated peer |
| **T2 — same-region cloud (us-east-1)** | 5–30 ms | Inventory-aware MM, slow lead-lag, basis arb, funding capture | This repo's realistic target band |
| **T3 — global cloud, REST polling** | 80–500 ms | News-taking, multi-minute basis, statistical arb, binary MM | Polymarket maker, Coinbase Advanced REST quotes, dYdX Indexer-driven MM |
| **T4 — anything slower** | >1 s | Funding rate harvesting, multi-day pairs, governance arb | Backtest-only at faster horizons |

This repo lives at **T3** by default — Indexer REST polling, no co-location, commodity Node process. Some patterns simply can't live here; the dossier flags them.

---

## 2. Market making

### 2.1 Quote-driven spread capture (baseline)

**Mechanism.** Post a bid below fair and an ask above fair. When matched, you've bought low and sold high. Net edge over `n` round trips = `n × spread − fees − adverse_selection`.

**Where it works.** Liquid CLOBs with a stable maker fee tier near zero (or rebate). Tightest spreads on BTC/ETH at all major venues; widens for long-tail.

**What kills it.**
- **Adverse selection** dominates if you can't cancel before the price moves. Half of your fills are on the wrong side of an information event.
- **Maker-rebate tier slippage**: tier-based rebates flip the EV; lose your tier and the strategy goes from +EV to negative.
- **Spread compression**: as flow gets toxic, market participants tighten until only co-located makers survive.

**Edge magnitude.**
- BTC/ETH spot at Binance/Coinbase: 0.5–2 bps post-fee; only fee-tier-0 makers survive.
- BTC perp at Hyperliquid: 1.5–4 bps post-fee at retail tier; better with maker rebate tier.
- ETH-USD on dYdX (testnet shows quoted spreads of ~$8 across $2000 ETH, ~40 bps), so mainnet captures are 2–6 bps for tight quotes.

**Repo wiring.** `scripts/dydx-mm.ts` + `src/lib/hft/dydx/mm-engine.ts` implements this baseline. The math lives in `src/lib/hft/dydx/mm.ts` — `computeQuotes()` returns symmetric bid/ask around the oracle.

**Refs.** Avellaneda–Stoikov (2008), "High-frequency trading in a limit order book." *Quantitative Finance* 8(3).

---

### 2.2 Microprice / book-weighted fair-value

**Mechanism.** Replace the mid-price with a size-weighted blend of best bid and best ask:

```
microprice = (bid_size × ask + ask_size × bid) / (bid_size + ask_size)
```

Intuition: if there's a wall of buyers at $100 (size 50) and a thin seller at $100.02 (size 1), the *real* fair is closer to $100.02 — the next trade will likely lift the ask. Quoting around mid underprices your ask and overprices your bid; quoting around microprice fixes the bias.

**Where it works.** Any CLOB where top-of-book sizes are reported (i.e., all of them).

**What kills it.**
- **Iceberg orders**: visible size lies about real depth.
- **Spoofed walls**: cancellation-rich quotes inflate one side's apparent weight.
- **Thin top with deep secondary**: top L1 looks unbalanced but L2/L3 are even.

**Edge over plain mid.** 0.3–1.5 bps in MM PnL on liquid pairs; trivial to implement, robust to most failure modes.

**Repo wiring.** Not yet implemented. Easy upgrade to `computeQuotes()` — take `bids[0]` and `asks[0]` from the indexer alongside the oracle. Recommend testing microprice as a *quoting reference* but oracle as the *risk reference* (for inventory-skew calcs).

**Refs.** Stoikov (2018), "The micro-price: A high-frequency estimator of future prices." Cartea/Jaimungal/Penalva, *Algorithmic and High-Frequency Trading* (Cambridge, 2015) — ch. 10.

---

### 2.3 Inventory-skewed MM (Avellaneda–Stoikov)

**Mechanism.** Tilt the quoted mid against your current inventory. Long → lower mid → wider bid, tighter ask, encourages flattening. Symmetric for short.

Formally, the optimal half-spread under a mean-reverting price + linear inventory penalty is:

```
δ_bid = γ σ² (T−t) + (1/γ) log(1 + γ/k)
δ_ask = similarly
mid_skewed = price − q γ σ² (T−t)
```

where `q` is signed inventory, `γ` is risk aversion, `σ` is volatility, `k` is order-flow intensity.

In practice, ignore the closed-form and use a hand-tuned linear skew (`mid * (1 − q × skewBpsPerDollar / 10000)`) — it captures 80% of the benefit with one parameter.

**Where it works.** Anywhere you can be filled on both sides over a holding period.

**What kills it.**
- **Trending markets**: skew flattens you against a trend you'd have made money in. Cap the skew magnitude and use an external trend filter.
- **Asymmetric flow**: if 90% of takers come from one side (common in alts), your skew flattens you against the dominant side and you bleed inventory turnover.

**Edge magnitude.** Not a standalone alpha — a *risk management* layer that reduces variance enough to allow tighter spreads. Empirically: same spread + skew vs no-skew → 30–50% lower inventory variance for the same fill rate.

**Repo wiring.** Live in `src/lib/hft/dydx/mm.ts`. `cfg.skewBpsPerDollar` controls intensity; default `0.1` bps/$ is conservative.

**Refs.** Avellaneda–Stoikov original paper; Guéant/Lehalle/Fernandez-Tapia (2013), "Dealing with the inventory risk."

---

### 2.4 Microstructure-conditional MM (cancel-on-toxic-flow)

**Mechanism.** Don't quote a static spread. Widen or pull quotes when the book signals incoming informed flow. Re-engage when the signal cools.

Toxic-flow proxies:
- **Order-book imbalance (OBI)** crossing thresholds.
- **Trade-flow toxicity (VPIN)** — bucketed signed volume divergence.
- **Cancel/replace rate** on the opposing side (someone is reloading aggressively).
- **External price gap** (Binance just moved 5 bps in 200 ms — pull quotes on Coinbase before the news hits).

**Where it works.** Mid-tier and liquid CLOBs. Essential for survival in BTC/ETH spot vs informed flow.

**What kills it.**
- **Over-fitting** to a specific microstructure regime. The signals decay.
- **Latency**: if you can't cancel before the toxic order arrives, the signal is decoration.

**Edge magnitude.** Adds 2–6 bps to baseline MM PnL on liquid pairs *if your cancel latency is faster than the toxic flow's arrival latency*. At T3 (REST polling), this works only against *slow* toxic flow (news-driven, not microstructure-driven).

**Repo wiring.** Not implemented. The hooks would live in the `loop()` of `mm-engine.ts` — before placing/replacing quotes, run a toxicity check; if hot, widen `cfg.halfSpreadBps` for one cycle or pause.

**Refs.** Easley/López de Prado/O'Hara (2012), "Flow toxicity and liquidity in a high-frequency world." *Review of Financial Studies* 25(5).

---

### 2.5 Queue-position-aware MM

**Mechanism.** Time-priority matters: the first order at a price level fills first. If you can predict that a price level will be hit, race to its head. If your queue position is bad and the next move is against you, cancel and reload elsewhere.

Two main moves:
- **Join-the-queue**: place an order at a price level you expect to be hit. You earn maker rebate + spread *and* avoid the queue penalty of late arrival.
- **Cancel-and-reload**: if your queue position is bad (lots of orders ahead) and the imbalance suggests the move is the other way, you're paying the option premium with no upside. Cancel and place ahead of someone else somewhere else.

**Where it works.** Pro-rata or strict-priority CLOBs with deep order books — equity options (Citadel territory), CME futures, top-of-book on Hyperliquid for BTC.

**What kills it.**
- **Pro-rata matching** in some venues: queue position doesn't matter much; size does.
- **Hidden iceberg ahead of you**: you think you're at position 3 but you're at position 30.
- **Cancel-replace fees / penalties**: some venues (Coinbase Exchange) measure your message rate; abuse trips throttles.

**Edge magnitude.** 1–4 bps on top-of-book quoting for HFT shops with co-location. **Effectively zero at T3.** This pattern is a T0/T1 game.

**Repo wiring.** Out of scope for T3 polling. Listed for completeness.

**Refs.** Moallemi/Yuan (2017), "A model for queue position valuation in a limit order book."

---

### 2.6 Multi-level laddered MM

**Mechanism.** Post quotes at multiple price levels (e.g., 5, 10, 15 bps away from mid on each side), not just one. Higher fill rate, lower individual edge per fill, but smoother inventory accumulation.

**Where it works.** Volatile assets where the price visits more levels per minute. Especially useful on prediction-market style assets where binary outcomes mean price either stays at 0.50 or hits 0.05 / 0.95.

**What kills it.**
- **Slow cancels**: when the market moves, you need to cancel the entire ladder simultaneously. Asymmetric cancel latency = pick-off on the stale far rungs.
- **Capital fragmentation**: $X spread across 5 rungs is less effective than $X at the tightest rung, *if* you actually fill at the tightest.

**Edge magnitude.** Smooths return distribution rather than raising mean. Useful for capital efficiency (you can deploy more) but not raw edge.

**Repo wiring.** Not implemented. `computeQuotes()` returns a single bid + ask; would extend to return arrays. Modest refactor.

**Refs.** Cartea/Jaimungal/Penalva, ch. 9 — multi-level depth strategies.

---

### 2.7 Maker-rebate farming (volume-tier seeding)

**Mechanism.** Run the MM book at break-even or small loss to hit a maker-rebate tier. Once the tier resets, the marginal trade is in profit.

**Where it works.** Venues with discrete tier thresholds (Coinbase, Binance) or programs that pay continuous rebates above a volume threshold (Hyperliquid maker rebates).

**What kills it.**
- **Tier slippage**: the volume requirement may not be visible until you commit capital for 30 days.
- **Adverse-selection bleed**: trading purely for volume means you take fills you'd otherwise skip. Without a rebate, this would be ruinous.
- **Competitor flooding**: when a venue announces a generous rebate program, everyone piles in; spreads compress; the rebate becomes the only profit, and it's not enough.

**Edge magnitude.** Specific to the program. Hyperliquid maker rebates up to ~0.3 bps continuously — meaningful at billions in monthly volume, marginal below $10M/mo.

**Repo wiring.** Out of scope for testnet; conceptually fits as a tier-aware parameter set in `strategies.ts`.

**Refs.** Coinbase Advanced fee schedule (live); Hyperliquid docs `gitbook.io/hyperliquid-docs/trading/fees`.

---

## 3. Arbitrage patterns

### 3.1 Cross-venue spot arb (CEX ↔ CEX)

**Mechanism.** Same asset, two venues, different prices. Buy where it's cheap, sell where it's rich, harvest the difference.

In practice for BTC across Coinbase/Binance/Kraken, the gap is usually <2 bps after fees. It opens occasionally during macro events, exchange outages, or major news (Coinbase has historically been ~10–30 bps off Binance during volatility).

**Where it works.** Two venues you can trade simultaneously, with a fast settlement path between them. For crypto, this often means *not* actually moving inventory between venues — you hold a balance at both and rebalance only when one drains.

**What kills it.**
- **Inventory imbalance**: you slowly drain one venue and accumulate at the other.
- **Withdrawal delays**: when you do need to rebalance, blockchain confirmations (or KYT review) take hours.
- **Fees + slippage** consume the entire gap most of the time.

**Edge magnitude.** 0.5–3 bps per round trip when active. The pattern's lifetime is "until someone deploys faster than you" — usually months.

**Repo wiring.** Cross-Coinbase ↔ Hyperliquid or Coinbase ↔ dYdX (different products, basis trade — see 3.2). Pure spot-spot is hard without Binance access.

**Refs.** Makarov/Schoar (2020), "Trading and arbitrage in cryptocurrency markets." *Journal of Financial Economics* 135(2).

---

### 3.2 Spot-perp basis arb

**Mechanism.** Buy spot, short perp (or vice versa). Lock in the basis = perp_price − spot_price. Perps settle against spot at maturity (funding rate mechanism replaces dated settlement), so basis converges to zero.

For Coinbase BTC-USD spot vs dYdX BTC-USD perp:
```
basis_bps = (perp - spot) / spot × 10000
expected_pnl_per_8h = basis_bps + funding_rate_per_8h × 10000
```

**Where it works.** Wide funding markets — Hyperliquid, Binance perps, dYdX during liquidations or news. Coinbase spot vs Hyperliquid perp is a common pair.

**What kills it.**
- **Funding flips**: you go long basis expecting funding to pay, then funding turns negative and you bleed.
- **Liquidation cascades**: a sharp move can liquidate the perp leg before you can rebalance.
- **Borrow rates**: shorting spot on Coinbase requires margin/borrow which has its own cost.

**Edge magnitude.** Funding capture on BTC perps has paid 5–40% APR historically (2021–2023). Compressed to 3–10% in 2025+ markets. Per-trade basis on a calm day: 1–5 bps; on a volatile day, 30–200 bps.

**Repo wiring.** Direct fit. Coinbase spot data + dYdX perp data both available via existing scripts. Implementation:
1. Pull Coinbase BTC-USD spot mid.
2. Pull dYdX BTC-USD perp oracle/mid + next funding rate.
3. When `basis + funding_implied_bps > min_edge`, place opposing legs.
4. Monitor basis; close at convergence or stop on funding flip.

**Refs.** Du/Lehalle (2024), "Crypto basis trading at scale." Bouchaud/Bonart/Donier/Gould, *Trades, Quotes and Prices* (Cambridge, 2018) — ch. 8.

---

### 3.3 Funding-rate capture (delta-neutral carry)

**Mechanism.** Subset of 3.2. When funding is reliably positive (longs pay shorts) and large, hold short perp + long spot, harvest funding payments. Symmetric for negative funding.

**Where it works.** Perp venues with funding rates that are positive for sustained periods. Hyperliquid, Binance, Bybit — and dYdX during certain regimes.

**What kills it.**
- **Reversion**: funding mean-reverts. Holding through a flip costs more than 8 hours of funding earned.
- **Asset volatility**: spot leg moves 5% → margin call on the perp leg → forced unwind.
- **Borrow cost** on the spot leg (if shorting spot).

**Edge magnitude.** Reported 10–25% APR delta-neutral on BTC at scale (2024+). Smaller for retail (smaller perp inventory, higher fee tier).

**Repo wiring.** Same flow as 3.2 but optimised for hold-time (days–weeks) rather than execution speed. Lives natively at T3 polling tier — no edge from sub-second decisions.

**Refs.** Bitstamp/Skew research notes (public); Hyperliquid funding history docs.

---

### 3.4 Triangular arb

**Mechanism.** Three assets that form a closed loop (A → B → C → A) should round-trip to identity. When they don't (Coinbase ETH/BTC × BTC/USDC ≠ ETH/USDC), trade the cycle.

**Where it works.** Single venue with multiple pairs (Coinbase, Binance, Kraken). On-chain DEXes (Uniswap pools across three tokens).

**What kills it.**
- **Vanishingly small windows**: arb is detected and closed in microseconds at top venues.
- **Maker/taker asymmetry**: round-tripping always pays at least one taker fee.
- **MEV bots own this on-chain**: on Uniswap, every public mempool tx is racing against searchers.

**Edge magnitude.** 0–1 bps on Coinbase intra-venue (arbed away constantly). 5–50 bps on-chain when it appears, but you're racing block builders.

**Repo wiring.** Not viable here without bundle submission. Listed for completeness.

**Refs.** Flashbots research; Daian et al. (2020), "Flash Boys 2.0."

---

### 3.5 Statistical arb / pairs (cointegrated assets)

**Mechanism.** Two assets that historically move together (BTC/ETH, ETH/SOL, two BTC perps on different venues). When their ratio diverges from the long-run mean, go long the cheap one and short the rich one, expecting reversion.

Formally: fit a cointegrating vector `β` such that `Y_t − β X_t ~ stationary`. Trade the spread `Z_t` when `|Z_t| > z_threshold × σ_Z`.

**Where it works.** Crypto pairs with regime-stable correlation: BTC/ETH on long horizons, BTC perp on dYdX vs BTC perp on Hyperliquid (both reference the same underlying).

**What kills it.**
- **Regime breaks**: 2022 LUNA collapse decorrelated ETH from BTC for weeks. Pure stat-arb books were wiped out.
- **Cointegration drift**: the β you fit on 2024 data isn't valid for 2025.
- **Capacity**: at scale, your own trading moves the ratio.

**Edge magnitude.** 0.5–2% per round trip on classic pairs; pairs hold for hours to days. Sharpe 1–2 historically; lower with crowding.

**Repo wiring.** Excellent fit at T3. Implementation:
1. Pull two correlated time series via Indexer / Coinbase REST.
2. Fit OU process or rolling cointegration.
3. Enter when z-score crosses ±2; exit on mean-reversion or stop-loss.
4. Both legs are perps → no borrow cost.

**Refs.** Avellaneda/Lee (2010), "Statistical arbitrage in the U.S. equities market." For crypto: Petukhina et al. (2021), "Statistical arbitrage in cryptocurrency markets."

---

### 3.6 Latency arb (one venue lags another)

**Mechanism.** Venue A's price moves; venue B's price hasn't updated yet because their feed/matching is slower. Pick off venue B before it catches up.

**Where it works.** Cross-venue with verifiable latency differential. Classic: Binance leads, smaller exchanges follow. CME futures lead spot on macro news.

**What kills it.**
- **Latency parity arms race**: any persistent lag of 50+ ms is being exploited by HFT firms with µs latency. By the time you (at 80 ms) detect it, the gap is closed.
- **Adverse selection**: the venue you're picking off has its own maker base that pulls quotes fast. You're racing them.

**Edge magnitude.** Pure speed race. **Effectively zero at T3.** Listed for awareness — you don't want to *be* the lagged venue's pickoff target. Cancel quotes when external references move sharply.

**Repo wiring.** As a *defence* (the inverse of the pattern), it belongs in the MM toxic-flow filter — pull quotes when a leading reference (Binance, Coinbase) moves past a threshold.

**Refs.** Aquilina/Budish/O'Neill (2022), "Quantifying the high-frequency trading 'arms race'." *Quarterly Journal of Economics*.

---

### 3.7 Cross-protocol arb (CEX ↔ DEX, perp ↔ on-chain)

**Mechanism.** A DEX's AMM price drifts from CEX. Bridge the asset (or use a flashloan for atomic execution on-chain) and arb.

**Where it works.** Uniswap V3, Curve pools, Polymarket binary tokens (CTF) vs implied probability from spot.

**What kills it.**
- **Bridging time/cost**: hours-to-days for inventory rebalance.
- **Gas/MEV**: searchers run this pattern with bundles. You can't outbid them publicly.
- **Slippage on AMMs**: large trades through Uniswap pay disproportionate slippage.

**Edge magnitude.** Highly variable. Polymarket-vs-Coinbase BTC binary arb has paid 50–500 bps during fast moves but requires sub-block reaction.

**Repo wiring.** Polymarket-vs-spot is partially wired in `src/lib/hft/polymarket-btc.ts`. The "is the binary implied probability inconsistent with the current spot move?" check is exactly this pattern.

**Refs.** Flashbots searcher docs; Heimbach/Wattenhofer (2022), "SoK: Preventing transaction reordering manipulations in decentralized finance."

---

## 4. Microstructure signals

These aren't standalone strategies — they're inputs to the patterns above.

### 4.1 Order-book imbalance (OBI)

**Formula.**
```
OBI = (sum(bid_size) − sum(ask_size)) / (sum(bid_size) + sum(ask_size))
```
Computed at the top N levels (N = 1, 5, or 10).

**Predictive content.** OBI at L1 has strong short-horizon (5–500 ms) predictive power for the next price move. Heavy bid side → price tends to go up.

**Use.**
- MM: skew quotes asymmetrically when OBI persists.
- Lead-lag: enter taker direction matching OBI signal at a lagging venue.

**Failure modes.** Spoofing (cancelled walls) inflates OBI. Use the *executed* trade imbalance instead of *visible* book imbalance for robustness.

**Refs.** Cont/Kukanov/Stoikov (2014), "The price impact of order book events." *Journal of Financial Econometrics* 12(1).

---

### 4.2 Trade-flow toxicity (VPIN)

**Mechanism.** Bucket trades by equal volume (not time). Compute `|buy_vol − sell_vol| / total_vol` per bucket. The rolling mean of this metric is VPIN.

High VPIN → informed flow → market makers should widen / pull quotes.

**Use.**
- Pre-fill filter for MM. If VPIN is rising, suspect adverse selection on the next fill.
- Trigger for halting trading entirely during informational events.

**Failure modes.** Backward-looking; lags real events by 1–5 minutes at T3 latencies. Better as a pause signal than an entry signal.

**Refs.** Easley/López de Prado/O'Hara (2012); subsequent literature debated VPIN's actual predictive power.

---

### 4.3 Trade-sign autocorrelation

**Observation.** Buy and sell trades arrive in serially-correlated runs. A buy print is followed by another buy more often than chance.

**Use.** Direct alpha — small but persistent. Combine with OBI: if trade flow is bullish *and* OBI is bullish, conviction is higher.

**Failure modes.** Mean-reverting at longer horizons. Combine with volatility filter — autocorrelation strongest during calm regimes.

**Refs.** Bouchaud et al., *Trades, Quotes and Prices*, ch. 6.

---

### 4.4 Microprice (already in §2.2)

Use as quoting reference; sometimes also as the "fair" against which all PnL is marked.

---

### 4.5 Cancel-replace rate (book activity intensity)

**Observation.** When the cancel/replace rate on one side of the book spikes, someone is jockeying for queue position. Often precedes a directional move.

**Use.** Pull MM quotes preemptively when cancel rate on the side you're quoting heats up.

**Failure modes.** Needs message-stream access. Indexer REST doesn't expose this — you'd need WS subscription to subaccount + market channels and bucket events yourself.

**Refs.** Lehalle/Laruelle, *Market Microstructure in Practice* (World Scientific, 2018) — ch. 4.

---

### 4.6 Iceberg / hidden-liquidity detection

**Observation.** A price level that "should" have been consumed (best ask of size 10 took a buy of size 10) but the level reloads instantly with similar size — that's an iceberg. There's hidden depth.

**Use.** Adjust microprice / quoting reference: don't quote inside a known iceberg level; trying to skip the queue at a hidden wall is futile.

**Failure modes.** Some venues randomise iceberg display size; detection is probabilistic.

**Refs.** Hautsch/Huang (2012), "The market impact of a limit order." *Journal of Economic Dynamics and Control* 36(4).

---

### 4.7 Sweep detection (multi-level taker)

**Observation.** A market buy that consumes 3+ levels of the book in one go is a *sweep*. Indicates urgency / informed flow.

**Use.** Treat sweeps as toxic-flow signals (widen) AND momentum signals (consider taker entry in the sweep direction at next venue if it's lagging).

**Failure modes.** False positives during low-liquidity hours.

**Refs.** Hasbrouck (2015), "Trading costs and returns for US equities: Estimating effective costs from daily data."

---

### 4.8 Quote-stuffing / spoofing artifacts

**Observation.** Rapid place-then-cancel cycles by a single participant (visible as cancellation-rich periods with no trades). Often illegal in regulated venues; common on permissionless DEXes.

**Use.**
- *Defensive*: ignore book state during quote-stuffing periods; use trade-flow-only signals.
- Don't ever try to do this. It's a regulatory red line where applicable.

**Refs.** Egginton/Van Ness/Van Ness (2016), "Quote stuffing." *Financial Management* 45(3).

---

## 5. Execution algos

Execution algos minimize cost when you must trade size, *given* a directional view. They are the difference between paying 100 bps in market impact vs 10 bps for the same trade.

### 5.1 TWAP (time-weighted average price)

**Mechanism.** Split a parent order of size `Q` into `n` equal child orders, executed over interval `T`. Average fill ≈ time-average price.

**Where it works.** Calm markets, no immediate information event. Standard baseline.

**Failures.** Naïve TWAP is detectable — bots front-run the predictable cadence. Mitigations: randomise slice size ±20%, randomise inter-slice interval, swap between maker (limit-on-top) and taker (cross-spread) randomly.

**Edge magnitude.** Reduces market impact by 30–70% vs sending the parent as a single market order.

**Refs.** Almgren/Chriss (2001), "Optimal execution of portfolio transactions." Cartea et al., ch. 6.

---

### 5.2 VWAP (volume-weighted average price)

**Mechanism.** Forecast a U-shaped daily volume profile (high open/close, low mid-session). Slice the parent order to match — large slices during high-volume periods, small slices during quiet.

**Where it works.** Spot equity / spot crypto with predictable session volume. Crypto's 24/7 reduces the U-shape but the pattern still applies to weekday US-hours flow.

**Failures.** Volume profile changes regime; today isn't yesterday. Adaptive VWAP that re-estimates per minute is more robust.

**Edge.** Beats TWAP by 5–15 bps on parents > $1M depending on asset.

**Refs.** Madhavan (2002), "VWAP strategies." Berkowitz/Logue/Noser (1988) — original cost-measurement paper.

---

### 5.3 Implementation Shortfall (Almgren–Chriss)

**Mechanism.** Trade off market impact (worse if you trade fast) vs price risk (worse if you trade slow). The optimal trajectory under a quadratic impact + Gaussian price process is exponential decay of remaining inventory:

```
x(t) = X × sinh(κ(T − t)) / sinh(κT)
```

where `κ = √(λ σ² / η)`, `λ` = risk aversion, `σ` = volatility, `η` = temporary impact coefficient.

**Where it works.** Anywhere you have a calibrated impact model. In practice you tune by backtest.

**Failures.** Impact model is hard to calibrate per asset per regime. Real flow doesn't follow a smooth trajectory.

**Edge.** Optimal under model assumptions; beats VWAP on assets where impact dominates risk and vice versa.

**Refs.** Almgren/Chriss (2001).

---

### 5.4 POV (percentage-of-volume)

**Mechanism.** Trade as `α × market_volume` per interval. `α = 5%` means "I want to be 5% of the tape." Adapts to real-time volume rather than forecast.

**Where it works.** When you genuinely need to be filled "with the market" — institutional fund rebalancing, index tracking.

**Failures.** Predictable cadence (5% every interval) is itself a signal others can exploit. POV + randomisation is the production form.

**Refs.** Lehalle/Laruelle, ch. 5.

---

### 5.5 Iceberg / hidden orders

**Mechanism.** Place a large order with most of its size hidden. Only the *display size* shows on the book; as the visible portion fills, more is exposed.

**Where it works.** Venues that natively support iceberg type (Coinbase Exchange, dYdX — check the order types). Reduces market impact by hiding the true size.

**Failures.** Detectable (§4.6). Some venues charge extra for hidden type or give them lower queue priority.

**Refs.** Bessembinder/Panayides/Venkataraman (2009), "Hidden liquidity: An analysis of order exposure strategies."

---

### 5.6 Adaptive arrival-price / IS algos

**Mechanism.** Re-plan the schedule every N seconds based on current state: how much is left, what's the current price relative to arrival, what's recent volume, what's volatility. Closed-loop control.

**Where it works.** Larger parents on volatile assets where the static IS schedule degrades.

**Failures.** More complex; more parameters to tune.

**Refs.** Almgren (2003), "Optimal execution with nonlinear impact functions and trading-enhanced risk." *Applied Mathematical Finance* 10(1).

---

### 5.7 Smart order routing (SOR)

**Mechanism.** Given multiple venues for the same asset, route each child order to the best instantaneous venue by (fee + expected slippage + fill probability).

**Where it works.** Multi-venue crypto pairs (BTC/USD on Coinbase, Kraken, Binance). For perps: BTC-PERP on Hyperliquid, dYdX, Binance.

**Failures.**
- Stale prices: the venue you routed to may have moved by the time the order arrives.
- Fee-tier asymmetries: cheaper to fill on a single venue at scale.

**Edge.** 1–10 bps depending on liquidity dispersion. Larger when one venue is liquid and others are thin.

**Refs.** Foucault/Menkveld (2008), "Competition for order flow and smart order routing systems." *Journal of Finance* 63(1).

---

### 5.8 Pegged / floating orders

**Mechanism.** Order price floats with the reference (e.g., always 1 tick inside best bid). Useful for passive execution that follows the book without re-quoting overhead.

**Where it works.** Venues that natively support pegged orders (some equity ATSs; dYdX does NOT natively).

**Repo wiring.** On dYdX, emulate via short-term orders that re-quote every block.

**Refs.** SEC Rule 612 (sub-penny pricing) background.

---

### 5.9 Anti-detection / randomisation

**Tactics.** Across all execution algos:
- Randomise child sizes (±20%).
- Randomise child intervals (±50%).
- Randomise venue selection in SOR.
- Mix maker and taker slices probabilistically.
- Send dummy cancels to obscure real intent (regulatorily questionable).

**Why.** Predictable execution is profitable for others to predict. The simplest defence is noise.

---

## 6. Risk & kill-switch patterns

Not strategies — survival mechanisms. The absence of these turns positive-EV strategies into negative-EV ruin.

### 6.1 Inventory caps

Hard ceiling on `|signed_inventory|` per market and across markets. Above the cap, suppress the side that grows inventory. Already in `src/lib/hft/dydx/mm.ts` as `maxInventoryUsd`.

### 6.2 Spread anomaly halts

If quoted spread suddenly widens 5×, pause for 30 seconds. Usually indicates a market event the system hasn't priced.

### 6.3 Stale-data halts

If the indexer / WS feed hasn't ticked for `> N × normal_cadence`, halt. Trading on stale data is the #1 source of slow-bleed losses.

### 6.4 Cancel/replace flood control

If your cancel rate exceeds the venue's throttle, the venue rejects and you become un-quoteable on one side. Pre-emptively throttle your own cancel rate well below the venue's limit.

### 6.5 Daily-loss circuit breakers

Cap `|total PnL since UTC midnight|`. When tripped, halt all trading until manual reset. Defends against silent strategy drift.

### 6.6 Per-fill sanity checks

If a fill arrives at a price > 2σ from your quote target, treat it as an error and pause. Most common cause: bug in tick-rounding or stale reference.

### 6.7 Cross-system halts

If one venue's safety gate trips (e.g., Coinbase order-rate throttle), pause all related venues. A bug that surfaces in one place is usually a bug everywhere.

### 6.8 Heartbeat to external observer

Send a pulse to a separate monitoring system every N seconds. If the pulse stops, an out-of-band watchdog stops the process. Defends against process hangs that don't crash.

---

## 7. Crypto-specific gotchas

### 7.1 Gas and priority fees (on-chain)

Anything on Ethereum mainnet pays gas. During a 50 gwei → 500 gwei spike, your latency arb has +$30–$100 per attempt. Build gas cost into every on-chain pattern's net edge.

### 7.2 MEV (block-builder reordering)

On Ethereum/L2s, your transaction is reordered by block builders. Public mempool tx loses to bundles. For any on-chain pattern, assume you're the slow boat unless you submit through Flashbots/MEV-Share/private mempools.

### 7.3 Slot leaders (Solana)

On Solana, the current validator (slot leader) sees your tx first and can sandwich. Bundling through Jito mitigates.

### 7.4 Oracle lag (DeFi/CLOB DEXes)

dYdX's oracle price (used for liquidations) lags the matched price during fast moves. Strategies that rely on `oraclePrice == fair` are wrong during volatility. Use matched-trade VWAP or microprice for fair-value during stress.

### 7.5 Funding-rate clocks

Funding settles every 8h on most perps, every 1h on dYdX. Strategies must know which clock applies; a strategy backtest using daily funding misses 90% of the dynamics.

### 7.6 Withdrawal limits

Coinbase tops out at $10k/day withdrawal for some accounts; dYdX requires `withdrawableUSDC > epsilon` (numerical issues at low balances). Plan inventory rebalance around these limits, not in spite of them.

### 7.7 KYC/sanctions screens

Some venues (Coinbase, Binance US, Polymarket via Polymath subprocess) screen wallets. Funding from a flagged address bricks the account. Use clean funding paths for production wallets.

### 7.8 Exchange downtime

Coinbase has had 6+ hour outages during major moves. dYdX validators have soft-halted. Build the system to detect "exchange returns 5xx" → halt all venues touching that pair.

---

## 8. This repo: where each pattern fits

A pragmatic mapping from the patterns above to this codebase's wiring.

### Wired or nearly wired

| Pattern | Location | Status |
|---------|----------|--------|
| Quote-driven MM | `src/lib/hft/dydx/mm.ts` + `mm-engine.ts` + `dydx-mm.ts` script + `/hft/dydx` UI | **Live testnet** |
| Inventory-skewed MM | `cfg.skewBpsPerDollar` in `mm.ts` | **Live testnet** |
| Drift-based quote replace | `shouldReplace()` in `mm.ts` | **Live testnet** |
| Polymarket BTC binary MM | `src/lib/hft/polymarket-btc.ts` + `strategies.ts` | **Wired** (Polymarket adapter) |
| Cross-venue edge calc | `src/lib/hft/edge.ts` | **Static** (calculator only) |
| Indexer REST data layer | `src/lib/hft/dydx/clients.ts` | **Live** |
| Indexer WS data layer | `scripts/test-dydx-ws.ts` | **Probed**, not yet used in a strategy |

### Easy adds on this stack

| Pattern | Effort | Notes |
|---------|--------|-------|
| Microprice quoting | 0.5d | Pull top bid/ask sizes; swap `oraclePrice` for `microprice` in `computeQuotes()` |
| Multi-level laddered MM | 1d | Refactor `computeQuotes()` to return arrays |
| Spot-perp basis monitor | 1d | Coinbase BTC + dYdX BTC, log basis to SQLite + threshold alerts |
| Funding capture log | 0.5d | Pull dYdX funding history, plot vs realised |
| Statistical pairs (BTC/ETH) | 2–3d | Rolling cointegration + OU signal on Indexer candles |
| Toxic-flow filter for MM | 1–2d | OBI + trade-sign autocorrelation gate before each quote replace |
| TWAP child slicer | 1d | Standalone executor that drives `composite.placeOrder` |
| Stale-data + spread-anomaly halts | 0.5d | Wrappers around the engine's snapshot path |

### Hard or out-of-scope at T3

| Pattern | Why not |
|---------|---------|
| Queue-position MM | Sub-ms latency required |
| Latency arb (offensive) | Co-location required |
| Triangular arb on Uniswap | MEV bundle access required |
| Direct iceberg detection | Needs full message stream, not poll snapshots |

---

## 9. The honest take

After surveying the literature, the patterns that actually pay at this repo's T3 latency tier and at single-operator scale, in priority order:

1. **Polymarket BTC binary MM** with a calibrated fair-prob model. The 0 bps maker fee + 20 bps rebate is uniquely generous; the question is whether your prob model has 50+ bps of signal over the consensus. This codebase has the most infrastructure here already.
2. **Spot-perp basis on Coinbase + Hyperliquid (or dYdX testnet → mainnet later)**. Funding capture at T3 is a multi-hour holding pattern; latency is a non-issue. Capital-intensive but real.
3. **Inventory-skewed maker on dYdX/Hyperliquid liquid perps**. The MM engine here works; the next move is microprice + a toxic-flow filter to survive informed flow at the per-fill level.
4. **Statistical arb BTC vs ETH on candle data**. T3-friendly, capital-light, well-studied. Sharpe ~1 if you don't overfit; backtests easy to construct from Indexer candle history.
5. **Cross-venue OBI lead-lag** (defensive). Don't try to *be* the fast one; instead, use Binance/Coinbase as a leading reference and pull dYdX quotes pre-emptively when the lead moves.

The patterns that *sound* exciting but won't work here: queue-position games, sub-second latency arb, triangular arb on AMMs, anything requiring co-located silicon.

---

## 10. References (canonical list)

**Books**
- Cartea, Jaimungal, Penalva. *Algorithmic and High-Frequency Trading.* Cambridge, 2015.
- Bouchaud, Bonart, Donier, Gould. *Trades, Quotes and Prices.* Cambridge, 2018.
- Lehalle, Laruelle. *Market Microstructure in Practice.* World Scientific, 2018.
- Hasbrouck. *Empirical Market Microstructure.* Oxford, 2007.

**Papers (with year)**
- Almgren, Chriss (2001), "Optimal execution of portfolio transactions."
- Avellaneda, Stoikov (2008), "High-frequency trading in a limit order book."
- Cont, Kukanov, Stoikov (2014), "The price impact of order book events."
- Easley, López de Prado, O'Hara (2012), "Flow toxicity and liquidity in a high-frequency world."
- Avellaneda, Lee (2010), "Statistical arbitrage in the U.S. equities market."
- Stoikov (2018), "The micro-price."
- Aquilina, Budish, O'Neill (2022), "Quantifying the high-frequency trading 'arms race'."
- Makarov, Schoar (2020), "Trading and arbitrage in cryptocurrency markets."
- Daian et al. (2020), "Flash Boys 2.0."
- Madhavan (2002), "VWAP strategies."

**Crypto-specific resources**
- Hyperliquid docs: https://hyperliquid.gitbook.io/hyperliquid-docs
- dYdX v4 docs: https://docs.dydx.xyz
- Flashbots research: https://writings.flashbots.net
- Polymarket developer docs: https://docs.polymarket.com

---

*Last updated: 2026-05-29. The patterns are stable; their edge magnitudes
decay continuously as competition tightens. Re-measure before sizing.*
