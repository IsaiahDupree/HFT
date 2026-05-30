# Latency Arbitrage

> **Family:** 5 — Latency arbitrage
> **Variants covered:** cross-venue stale-quote (T0-T1 only) · futures→cash lead-lag · listing/delisting front-run · oracle update front-run (on-chain OEV) · DEX-CEX stale-oracle arb
> **Repo modules:** `src/lib/hft/polymarket-btc.ts` (oracle-style arb, Polymarket vs CEX) — the only latency variant this repo's tier supports
> **Cross-asset coverage:** US equities (mostly out of reach) · crypto spot (selective) · crypto perps (selective) · DeFi (the accessible variants live here)

---

## 1. TL;DR

Same instrument, two venues, one venue's price hasn't caught up yet.
Trade against the stale side. The whole strategy is an engineering
exercise: who sees the price-leader's update first.

**Brutal truth:** classical latency arbitrage on liquid markets is owned
by ~10 firms globally (Citadel, Virtu, Jump, Tower, Optiver, IMC, plus a
handful of others) who spend millions per year on microwave links,
co-located servers, and FPGA-accelerated decoders. A 2026 court filing
shows that a *3.2-nanosecond* speed advantage on Eurex was worth €75M
annual revenue.[^mosaic2026] This is not a retail edge.

But four variants of "latency arb" *are* accessible at slower tiers
because the latency budget is wider:

1. **Futures→cash lead-lag** (T1-T2): when futures and the cash underlying are at different venues and the futures leads price discovery (it almost always does). Examples: ES → SPY, NQ → QQQ, CME BTC future → spot BTC. The lag is 1-50ms; still hard but possible with a good cloud setup.
2. **Listing/delisting front-run** (T2-T3): when a venue announces a new coin will be added, demand spikes 30-300s before the venue's matching engine accepts it. A bot positioned at the *other* venues that already list the coin captures the front-run.
3. **Oracle update front-run** — on-chain OEV (T2-T4): blockchain oracles update price feeds in finite, observable transactions. A bot can preempt liquidations or arb positions in the *next* block by submitting transactions sandwiching the oracle update.
4. **DEX-CEX stale-oracle arb** (T3): DEX prices lag CEX during fast moves; the gap closes in 15-60s as on-chain arbitrageurs sync. Single-block arb is owned by MEV searchers, but multi-block lag is reachable from a regular server.

This doc tells you which variants are worth pursuing at this repo's T3
tier and which are honest "do not attempt." The one already-implemented
variant in the repo is `src/lib/hft/polymarket-btc.ts` (Polymarket
binary vs CEX BTC oracle).

---

## 2. Mechanism

### 2.1 The basic structure: leader, lagger, race

Every latency-arb variant has the same shape:

