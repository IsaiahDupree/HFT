# Gap-analysis report: Daniro 2026-05-25 article vs our stack

**Source article:** `daniro-2026-05-25-1000-polymarket-bots.md` (same directory)
**Date of this report:** 2026-05-26
**Classifications run:** all 5 wallets from the article have been classified through `npm run classify:wallet --persist`

---

## TL;DR

The article catalogs **6 bot archetypes** and **6 infrastructure layers**. We already have **4 of 6 layers** built and detect **4 of 6 archetypes**. The two architectural gaps worth filling:

1. **Cross-timeframe spread detector** — 5m vs 15m BTC markets that drift apart create the article's "z-score" arb. We don't yet measure this.
2. **Orderbook imbalance signal** — we pull orderbook depth via `poly.book` but don't run skew analytics on it.

The "near-resolution scraper" pattern is already detectable by our classifier (we caught 0x6e1d5040 doing exactly this), but we **don't yet have a STRATEGY that executes it** — only the observer. That's the highest-leverage immediate build.

---

## Wallet classifications (all 5 from the article)

| Article wallet | Article claim | Our classification | Our reading |
|---|---|---|---|
| `@bonereaper` | "$100 in 1 minute" example | **hft_bot** (95%) | 14,845 fills/day across 683 markets — pure latency arb |
| `@0x6e1d5040…d0fa` | "definitely knows how to use [the lag]" | **conviction_trader** (90%) | $2M realized; near-resolution NO-side scraping at scale |
| `@0xb55fa1296…d4` (Hermes) | "Arb between 5/15 min" | **hft_bot** (prior classification) | Crypto correlated-basket bot — directional intraday |
| `@0xce25e214…7fdc` | "Stoikov-style logic" | **hft_bot** (95%) | 8,536 fills/day across 1,024 markets — speed-driven, $109K realized in 0.06d window |
| `@flippingsharks` | "10 days — $46k PnL" | **hft_bot** (95%) | 940 fills/day across 199 markets — same archetype, lower pace |

**Important finding:** 4 of the 5 wallets the article showcases as success stories are **un-copyable HFT bots**. Only `0x6e1d5040` is `potentially_copyable`. This confirms our core thesis: **the article's wallet selection is curated marketing — most of these aren't the wallets you'd actually copy.**

---

## The article's 6 bot archetypes — what we cover

| Archetype | Have? | Where in our stack | Gap |
|---|:---:|---|---|
| **1. Pure Arbitrage** (YES+NO < $1) | ✅ partial | `/arb` (single-market basket) + `/arb/comb` (combinatorial LP-based) | Manual today — could add an automated opportunistic scanner that polls all markets for YES+NO < threshold |
| **2. Directional Arbitrage** | ⚠️ partial | Same arb engine + capsule sizing | No "arb-base + directional lean" composite strategy class yet |
| **3. Repricing / Fair Value** (Binance feed vs Polymarket) | ✅ partial | `src/lib/coinbase/*` provides spot price feed — we use Coinbase not Binance, but same idea. Crypto-live page (`/crypto`) cross-references | We don't yet have a worker that auto-detects Polymarket lag vs Coinbase tick and emits a `repricing-signal` event |
| **4. Cross-Timeframe** (5m vs 15m spread) | ❌ missing | No detector | **Build candidate #1 — see below** |
| **5. Imbalance** (orderbook skew) | ❌ missing | `poly.book(tokenId)` returns L2 depth but we don't run imbalance analytics | **Build candidate #2 — see below** |
| **6. Near-Resolution** (price 0.95→1.0 scrape) | ⚠️ detected, not executed | Classifier catches the wallet pattern (0x6e1d5040 = $2M doing this) but we have no strategy class that does it automatically | **Build candidate #3 — highest priority — see below** |

---

## The article's 6 infrastructure layers — what we cover

| Layer | Author's spec | Our equivalent | Gap |
|---|---|---|---|
| 1 — **Brain** | Claude + Qwen3-Coder, parallel via Claude Squad | Claude Haiku 4.5 with cached prompts via Anthropic OAuth; `src/lib/agents/oracle-llm.ts` | No multi-model ensemble. Qwen3-Coder unused. Single instance, not parallel. |
| 2 — **Orchestration** | Bull/Bear/Risk consensus with veto | Stage-gated router (`src/lib/venue/router.ts`) + capsules + kill switch | Different architecture: we use stage gates + envelope risk, not consensus voting. Functionally equivalent (both block bad trades). |
| 3 — **Data & Signals** | OpenBB (100+ sources) + Binance + fredapi + on-chain | Polymarket Data API + Coinbase Advanced Trade + viem on-chain CTF Exchange | Missing: Binance feed, OpenBB, macro/fred. Coinbase is comparable to Binance for crypto spot. |
| 4 — **Market Intelligence** | Polyscope, Polywhaler, HyperBuildX | Our own scanner stack: `scan:leaderboard`, `scan:wallets`, `scan:consensus`, `observe:wallet`, **typology classifier** | We have parity with their "intelligence" layer. Our typology classifier is a feature they don't claim. |
| 5 — **Backtest & Simulation** | Historical replay with fees + slippage | `scripts/backtest.ts` + parameter-sweep backtester (median of 5 perturbed configs) | We have this. Parameter sweep is more rigorous than what the article describes. |
| 6 — **Risk / Sizing** | Fractional Kelly + kill switches | `src/lib/quant/formulas.ts` has `kellyFraction()` (Quarter Kelly default). Risk engine has kill switch + daily-loss + halt. | We have this. Their `lam=0.25` matches our Quarter Kelly default. |