- **Leader venue.** The price moves here first (most informed flow lives here, or it's structurally faster).
- **Lagger venue(s).** Same instrument; takes time to receive and process the leader's update.
- **The arb.** Read leader → predict where lagger will be → trade against lagger's current (stale) quote → close when lagger updates.

The "time" can be:
- **Wire latency** (T0): microwave + co-located server. Single-digit µs vs hundreds of µs for lagger receiving.
- **Software latency** (T1): kernel-bypass NIC + FPGA decoder, single-thread C++.
- **Network latency** (T2): same-cloud-region but no co-lo. 10-100ms cross-venue.
- **Cloud latency** (T3): different regions, REST polling. 100-1000ms.
- **Block latency** (T4): waiting for next blockchain block. 1-15s on Ethereum, sub-second on Solana.

T0-T1 is the firm-level race. T2-T4 is where retail can play *if and
only if* the leader-lagger gap is wide enough to absorb the bigger
latency budget.

### 2.2 Futures→cash lead-lag

In US equities, **futures lead the cash index** by a few milliseconds
during regular hours. The ES (S&P 500 mini futures, traded at CME
Globex) typically moves 5-50ms before the SPY (S&P 500 ETF, traded at
NYSE Arca and others). The lag is real and persistent because:

- CME publishes ES quotes via direct line; SPY arbitrageurs need to receive ES, decide, then route to NYSE.
- Different physical co-lo data centers (CME in Aurora IL, NYSE in Mahwah NJ — 700+ miles, ~4ms round-trip even on microwave).

The trade: when ES moves up sharply, *predict* that SPY will rise within
the next 5-50ms; buy SPY at its current (stale) ask. When SPY's quote
updates, sell.

**Equivalent in crypto:**
- CME Bitcoin futures → spot BTC on Coinbase. Lag 10-200ms (the link is over public internet, not microwave).
- Binance USDM perp BTC → spot BTC on Coinbase. Lag 5-50ms during US/EU hours.
- Hyperliquid perp ETH → Coinbase ETH spot. Lag 20-100ms.

The crypto variants are technically more accessible than the equities
version because no exchange has invested in microwave links between
crypto venues. The competition is *much* lower (smaller PnL pool); but
the absolute lag is also larger, opening the door to T2 retail.

### 2.3 Listing front-run

A venue announces a coin will be listed at a specific time (e.g.
"Coinbase will list FOO at 16:00 UTC tomorrow"). Two things happen:

- **At other venues** (Binance, Kraken, etc.) where FOO already trades, demand spikes.
- **At Coinbase**, the matching engine accepts FOO orders at 16:00 UTC; the first few seconds see a massive price-discovery move (often +20-50%).

**Trades that work:**
- Pre-position long FOO on other venues 30-300s before the listing event. Close into the Coinbase price spike when prices converge.
- For *delistings*, pre-position short on the about-to-delist venue and long on remaining venues (capture the discount as forced sellers exit).

**Latency requirement:** T2-T3. The headline announcement is on Twitter
or a venue blog; news-scraping bots get it within seconds. The arb
window is *minutes*, not microseconds — listing announcements are
slow-moving events relative to HFT.

### 2.4 Oracle update front-run (on-chain OEV)

Blockchain oracles like Chainlink and Pyth update price feeds on-chain
via observable transactions.[^oracle2024] Each update can cause:

- **Liquidations** in DeFi lending protocols (Aave, Compound) when collateral falls below the threshold.
- **Arbitrage opportunities** between DEXes whose AMMs price using the oracle vs. those that don't.

A specialized bot ("OEV searcher") can:
- Monitor the mempool for oracle update transactions.
- Calculate which loans become liquidatable post-update.
- Submit liquidation transactions in the *same block*, sandwiching the oracle update.

Chainlink has built infrastructure (Smart Value Recapture, SVR) to
capture some of this OEV back for protocols.[^chainlink_svr] Pyth has
its Global Orderflow Auction (GOFA) doing similar.[^pyth_gofa]

**Retail variant:** *not* sandwich-style same-block arb (which requires
relationships with MEV builders and is dominated by Flashbots-style
actors). Instead, *backrunning* — after the oracle updates, find
positions that *should* have been liquidated but weren't (because the
auto-liquidator was congested or paid insufficient gas), and capture
them in subsequent blocks. Lower edge per opportunity but accessible.

### 2.5 DEX-CEX stale-oracle arb

When CEX prices move sharply, DEX prices lag because:
- AMM prices update only when someone trades (no continuous quotes).
- Even with active arbitrage, the chain's block time imposes a floor (~12s Ethereum, ~400ms Solana).

The trade: monitor CEX price stream; when CEX moves N bps in M seconds,
check the DEX price; if DEX hasn't moved more than threshold, *trade on
the DEX* to capture the gap.

**Reality:**
- Ethereum mainnet: owned by MEV searchers running private relays. Out of retail reach.
- L2s (Arbitrum, Optimism, Base): partially accessible because there's less MEV competition.
- Solana: very fast block times; arb closes in 1-3 blocks; harder than L2s for an outside actor.
- DEXes on alt-L1s with thin MEV ecosystems (Sui, Sei): retail-accessible.

**Polymarket vs CEX oracle (the implemented variant in this repo):**
- Polymarket's binary BTC up/down markets price based on a CEX-implied probability.
- Polymarket's order book is updated by humans + slow market-making bots; it lags fast CEX moves by 5-60 seconds.
- `src/lib/hft/polymarket-btc.ts` computes the CEX-implied fair value; trades against Polymarket when the gap > threshold.

This is the canonical "stale-oracle arb" any retail HFT can run; it's
already in production-ready code in this repo.

---

## 3. Where it works

| Variant | Latency tier | Retail viable? | Capital scale | Notes |
|---|---|---|---|---|
| Cross-venue stale quote (BTC Coinbase ↔ Binance, ms) | T0-T1 | ❌ | n/a | Owned by Wintermute, GSR, Jump. Don't attempt. |
| Cross-venue stale quote (ms-scale, alt pairs) | T1-T2 | ⚠️ | $10k-$100k | Marginally accessible for long-tail pairs; tiny edges |
| Futures→cash lead-lag (equities ES→SPY) | T1 | ❌ | n/a | Citadel/Virtu territory |
| Futures→cash lead-lag (CME BTC futures → spot BTC) | T2 | ⚠️ | $25k-$500k | Doable with same-AWS-region cloud + WS feeds; ~$5-15 bps per opportunity, ~30-100/day |
| Lead-lag (perp BTC → spot BTC, intra-Binance) | T2-T3 | ✅ | $5k-$250k | Stays accessible because there's less competition; ~3-8 bps per fill |
| Listing front-run (Coinbase new asset) | T2-T3 | ✅ | $1k-$50k | Twitter / venue-blog scraping is the entry point; capacity limited by liquidity at the other venues |
| Oracle backrunning (missed liquidations) | T3 (multi-block) | ✅ | $10k-$200k | Monitor Aave/Compound liquidation queue post-oracle-update |
| Oracle sandwich (same-block) | T0 (block-level) | ❌ | n/a | MEV searchers with builder relationships |
| DEX-CEX arb on Ethereum mainnet | T0-T1 | ❌ | n/a | Flashbots searchers |
| DEX-CEX arb on L2 (Arbitrum/Optimism/Base) | T1-T2 | ⚠️ | $5k-$100k | Less MEV; needs RPC + transaction-builder setup |
| DEX-CEX arb on alt-L1s with low MEV | T2-T3 | ✅ | $1k-$50k | Sui, Sei, etc. Smaller pool, less competition |
| Polymarket vs CEX (binary oracle lag) | T3 | ✅ | $500-$50k | Live in this repo; thin books force capacity ceiling |

### 3.1 Latency-budget arithmetic

For any leader-lagger variant:

```
your_observation_to_decision_to_ack_latency < lag_between_leader_and_lagger
```

If the leader updates at `t = 0` and the lagger updates at `t = 50ms`,
you have a 50ms window. Cloud server in the same region with WS feeds
to both venues: 10-20ms observation + 5ms decision + 10-20ms ack = ~30ms
total. You fit, with margin.

If the lag closes to 5ms (better arb capital chasing it), you no longer
fit; another variant is needed.

---

## 4. Edge magnitude

| Variant | Per-fill edge (after fees) | Fills/day | Annualized on $50k capital | Source |
|---|---|---|---|---|
| Lead-lag (CME BTC → spot BTC, T2 cloud) | 2-8 bps | 30-100 | 50-150% if you don't get crowded out | Operator data; varies wildly |
| Lead-lag (perp BTC → spot BTC, T2-T3) | 1-5 bps | 50-200 | 30-80% | Operator data |
| Listing front-run | 200-2000 bps per opportunity | 1-5/month | 30-100% on the months when listings happen | Operator estimates |
| Oracle backrunning (Aave missed liqs) | 50-300 bps per liquidation | 5-30/month | 10-30% | DeFi data; sporadic |
| DEX-CEX arb on L2 | 5-30 bps per cycle | 5-50/day | 20-80% | varies hugely by chain |
| Polymarket vs CEX (this repo) | 50-300 bps per cycle | 2-20/day | 30-80% on small capital | This repo's operator backtests |

**The honesty disclaimer for latency arb:** these are *gross* numbers.
The single biggest cost is **competition entry** — when other actors
find your edge, the per-fill PnL goes from 5 bps to 0.5 bps very fast.
Latency arb is the most rapidly-decaying alpha family in this dossier.

A defensible 6-month edge in latency arb is a *win*. A defensible 2-year
edge is institutional-grade.

---

## 5. What kills it

Ranked by frequency in retail-tier deployments.