---

## The article's math — direct mapping

| Article formula | Our module |
|---|---|
| `bayes_update(prior, like_true, like_false)` | `bayesianUpdate()` in `src/lib/quant/formulas.ts` |
| `net_edge(model_p, market_price, cost)` | `expectedValue()` in same file (different parameterization, same idea) |
| `fractional_kelly(p, b, lam=0.25)` | `kellyFraction()` in same file, default fraction 0.25 (Quarter Kelly) |
| Cross-market spread `z-score` | **NOT BUILT** — gap |

---

## The 3 highest-leverage gaps to fill (ranked)

### #1: Near-resolution scraper strategy (executor, not detector)

We **detected** 0x6e1d5040 making $2M doing this. We have a fully-built venue router + capsules + Kelly sizing. The build is:

- `scripts/strategy-near-resolution-scrape.ts` — long-running worker
- Polls markets where `endDate < now + 14d` AND `bestAsk > 0.95 AND bestBid > 0.93` (configurable)
- For each: estimate edge as `(1.0 - midPrice) × confidence_in_outcome - fees`. Confidence comes from price (>0.97 = ~97% confidence the market WILL resolve that way)
- Kelly-size the NO position, submit through venue router (sim by default; `NRS_LIVE=1` to arm)
- Daily cap, per-market cap, capsule-bound

This is a **mechanical strategy with $2M proof-of-concept**. Estimated build: 4-8 hours.

### #2: Cross-timeframe spread detector

5m and 15m BTC markets for the same window often diverge briefly. The arb is: when the 5m has fully repriced but the 15m hasn't, buy the cheap side of the 15m.

Build:
- `src/lib/strategies/cross-timeframe-spread.ts` — pure detector
- Given (5m_market, 15m_market, both subscribed via real-time data client), computes implied 15m prob from 5m direction + position-in-window
- Emits `cross-timeframe-spread` event when `z-score > 3.0`
- Pairs with the binaries page (`/binaries`) which already lists Polymarket short-duration crypto markets

Estimated build: 6-10 hours.

### #3: Orderbook imbalance signal

Each Polymarket binary market has an L2 orderbook. We pull it via `poly.book()` but don't analyze it. The signal: when bid-side depth at the top 3 levels is 3× ask-side depth (or vice versa), there's a real microstructure pressure that often precedes a price move within seconds.

Build:
- `src/lib/strategies/orderbook-imbalance.ts` — pure detector
- Subscribe to top-of-book WS for a set of markets
- Compute rolling imbalance ratio; emit `orderbook-skew` event when |imbalance| > threshold
- Compose with existing capsules

Estimated build: 4-6 hours.

---

## What's NOT worth building from the article

- **Multi-LLM ensemble (Bull/Bear/Risk voting agents)** — our stage-gated router + capsule envelope achieves the same safety property at lower complexity. Adding voting agents is a refactor, not a new capability.
- **Binance feed (replacing Coinbase)** — Coinbase data quality is fine. Switching introduces an API surface we'd need to maintain for marginal latency gain.
- **OpenBB / fredapi macro data** — these are useful for slow markets (elections, geopolitics) but the article's whole thesis is about FAST markets where macro data is irrelevant.

---

## Confirmation of our existing architecture

The article's framework **explicitly endorses** several decisions we made:

- ✅ "Kill switches" — we have `src/lib/risk/kill-switch.ts`
- ✅ "Fractional Kelly with lam=0.25" — we default to Quarter Kelly
- ✅ "Backtest with fees + slippage" — our parameter-sweep does this
- ✅ "Whale trackers + leaderboards" — `scan:leaderboard` + `scan:wallets`
- ✅ "Inventory limits" — our capsule `open_position_qty` cap
- ✅ "Stoikov-style execution" — we have the building blocks (refPrice, limit/market types, capsule cooldowns); a Stoikov-specific adaptive-aggressiveness module would be additive but not foundational

---

## Action items in priority order

1. **Build the near-resolution scraper strategy** — proven by 0x6e1d5040 doing $2M of it
2. **Build cross-timeframe spread detector** — direct adaptation of the article's z-score formula
3. **Build orderbook imbalance signal** — leverages data we already pull but don't use
4. **Add 2 new article wallets to observer** — `0xce25e214…` + `0xc387c2a40d…` (flippingsharks)
5. **Add Polymarket-mass-arb scanner** — automated YES+NO < $1 detector that emits to `evolution_log`

---

## Honest assessment of the article

**Useful parts** (technically credible):
- The 6 archetypes are a clean taxonomy that maps onto observable microstructure
- The math snippets (Bayes, Kelly, z-score) are all real and well-known
- The "speed vs. opinion" framing is accurate for short-duration markets
- The 4 human-trader-failure modes (late entries, inconsistent sizing, fatigue, drawdown psych) are well-documented in behavioral finance

**Marketing parts** (treat skeptically):
- "$100K/month" headline is unsourced
- All 5 wallet links carry `?via=dan-kwpx` paid-affiliate parameter
- "1000 bots analyzed with Claude" claim has no methodology
- The wallet PnL screenshots in the article are mark-to-market on open positions, not banked realized PnL (we verified bonereaper's flashy $19K was MTM, real banked is $199K — different number)

**Net call:** Worth archiving. The taxonomy is genuinely useful as a checklist of what to build. The marketing skin doesn't invalidate the underlying technical claims.