1. **Competition entry.** The biggest killer. Once a new latency-arb variant becomes known, dozens of bots enter; per-fill edge collapses to fees. Mitigation: don't publish your edge; deploy quietly; have a backup variant ready.
2. **Latency budget overshoot.** A network blip, a kernel scheduler hiccup, or a venue throttling pushes your latency above the lag. You start being adversely selected (fills happen *after* the lagger updates — i.e., on the *wrong* side). Mitigation: per-cycle latency tracking; automatic pause if rolling p99 latency exceeds threshold.
3. **Venue rate-limits.** Aggressive polling/order entry gets you rate-limited or banned. The leader-lagger pattern requires many small orders to capture small edges; venue policy must be respected. Mitigation: respect the venue's published rate limits; use WS over REST; for order entry, use IOC with a maximum per-second rate.
4. **Adverse selection.** When you trade against a lagger, the lagger's slow market-maker has already widened its quote in anticipation; the "stale" quote is actually a trap. Mitigation: detect MM regimes (wider quotes during high-vol windows = active MM); avoid arbing against widened books.
5. **Listing event front-run by venue insiders.** SEC has caught Coinbase insiders trading on listing leaks before the announcement.[^coinbase_insider] If you're trading after the announcement and someone has already arbed it during the leak window, the public window has slimmer edges. Mitigation: be conservative on listing front-runs; treat the first 30s as institutional/insider noise.
6. **Mempool monitoring failure (OEV variants).** If your mempool node misses a key transaction or sees it later than competitors, you lose. Mitigation: run multiple geographically-diverse mempool nodes; use a dedicated MEV-optimized RPC if at scale.
7. **Stuck inventory.** Arb fills one leg; the second leg fails or is canceled due to fast price move. You're left with naked directional exposure. Mitigation: per-cycle inventory cap; hedge-or-exit policy on partial fills; the same defensive logic from cross-venue-arbitrage.md §5.

---

## 6. Parameters

A single latency-arb engine handles multiple variants; per-variant tuning needed.

### 6.1 Shared

| Param | Units | Default | Range | Purpose |
|---|---|---|---|---|
| `max_latency_budget_ms` | ms | 100 | [10, 5000] | Skip cycle if observation→ack expected > |
| `min_edge_bps_after_fees` | bps | 3 | [0.5, 50] | Hard floor |
| `max_notional_per_cycle_usd` | USD | 5000 | [100, 100_000] | Per-arb notional cap |
| `max_concurrent_cycles` | int | 3 | [1, 20] | Concurrency cap |
| `rolling_latency_window_sec` | seconds | 60 | [10, 600] | For p99-latency-kill-switch |
| `latency_kill_p99_ms` | ms | 200 | [50, 5000] | Halt new cycles if p99 latency exceeds |
| `inventory_cap_usd` | USD | 10_000 | [500, 1_000_000] | Halt new cycles if open inventory exceeds |

### 6.2 Lead-lag specific

| Param | Default | Range | Purpose |
|---|---|---|---|
| `leader_move_threshold_bps` | 10 | [3, 50] | Min leader move in `move_window_ms` to trigger |
| `move_window_ms` | 200 | [50, 1000] | Window for the leader move |
| `lagger_max_age_ms` | 100 | [10, 500] | Skip if lagger's quote was updated within (stale window) |
| `lagger_expected_lag_ms` | 50 | [10, 500] | Expected lag; calibrated from observation |

### 6.3 Listing front-run specific

| Param | Default | Range | Purpose |
|---|---|---|---|
| `pre_event_position_window_sec` | 120 | [30, 1800] | Position N seconds before listing |
| `entry_max_premium_pct` | 5 | [1, 30] | Cap on entry premium vs other venues |
| `exit_first_n_minutes_post_listing` | 5 | [1, 30] | Close within window of opening |

### 6.4 Oracle backrun specific

| Param | Default | Range | Purpose |
|---|---|---|---|
| `oracle_lookback_blocks` | 3 | [1, 20] | Check positions liquidatable from oracle updates in last N blocks |
| `min_liquidation_value_usd` | 500 | [50, 100_000] | Skip dust positions |
| `gas_buffer_pct` | 30 | [10, 100] | Multiplier on current gas to outbid competitors |
| `min_profit_after_gas_usd` | 10 | [1, 1000] | Skip if net profit < |

### 6.5 DEX-CEX stale arb specific

| Param | Default | Range | Purpose |
|---|---|---|---|
| `dex_check_delay_ms` | 1000 | [100, 30_000] | Time after CEX move to check DEX |
| `min_dex_lag_bps` | 20 | [5, 200] | Min DEX-vs-CEX gap to trigger |
| `dex_swap_max_pct_of_pool` | 1 | [0.1, 5] | Cap swap size as % of pool liquidity |
| `max_slippage_bps` | 50 | [10, 500] | DEX slippage cap |

---

## 7. Fill model (backtesting)

### 7.1 Latency simulation

Realistic latency model:

```
latency_total = network_to_venue + decision + network_back + ack
              ~ truncated_lognormal(median=80ms, p99=300ms, min=20ms)
```

For each cycle in backtest, draw a latency sample; compute the venue's
quote *at observation time + latency*; that's your real fill price.

### 7.2 Adverse selection injection

When you act on a leader signal, the lagger's MM may have *already*
moved its quote toward the new fair (just not as visibly). Inject:

```
P(quote_already_moved) = 0.3
adverse_haircut_bps = min(leader_move_bps × 0.4, observed_spread_bps × 0.5)
```

This punishes naive "leader moved 10 bps so I'll capture 10 bps"
assumptions.

### 7.3 Competition simulation

Probability `your_fill / all_fills` decays over time as competition
enters:

```
your_capture_share(month_n) = 1 / (1 + month_n × competition_growth_rate)
```

With `competition_growth_rate = 0.3` per month, you have ~77% of fills
in month 1, dropping to ~50% by month 3, ~33% by month 6.

### 7.4 On-chain variants

For OEV / DEX arb, add:

```
gas_cost_usd = base_gas + priority_fee × gas_units
P(transaction_landed_in_target_block) = f(your_gas_bid / max_competing_gas_bid)
```

Without competitive gas, your tx lands a block late; the arb has often
closed by then.

---

## 8. Backtest design

### 8.1 Data

| Variant | Data | Source |
|---|---|---|
| Lead-lag | Tick-by-tick L1 quotes from both venues, microsecond-timestamped | Tardis.dev for crypto; for equities, you need full L1 + L2 + trades from a paid SIP feed |
| Listing front-run | Historical listing announcement timestamps + per-venue price history minute-by-minute | Manual capture; Twitter API; venue blogs |
| Oracle backrun | Mempool data + on-chain oracle update transactions + liquidatable-position state at each block | Etherscan/dune for historical liquidations + Chainlink/Pyth on-chain history |
| DEX-CEX arb | Per-block AMM pool state + CEX tick data | Same |

### 8.2 Metrics

- **Win rate** — cycles that closed profitably (especially important for lead-lag where adverse selection dominates losers).
- **Average gross edge / average net edge** — competition + adverse selection eats the gap.
- **Per-month edge decay** — track to detect when competition saturates the variant.
- **Latency p50 / p99** — operational sanity; alert on degradation.

### 8.3 Walk-forward

Latency-arb variants decay fast. Walk-forward weekly, not monthly. If
edge drops > 30% in 2 consecutive weeks, the variant is likely saturated;
consider a sub-variant pivot.

### 8.4 Look-ahead traps

- **Don't use the lagger's *next* timestamp** — use only data the venue had emitted at your decision time.
- **Don't assume your gas bid lands the next block.** If a competitor outbid you, your transaction is delayed; reflect this in backtest.
- **Don't backtest listing front-runs over your own knowledge of when listings happened.** Use only public announcement timestamps; assume you find out at announcement-time + scraping latency.

---

## 9. Code skeleton

The most-applicable variant for this repo is **Polymarket vs CEX
stale-oracle arb**, which is *already implemented* in
`src/lib/hft/polymarket-btc.ts`. Below is a generalized
**lead-lag** skeleton for adding `BTC-spot → BTC-perp` (or similar)
into the repo.

### 9.1 Lead-lag detector

```ts
// src/lib/hft/arb/lead-lag.ts

export type LeaderTick = { ts: number; midPrice: number; venue: string };
export type LaggerQuote = {
  ts: number; venue: string;
  bestBid: number; bestAsk: number;
  bidSize: number; askSize: number;
};

export type LeadLagOpportunity = {
  leaderVenue: string;
  laggerVenue: string;
  leaderMoveBps: number;     // direction-signed
  laggerStaleAgeMs: number;
  expectedFillEdgeBps: number;
  side: "BUY" | "SELL";       // side to take on lagger
  fillPrice: number;          // current lagger touch
  maxNotionalUsd: number;
  reason: string;
};

export type LeadLagCfg = {
  leaderMoveThresholdBps: number;
  moveWindowMs: number;
  laggerMaxAgeMs: number;
  laggerExpectedLagMs: number;
  takerFeeBps: number;
  adverseHaircutFactor: number;  // e.g. 0.4
  maxNotionalUsd: number;
};

export function detectLeadLag(
  leaderTicks: LeaderTick[],  // most recent N
  laggerQuote: LaggerQuote,
  cfg: LeadLagCfg,
  nowMs: number,
): LeadLagOpportunity | null {
  if (leaderTicks.length < 2) return null;

  // 1. Compute leader move over move_window_ms
  const windowStart = nowMs - cfg.moveWindowMs;
  const inWindow = leaderTicks.filter(t => t.ts >= windowStart);
  if (inWindow.length < 2) return null;
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  const moveBps = ((last.midPrice - first.midPrice) / first.midPrice) * 10_000;
  if (Math.abs(moveBps) < cfg.leaderMoveThresholdBps) return null;

  // 2. Lagger must be stale (not updated very recently)
  const laggerAge = nowMs - laggerQuote.ts;
  if (laggerAge < cfg.laggerExpectedLagMs * 0.3) return null;
  if (laggerAge > cfg.laggerMaxAgeMs) return null;

  // 3. Predict lagger's "true" fair = leader mid (assumes instant pass-through)
  const laggerFair = last.midPrice;
  const laggerMid = (laggerQuote.bestBid + laggerQuote.bestAsk) / 2;
  const gapBps = ((laggerFair - laggerMid) / laggerMid) * 10_000;

  // We act on the lagger SIDE that's stale relative to fair
  const side: "BUY" | "SELL" = gapBps > 0 ? "BUY" : "SELL";
  const fillPrice = side === "BUY" ? laggerQuote.bestAsk : laggerQuote.bestBid;
  const grossEdgeBps = Math.abs(gapBps) - cfg.takerFeeBps;

  // 4. Adverse-selection haircut: lagger MM has likely shifted partway
  const netEdgeBps = grossEdgeBps - Math.abs(moveBps) * cfg.adverseHaircutFactor;
  if (netEdgeBps <= 0) return null;

  // 5. Notional cap = top of lagger book × safety
  const topSize = side === "BUY" ? laggerQuote.askSize : laggerQuote.bidSize;
  const maxNotional = Math.min(cfg.maxNotionalUsd, topSize * fillPrice * 0.8);

  return {
    leaderVenue: last.venue,
    laggerVenue: laggerQuote.venue,
    leaderMoveBps: moveBps,
    laggerStaleAgeMs: laggerAge,
    expectedFillEdgeBps: netEdgeBps,
    side,
    fillPrice,
    maxNotionalUsd: maxNotional,
    reason: `leader moved ${moveBps.toFixed(1)} bps in ${cfg.moveWindowMs}ms; lagger stale ${laggerAge}ms; net edge ${netEdgeBps.toFixed(1)} bps`,
  };
}
```

### 9.2 Listing front-run (sketch)

```ts
// src/lib/hft/arb/listing-frontrun.ts

export type ListingEvent = {
  venue: string;            // the venue listing the asset
  asset: string;
  scheduledTs: number;      // unix ms of listing go-live
  source: "twitter" | "blog" | "api";
  detectedAtMs: number;     // when our scraper saw it
};

export type ListingFrontrunPlan = {
  asset: string;
  buyVenue: string;         // where to pre-position
  buyTs: number;            // when to start accumulating
  buyMaxNotionalUsd: number;
  exitVenue: string;        // the listing venue itself
  exitTsStart: number;      // listing time + delay
  exitTsEnd: number;        // listing time + exit window
  expectedPriceMovePct: number;
};

export function planListingFrontrun(
  event: ListingEvent,
  cfg: { prePositionWindowSec: number; exitFirstNMinutes: number; maxNotionalUsd: number },
  otherVenuesLive: string[],
): ListingFrontrunPlan | null {
  if (otherVenuesLive.length === 0) return null;
  return {
    asset: event.asset,
    buyVenue: otherVenuesLive[0],  // pick the most liquid
    buyTs: event.scheduledTs - cfg.prePositionWindowSec * 1000,
    buyMaxNotionalUsd: cfg.maxNotionalUsd,
    exitVenue: event.venue,
    exitTsStart: event.scheduledTs + 30_000,  // 30s post-listing to let initial spike settle
    exitTsEnd: event.scheduledTs + cfg.exitFirstNMinutes * 60_000,
    expectedPriceMovePct: 10,  // operator's estimate
  };
}
```

### 9.3 Wire-up

Both engines hand off to the venue router for execution. Same pattern
as the cross-venue-arb engine in `cross-venue-arbitrage.md`. Per-cycle
inventory cap and partial-fill handling are required.

---

## 10. Implementation path here

1. **Catalog the lead-lag variant.** Confirm BTC-perp at Binance leads BTC-spot at Coinbase by 5-50ms via passive measurement (1 week of WS captures both venues, compute lead-lag IC at 10/50/100/500ms horizons).
2. **Add `src/lib/hft/arb/lead-lag.ts`** per §9.1. Pure decision logic.
3. **Add `src/lib/hft/arb/lead-lag-engine.ts`** orchestrating the leader feed (Binance perp WS) + lagger feed (Coinbase spot WS) + the detector + the venue-router submit.
4. **Latency monitoring.** `src/lib/hft/arb/latency-monitor.ts` — exposed as a Prometheus-style counter; the kill-switch reads from it.
5. **Listing-front-run scraper.** `scripts/scrape-listings.ts` — Twitter API + Coinbase blog RSS; outputs to `data/listing-events.jsonl`. Separate from the trading engine because event-detection is usually IO-bound and irregular.
6. **OEV variant (later, if interest).** Requires a dedicated mempool node setup and is operationally non-trivial. Defer until lead-lag is proven.
7. **Tests:**
   - `tests/unit/lead-lag-detector.test.ts` — fixture: leader moves +20 bps, lagger stale 40ms, asserts correct opportunity emitted.
   - `tests/unit/lead-lag-latency-budget.test.ts` — verifies skip when latency > budget.
   - `tests/integration/listing-frontrun-flow.test.ts` — mock listing event → plan emitted → orders routed.
8. **Backtest harness:** `scripts/backtest-lead-lag.ts` — replay historical tick captures, compute realized edge per cycle.
9. **UI surface:** `/hft/latency` panel showing live latency-budget gauges, recent opportunities detected, fill outcomes.

---

## 11. Asset-specific gotchas

### US equities

- **Reg NMS + best-execution rules** mean retail can't directly arbitrage NBBO. The lead-lag-style trades that survived (ES → SPY) are all owned by firms.
- **IEX speed bump** intentionally adds 350 µs to incoming orders to neutralize the lead-lag advantage at IEX specifically. If your strategy targets NMS-protected NBBO arbs, IEX is the venue that won't pay.
- **The strategy is largely *unavailable* to Alpaca retail customers.** Move to crypto for accessibility.

### Crypto spot

- **Multi-venue lead-lag is the only retail-accessible flavor.** Binance Spot → Coinbase Spot, OKX → Bybit, etc. ~5-50ms lag during overlap hours.
- **Same-venue spot vs perp** is also a lead-lag (perp typically leads).
- **WS reliability matters** — disconnects = blind = missed opportunities. Auto-reconnect and feed-health monitoring are mandatory.

### Crypto perps

- **Funding-window distortions.** Just before funding settlement, books thin; lead-lag detection produces false positives. Gate by `time_to_next_funding > 60s`.
- **Cross-venue perp lead-lag** (dYdX → Hyperliquid, etc.) exists at ~10-100ms. Worth measuring per venue pair.

### DeFi / on-chain

- **Mempool transparency varies.** Ethereum has public mempool; many L2s have private sequencers (Arbitrum, Optimism, Base). Front-running on private-sequencer L2s is harder/impossible.
- **Gas-bidding war.** Even when you spot an OEV opportunity, you must outbid the next searcher. Profit = (gross edge) − (your gas bid). Modeling this is non-trivial.
- **Reorg risk.** On chains with reorgs (Ethereum has 1-2 per 1000 blocks), your "landed" arb may be reverted. Treat any same-block arb as conditional on N-block confirmation.

### Polymarket (the implemented variant)

- **Operationally proven.** `src/lib/hft/polymarket-btc.ts` is live; the variant works.
- **Capacity-capped.** Polymarket BTC binary books are thin (often $1k-$5k at touch); above that size, your own trade *is* the price move, eliminating the arb.
- **Resolution risk.** Holding the Polymarket leg through resolution = binary payoff. The arb must either close before resolution or be sized for the worst-case loss.

---

## 12. Open questions worth answering (research directions)

1. **Cross-perp lead-lag.** dYdX vs Hyperliquid vs Paradex on ETH-PERP — measure lead-lag IC at 10/50/100ms. Likely deepest-book venue leads; smaller venues lag enough for a T2-T3 arb.
2. **CME futures → Coinbase spot during US hours.** Lag should be 50-500ms. Probably saturated by firms but worth measuring.
3. **Listing front-run profitability decay 2024 vs 2025.** As Coinbase listings have become more orderly, has the alpha decayed? Backtest on past 12 months.
4. **OEV-style backrunning on Aave v3 on Arbitrum.** Lower MEV competition than Ethereum mainnet; may be accessible at $10k capital.
5. **Polymarket vs other oracles (Hyperliquid funding rate, etc.).** The existing `polymarket-btc.ts` uses CEX spot; could other "fair value" proxies (e.g. Hyperliquid funding implies probability) generate a different signal?

---

## 13. References

[^mosaic2026]: Mosaic Finance v. Eurex lawsuit (2026). Cited in industry coverage; the 3.2-nanosecond advantage / €75M annual revenue figure has become a standard reference for latency-arb economics at the firm tier.

[^oracle2024]: Chainlink. "Oracle Extractable Value (OEV) Explained." [chain.link/article/oracle-extractable-value](https://chain.link/article/oracle-extractable-value). Also Pyth Network's GOFA design: [pyth.network](https://pyth.network/).

[^chainlink_svr]: Chainlink. "Smart Value Recapture (SVR)." [chain.link/education-hub/maximal-extractable-value-mev](https://chain.link/education-hub/maximal-extractable-value-mev).

[^pyth_gofa]: Pyth Network developer documentation on Global Orderflow Auction. [docs.pyth.network](https://docs.pyth.network/price-feeds/core/migrate-an-app-to-pyth/chainlink).

[^coinbase_insider]: SEC v. Wahi et al. (2022) — Coinbase product manager + accomplices traded ahead of listing announcements. Public case; sets precedent that listing-leak insider trading is prosecuted.

**Other primary sources**
- B2Broker. "Latency Arbitrage Explained for Institutional Brokers." [b2broker.com/news/latency-arbitrage](https://b2broker.com/news/latency-arbitrage/).
- QuestDB. "Latency Arbitrage." [questdb.com/glossary/latency-arbitrage](https://questdb.com/glossary/latency-arbitrage/).
- QuantVPS. "What Is Latency Arbitrage? High-Frequency Trading Explained." [quantvps.com/blog/what-is-latency-arbitrage](https://www.quantvps.com/blog/what-is-latency-arbitrage).
- Crowcushing. "Citadel v. SEC: Fast and Furious." [crowcushing.com](https://www.crowcushing.com/single-post/citadel-v-sec-fast-and-furious) — court filings related to Citadel's HFT infrastructure dispute with SEC.
- Tuvoc Technologies. "Low Latency Trading Systems in 2026: The Complete Guide." [tuvoc.com/blog](https://www.tuvoc.com/blog/low-latency-trading-systems-guide/).
- Liquity. "The Oracle Conundrum." [liquity.org/blog](https://www.liquity.org/blog/the-oracle-conundrum).
- RedStone Finance. "Blockchain Oracles Comparison: Chainlink vs Pyth vs RedStone [2025]." [blog.redstone.finance](https://blog.redstone.finance/2025/01/16/blockchain-oracles-comparison-chainlink-vs-pyth-vs-redstone-2025/).

**Related modules in this repo**
- `src/lib/hft/polymarket-btc.ts` — Polymarket vs CEX BTC binary stale-oracle arb (live; the only latency variant implemented).
- `src/lib/strategies/midwindow-trajectory.ts`, `src/lib/strategies/near-resolution-scrape.ts` — Polymarket-side event-driven trades that compound with the latency arb (close-out behavior near resolution).
- cross-venue-arbitrage.md §2.7 — Polymarket vs CEX overview; defers math to `polymarket-btc.ts`.
- microstructure-signals.md — toxicity gate (VPIN) should pause latency-arb cycles during high-VPIN windows.
- execution-algos.md — IS executor with low `alpha_half_life_sec` is the right wrapper for the legs of a latency arb.
