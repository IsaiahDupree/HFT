# Event-Driven Strategies

> **Family:** 8 — Event-driven
> **Variants covered:** earnings post-announcement drift (PEAD) · scheduled macro prints (CPI/NFP/FOMC) · token unlock dumps · merger arb (announced deals) · index rebalance front-run · Polymarket resolution scrape · on-chain oracle events
> **Repo modules:** `src/lib/strategies/midwindow-trajectory.ts`, `src/lib/strategies/near-resolution-scrape.ts` (Polymarket variants — live)
> **Cross-asset coverage:** US equities (Alpaca) · crypto spot (Coinbase) · crypto perps (dYdX, Hyperliquid) · prediction markets (Polymarket)

---

## 1. TL;DR

Markets react to *events* — scheduled or surprise — with characteristic
patterns. Event-driven strategies trade those patterns: position
*before* if the event is scheduled, react *immediately* if the event is
a surprise, and exit when the reaction completes.

Seven canonical event types and how to trade them:

1. **Earnings PEAD** (post-earnings announcement drift): stocks with positive earnings surprises drift up for weeks; reverse for negative. Annualized excess return ~20% over 3-month windows in the classical formulation.
2. **Scheduled macro prints** (CPI, NFP, FOMC): the *first 60 seconds* are owned by HFTs; minutes 5-60 have systematic positioning effects you can exploit.
3. **Token unlock dumps** (crypto): vesting cliffs release tokens; price typically softens 7-14 days before and 3-7 days after; short the asset into the cliff, cover when the dust settles.
4. **Merger arb**: announced acquisitions trade at a discount to deal price; capture the spread by buying the target.
5. **Index rebalance front-run** (S&P 500, MSCI, NASDAQ-100 reconstitution): names entering an index get bought by passive funds at the reconstitution date; position 5-30 days before.
6. **Polymarket resolution scrape**: binary markets resolving in <5 minutes have systematic mispricings (cf. `near-resolution-scrape.ts` in this repo).
7. **On-chain events** (oracle updates, governance votes, protocol launches): position before the event; capture the discontinuity.

The unifying theme: events have **known mechanisms** that produce
**predictable order flow**. Your job is to be on the right side of that
flow *before* it arrives.

---

## 2. Mechanism

### 2.1 PEAD — Post-Earnings Announcement Drift

When a company reports earnings, the market reacts to the *surprise* —
the difference between actual EPS and consensus estimate, standardized
by analyst-estimate dispersion (SUE: Standardized Unexpected Earnings).

```
SUE = (actual_EPS − consensus_EPS) / σ(analyst_estimates)
```

Stocks with high positive SUE drift *upward* for 60-90 days after
announcement; stocks with low (negative) SUE drift downward. The
classical hedge portfolio (long top-decile SUE, short bottom-decile
SUE) earns 5.1% over 3 months → ~20% annualized.[^garfinkel2024]

**Why it persists (despite being known for ~50 years):**
- Retail investors react slowly to earnings news (cognitive limits).
- Institutional investors rebalance with delay (mandate constraints).
- The drift is concentrated in small-cap and low-attention names → harder to scale, less attractive to large funds → alpha survives.

**2024 caveats:**
- US PEAD has *decayed* significantly; current alpha is half what it was in 2010-2015.[^ucla2024]
- The variant that still works: **long-horizon stocks** (high retail-investor average holding period) — they exhibit larger drift than short-horizon stocks.[^retail2024] Long-horizon - short-horizon hedge generates ~5% annualized alpha post-2020.

### 2.2 Scheduled macro prints

A scheduled release (CPI on the second Tuesday of the month, NFP on the
first Friday, FOMC decisions 8x per year) creates predictable order
flow:

**The pre-print regime (T−30min to T):**
- Implied vol on options spikes.
- Spreads widen.
- Bid-ask volume drops.

**The print moment (T):**
- 0-1 second: HFT firms with direct fiber feeds get the number from BLS/BEA/Federal Reserve, trade against stale quotes. **Owned by firms.**
- 1-60 seconds: Algos parse text (it's released as PDF/structured release); price discovery is volatile, gappy.

**The post-print regime (T+5min to T+60min):**
- Systematic positioning effects emerge. Vol mean-reverts.
- Macro-momentum strategies establish positions in the direction of the print.
- Risk-parity/CTAs rebalance based on new vol regime.

**Trades that work for a T3 retail operator:**

- **Pre-print vol selling** (T−2h to T−10min): if implied vol > realized-vol historical at this timing, sell strangles to capture the IV premium. Close before the print itself.
- **Post-print fade** (T+5 to T+30): if the initial 5-min move was > 1.5× recent volatility, position for partial mean-reversion. Catalysts that are "priced in" (most CPI prints in 2024) tend to fade more than catalysts that surprise.
- **Direction-trade post-print** (T+30 to T+4h): if the move aligns with FedWatch / OIS-implied probability of rate-cut, take the breakout. Avoid going against the macro narrative.

### 2.3 Token unlock dumps

When a crypto project releases previously-locked tokens to investors,
team, or contributors:

- **Cliff unlock**: large one-time release (e.g. ARB's March 2024 1.1B token cliff).
- **Linear unlock**: gradual release over months (e.g. OP's daily emissions).

The price pattern around a cliff:[^arb2024][^op2024]
- **T−30 to T−10 days**: price softens as smart money exits.
- **T−7 to T−1 days**: explicit sell pressure builds.
- **T to T+3 days**: peak selling; price often drops 10-30%.
- **T+3 to T+14 days**: recovery if fundamentals are unchanged; capitulation if not.

**Trade structure:**
- Short perp (or spot, where margin permits) 14 days before the cliff.
- Cover at T+3 to T+7 days based on price action.
- Size for the realistic 10-30% move; cap exposure at 5% of cliff-amount.

**Why it persists:**
- Token unlock dates are public; the schedule is on Tokenomist, DropsTab, etc.
- Vesting recipients (VCs, team) usually have legal/tax constraints that limit their dump strategy → predictable supply.
- Most crypto operators run direction-trades, not basis/vol — fewer competitors in the specifically-unlock-targeted trade.

**Risk:** if fundamentals shift (a major partnership, a protocol upgrade)
around the unlock, the dump can be absorbed and price *rises*. Mitigation:
have a hard-stop if the asset rallies 5%+ in the week before the cliff
(probably means buyers have lined up).

### 2.4 Merger arb

When Company A announces it will acquire Company B at $X per share, B's
stock typically trades at $X − discount where the discount reflects:
- Probability the deal closes (regulatory risk, financing risk).
- Time value of money until close.
- Specific deal terms (cash vs stock, exchange ratio, premium).

**Trade:** buy B's stock, short A's stock (in stock deals), capture the
spread as it closes toward zero at deal completion.

**Annualized return**: typically 5-15% on a single deal, depending on
spread and time-to-close. Sharpe 0.5-1.5 if you diversify across many
deals.

**Failure mode:** deal breaks (regulatory veto, financing fail, target
rejects). B's stock drops 20-50% back to pre-announcement levels. One
deal break can erase several profitable deals.

**Retail accessibility:** moderate. You need to read SEC filings (10-Q,
proxy materials), track deal-related news, and watch regulatory
calendar. Hedge funds with dedicated merger-arb teams have edges retail
doesn't (lawyers, ex-regulators on payroll).

### 2.5 Index rebalance front-run

S&P 500, NASDAQ-100, MSCI World, etc. add and remove constituents on
fixed schedules. Index funds (passive money) must rebalance on the
reconstitution date.

**Pattern:**
- Announcement (T−4 weeks): "Company X will be added to S&P 500 on date Y."
- T−4 weeks to T−1 day: price drifts up as opportunists position.
- T (rebalance close): index funds buy at the closing print; price often spikes.
- T+1 to T+7 days: price reverts as opportunists exit and the post-event period quiets.

**Trade:**
- Long the added name from T−5 to T−1 days.
- Sell into the closing print at T (or just after).

**Edge:** typically 1-3% per addition; the *removal* trade (short the
removed name) is similar magnitude.

**Reality check:** this trade is *very* crowded. Specialist funds (Index
IQ, Quantitative Brokers) deploy billions specifically here. Retail
can play in tiny size on lesser-known index changes (e.g. Russell 2000
adjustments) where the pool of opportunists is smaller.

### 2.6 Polymarket resolution scrape

Binary markets on Polymarket resolve at a specific time. In the final
minutes:
- One side often *should* be at $1, the other at $0 (the outcome is essentially decided).
- The market price often diverges from "true" probability due to slow market-making and exit-liquidity premiums.

`src/lib/strategies/near-resolution-scrape.ts` implements this. The
detector identifies markets where the favored side has crossed a
high-probability threshold (e.g. 95% on a CEX-implied calculation) but
the order book hasn't fully repriced. Buy the cheap side; collect
the $1 payout at resolution.

**Capital scale:** $100-$5k per opportunity. Polymarket binaries don't
have deep books; this is genuinely retail-sized.

### 2.7 On-chain protocol events

Protocol launches, governance votes, airdrops, fork events:

- **Pre-launch positioning**: a known launch date for a new chain/protocol creates demand for related tokens.
- **Airdrop farming**: positioning in the qualifying assets/wallets *before* a snapshot.
- **Governance votes**: a vote outcome affects token economics; position based on poll-leading direction.
- **Forks**: hard forks split a coin; the new token launches at an estimated price; if your wallet had the old asset at snapshot, you receive the new token.

**Edge magnitude:** highly variable. Some events (Optimism airdrop) have
returned 100%+ on positioning capital; many returns are <5% net of risk.

---

## 3. Where it works

| Variant | Asset class | Verdict | Notes |
|---|---|---|---|
| PEAD | US equities | ⚠️ decayed but alive | Small-cap, low-attention names; long-horizon hedge variant |
| Pre-print vol selling | Options (Alpaca/Deribit) | ✅ | IV-mean-reversion play; needs options exec |
| Post-print fade | Equities, BTC | ✅ | T+5min onward; needs reliable news scraper |
| Token unlock short | Crypto perps | ✅ | Unlock calendar is public; capacity limited by short interest |
| Merger arb | US equities | ⚠️ institutional | Hard for retail to scale, lawyers help |
| Index rebalance | US equities (S&P, R2000) | ⚠️ crowded | R2000 adjacent indices more accessible |
| Polymarket resolution scrape | Polymarket | ✅ implemented in repo | Live and working |
| On-chain governance/launches | DeFi | ⚠️ niche | Each event is bespoke; not a systematic strategy |

**Capital scale:**

- PEAD: $25k-$10M (scales well in the long-horizon variant).
- Pre-print vol: $25k+ for options.
- Token unlock: $5k-$500k per unlock (depending on token's short interest).
- Merger arb: $100k+ to diversify across deals.
- Index rebalance: $100k+ for the well-known indices.
- Polymarket resolution scrape: $500-$5k per market (already capacity-bounded).

---

## 4. Edge magnitude

| Variant | Annualized return on dedicated capital | Sharpe | Source |
|---|---|---|---|
| PEAD (classical) | 20% | 1.0-1.5 | Garfinkel et al. 2024 [^garfinkel2024] |
| PEAD (long-horizon hedge, post-2020) | 5% | 0.5-0.8 | Retail-investor 2024 study [^retail2024] |
| Pre-print vol selling (S&P options) | 8-15% (with bad tail) | 1.0-2.0 (until a tail event) | Macrosynergy / Quantpedia [^quantpedia_vrp] |
| Post-print fade (BTC, FOMC) | 10-25% | 0.6-1.2 | Operator estimates |
| Token unlock short | 15-50% per active unlock window | 0.5-1.5 | Industry estimates |
| Merger arb (diversified) | 5-12% net | 0.5-1.0 | Quantpedia, multiple industry reports |
| Index rebalance | 3-8% per cycle (4 cycles/year) | 0.4-0.8 | Industry standard |
| Polymarket resolution scrape | 30-100% | 1.0-3.0 (high vol, low capacity) | This repo's operator backtests |

**Note on tail risk:** vol-selling strategies (pre-print short
straddles, post-print fades, vol risk premium harvesting) earn small,
steady gains 95% of the time and lose massively the other 5%. The
historical max-loss event on equity-index short-straddle strategies
exceeds -800% of monthly position notional.[^quantpedia_vrp] Hedge with
out-of-the-money puts; cap position size at "I can survive losing
this."

---

## 5. What kills it

Ranked by frequency.

1. **Event surprise direction wrong.** You positioned for a benign CPI, but core inflation came in hot; your fade fades into a continued rally. Mitigation: position size for the *worst-case* event reaction, not the average.
2. **Token unlock priced in.** Vesting recipients sold *before* the cliff (via OTC or pre-unlock derivatives); the cliff itself sees no sell pressure; your short loses. Mitigation: track open interest in perp shorts on the asset; if shorts are already over 30% of OI, the unlock is priced in.
3. **Merger deal break.** A regulatory rejection, financing pull, or rival bid emerges; the target stock drops 20-50%. Mitigation: cap any single deal at 5% of book; diversify across many deals; monitor SEC filings daily.
4. **Index rebalance front-running crowded out.** If 50 firms know about an addition, they all bid up the price more than the index demand justifies; you buy at the top, sell into a *softer* close than expected. Mitigation: focus on less-watched indices (R2000, MSCI small-cap, sector indices).
5. **PEAD signal contamination from event news.** A company guides earnings down two weeks post-announcement; your "high-SUE long" position has its drift reversed. Mitigation: monitor for material news on positions; close on material adverse news.
6. **Polymarket resolution risk.** The market resolves ambiguously, takes weeks (UMA dispute period), or is voided. Your capital is locked. Mitigation: pre-filter markets by resolution-clarity (the existing `near-resolution-scrape.ts` does this).
7. **Slippage on small-cap PEAD names.** Trading a $50M-market-cap stock with a $50k position can move the price 1-2%. Use VWAP/TWAP execution; cap position at 0.5% of ADV.
8. **Late detection.** The event happened; competitors started trading; by the time you execute, the trade is gone. Mitigation: dedicated news-scraping pipeline; subscribe to authoritative feeds (BLS API, SEC EDGAR, Polymarket WS).

---

## 6. Parameters

A single event-driven engine handles multiple variants via per-variant adapters.

### 6.1 Shared

| Param | Units | Default | Range | Purpose |
|---|---|---|---|---|
| `max_position_per_event_usd` | USD | 5000 | [100, 100_000] | Per-event cap |
| `max_concurrent_events` | int | 5 | [1, 50] | Concurrency |
| `max_book_share_event_family_pct` | percent | 20 | [5, 50] | Diversification across event types |
| `news_source_lag_sec` | seconds | 5 | [0, 60] | Discount for "we found out N seconds after announcement" |
| `force_close_drawdown_pct` | percent | 8 | [1, 30] | Auto-flatten per event |

### 6.2 PEAD-specific

| Param | Default | Range | Purpose |
|---|---|---|---|
| `sue_long_threshold` | 2.0 | [1.0, 5.0] | Top-decile SUE entry |
| `sue_short_threshold` | -2.0 | [-5.0, -1.0] | Bottom-decile SUE entry |
| `hold_days` | 60 | [15, 180] | Position-hold horizon |
| `max_position_per_name_pct_adv` | 0.5 | [0.1, 5] | Liquidity cap |
| `prefer_long_horizon_hedge` | true | bool | Use the 2024 variant |

### 6.3 Pre-print vol-selling specific

| Param | Default | Range | Purpose |
|---|---|---|---|
| `entry_iv_premium_pct` | 20 | [5, 100] | Min IV vs trailing realized vol |
| `entry_window_hours_before` | 4 | [1, 24] | Position N hours before print |
| `exit_window_minutes_before` | 10 | [1, 60] | Close before the print itself |
| `delta_neutral` | true | bool | Maintain delta hedge |
| `hard_stop_iv_jump_pct` | 30 | [10, 100] | Close if IV rises this much (event in progress) |

### 6.4 Token unlock-specific

| Param | Default | Range | Purpose |
|---|---|---|---|
| `entry_days_before_cliff` | 14 | [3, 30] | Open short N days before |
| `exit_days_after_cliff` | 5 | [1, 14] | Close N days after |
| `min_unlock_pct_of_supply` | 3 | [0.5, 30] | Skip small unlocks |
| `skip_if_short_interest_above_pct` | 30 | [10, 80] | Skip if shorts crowded |
| `max_leverage` | 2 | [1, 10] | On perp short |

### 6.5 Merger arb-specific

| Param | Default | Range | Purpose |
|---|---|---|---|
| `min_annualized_spread_pct` | 8 | [3, 30] | Min spread to enter |
| `max_deal_close_uncertainty` | 0.2 | [0.0, 0.5] | Skip if implied close-prob < (1 − this) |
| `diversification_max_per_deal_pct` | 5 | [1, 25] | Per-deal cap |
| `regulatory_concern_filter` | true | bool | Skip if FTC/DOJ flagged |

### 6.6 Polymarket resolution-scrape specific

(Already implemented; cf. `src/lib/strategies/near-resolution-scrape.ts`
for actual production defaults.)

| Param | Default | Range | Purpose |
|---|---|---|---|
| `min_implied_prob_certainty` | 0.95 | [0.80, 0.99] | Only act when CEX-implied prob > |
| `max_minutes_to_resolution` | 5 | [1, 60] | Resolution window |
| `min_edge_bps` | 50 | [10, 500] | Min gap between market price and certainty |
| `min_book_depth_usd` | 50 | [10, 1000] | Liquidity floor |

---

## 7. Fill model (backtesting)

### 7.1 Entry / exit

For equities and crypto perps, use IS executor (see
execution-algos.md). For PEAD, the slow-strategy nature allows VWAP
over 1-2 trading sessions.

For options (vol selling), use IOC limit at mid; accept partial fills.

For Polymarket resolution scrape, use IOC market (the existing
implementation handles this).

### 7.2 Slippage on small-caps (PEAD)

Use `1.5 bps per 0.1% of ADV` for impact estimate. Cap position at
0.5% ADV; smaller for very illiquid names.

### 7.3 News-detection lag

Add `news_source_lag_sec` after the official announcement timestamp.
Realistic operator detection latencies:
- BLS API: 1-5 seconds.
- Twitter scraping: 10-60 seconds.
- Polymarket WS: <1 second.
- Polymarket REST polling: 5-30 seconds.

### 7.4 Deal break injection (merger arb)

For backtesting, inject random deal breaks at `5% / year` per deal in
your sample. Apply average deal-break loss of `-25%` (the historical
average for cancelled US M&A).

### 7.5 Tail event injection (vol selling)

For backtesting, inject random vol spikes once per year: a `2σ` vol
shock that produces `5×` your normal max-loss. Without this, vol
strategies overstate their Sharpe by 30-60%.

---

## 8. Backtest design

### 8.1 Data

| Variant | Data |
|---|---|
| PEAD | Quarterly earnings actuals + consensus, daily price data, SUE precomputed | Compustat (paid), Yahoo Finance (free, less reliable) |
| Pre-print vol | IV history per strike, realized-vol history, event calendar | Deribit IV for crypto; CBOE for equities; econoday for event calendar |
| Token unlock | Unlock dates per token, daily price, perp funding history | Tokenomist, DropsTab |
| Merger arb | Deal-announcement timestamps, target/acquirer prices, deal terms | SEC EDGAR (free) + financial news |
| Index rebalance | Index methodology, addition/removal announcements + dates | S&P, MSCI, Russell official sources |
| Polymarket scrape | Per-market book + CEX price + resolution time | Polymarket WS + Coinbase WS |

### 8.2 Metrics

- **Per-event win rate** (% of events that closed profitably).
- **Per-event PnL distribution** (look for skew — vol strategies have negative skew; PEAD has positive).
- **Max drawdown event** (deal break, unexpected vol spike).
- **Annualized return on event-deployed capital** (not total book — events aren't always happening).
- **Calmar ratio** (annual return / max drawdown).

### 8.3 Walk-forward

Events change in character over time (PEAD has decayed; merger arb
spreads compressed). Quarterly walk-forward; re-evaluate edge per
calendar year.

### 8.4 Look-ahead traps

- **Don't use post-event "true" SUE.** Compute SUE using consensus available *at* announcement time.
- **Don't use deal-close dates that weren't known.** Some deals are extended; use only information available at trade time.
- **Don't backtest token unlocks over your own knowledge.** Use only the unlock schedule available at trade-entry time.

---

## 9. Code skeleton

The existing repo already implements two event-driven variants:
- `src/lib/strategies/near-resolution-scrape.ts` (§2.6)
- `src/lib/strategies/midwindow-trajectory.ts` (Polymarket-specific event detection)

Below is a skeleton for a **PEAD** detector (the most generally useful
equity-event strategy not yet in the repo).

### 9.1 PEAD detector — `src/lib/strategies/equity/pead.ts`

```ts
export type EarningsEvent = {
  ticker: string;
  announcementTs: number;
  actualEPS: number;
  consensusEPS: number;
  consensusDispersion: number;     // σ of analyst estimates
  marketCapUsd: number;
  avgDailyVolumeUsd: number;
};

export type PeadOpportunity = {
  ticker: string;
  side: "long" | "short";
  sue: number;
  entryTs: number;
  exitTs: number;
  maxPositionUsd: number;
  reasoning: string;
};

export type PeadCfg = {
  sueLongThreshold: number;
  sueShortThreshold: number;
  holdDays: number;
  maxPositionPctAdv: number;
  maxPositionPerEventUsd: number;
  minMarketCapUsd: number;        // skip micro-caps (illiquid)
  newsLagSec: number;             // detection delay
};

export function detectPead(
  event: EarningsEvent,
  cfg: PeadCfg,
): PeadOpportunity | null {
  const sue = (event.actualEPS - event.consensusEPS) / event.consensusDispersion;

  if (event.marketCapUsd < cfg.minMarketCapUsd) {
    return null;  // too illiquid
  }

  let side: "long" | "short" | null = null;
  if (sue >= cfg.sueLongThreshold) side = "long";
  else if (sue <= cfg.sueShortThreshold) side = "short";

  if (side === null) return null;

  // Liquidity-capped position
  const maxByAdv = event.avgDailyVolumeUsd * (cfg.maxPositionPctAdv / 100);
  const maxPosition = Math.min(cfg.maxPositionPerEventUsd, maxByAdv);

  return {
    ticker: event.ticker,
    side,
    sue,
    entryTs: event.announcementTs + cfg.newsLagSec * 1000,
    exitTs: event.announcementTs + cfg.holdDays * 24 * 3600 * 1000,
    maxPositionUsd: maxPosition,
    reasoning: `SUE=${sue.toFixed(2)} ${side === "long" ? "≥" : "≤"} threshold, market cap $${(event.marketCapUsd/1e6).toFixed(0)}M, max pos $${maxPosition.toFixed(0)}`,
  };
}
```

### 9.2 Token unlock detector — `src/lib/strategies/crypto/token-unlock.ts`

```ts
export type UnlockEvent = {
  ticker: string;
  venue: string;             // perp venue to short
  cliffTs: number;
  unlockAmountUsd: number;
  pctOfCirculatingSupply: number;
  currentShortInterestPct: number;  // perp short OI / total OI
};

export type UnlockOpportunity = {
  ticker: string;
  venue: string;
  side: "short";
  entryTs: number;
  exitTs: number;
  maxPositionUsd: number;
  leverage: number;
  reasoning: string;
};

export type UnlockCfg = {
  entryDaysBefore: number;
  exitDaysAfter: number;
  minUnlockPctSupply: number;
  skipIfShortInterestAbovePct: number;
  maxLeverage: number;
  maxPositionUsd: number;
};

export function detectUnlock(
  event: UnlockEvent,
  cfg: UnlockCfg,
): UnlockOpportunity | null {
  if (event.pctOfCirculatingSupply < cfg.minUnlockPctSupply) return null;
  if (event.currentShortInterestPct > cfg.skipIfShortInterestAbovePct) return null;

  return {
    ticker: event.ticker,
    venue: event.venue,
    side: "short",
    entryTs: event.cliffTs - cfg.entryDaysBefore * 24 * 3600 * 1000,
    exitTs: event.cliffTs + cfg.exitDaysAfter * 24 * 3600 * 1000,
    maxPositionUsd: cfg.maxPositionUsd,
    leverage: cfg.maxLeverage,
    reasoning: `${event.ticker} cliff ${(event.unlockAmountUsd/1e6).toFixed(1)}M / ${event.pctOfCirculatingSupply.toFixed(1)}% supply; short OI ${event.currentShortInterestPct.toFixed(1)}%`,
  };
}
```

### 9.3 Pre-print vol-selling — `src/lib/strategies/options/pre-print-vol.ts`

```ts
export type VolPrintEvent = {
  eventName: string;             // "CPI_2026-06", etc.
  scheduledTs: number;
  asset: string;                 // SPX, BTC, etc.
  currentIvAnnualizedPct: number;
  realizedVolPriorMonthPct: number;
};

export type VolSellOpportunity = {
  eventName: string;
  asset: string;
  side: "short_straddle" | "short_strangle";
  entryTs: number;
  exitTs: number;
  ivPremiumPct: number;
  maxNotionalUsd: number;
  reasoning: string;
};

export type VolCfg = {
  entryIvPremiumPct: number;
  entryWindowHoursBefore: number;
  exitWindowMinutesBefore: number;
  maxNotionalUsd: number;
};

export function detectVolSellOp(
  event: VolPrintEvent,
  cfg: VolCfg,
): VolSellOpportunity | null {
  const premium = ((event.currentIvAnnualizedPct - event.realizedVolPriorMonthPct)
                   / event.realizedVolPriorMonthPct) * 100;
  if (premium < cfg.entryIvPremiumPct) return null;

  return {
    eventName: event.eventName,
    asset: event.asset,
    side: "short_strangle",  // typically safer than straddle
    entryTs: event.scheduledTs - cfg.entryWindowHoursBefore * 3600 * 1000,
    exitTs: event.scheduledTs - cfg.exitWindowMinutesBefore * 60 * 1000,
    ivPremiumPct: premium,
    maxNotionalUsd: cfg.maxNotionalUsd,
    reasoning: `${event.asset} IV ${event.currentIvAnnualizedPct.toFixed(1)}% vs realized ${event.realizedVolPriorMonthPct.toFixed(1)}% (premium ${premium.toFixed(0)}%)`,
  };
}
```

---

## 10. Implementation path here

1. **Add `src/lib/strategies/equity/pead.ts`** per §9.1 — pure detector for PEAD signals.
2. **Add `src/lib/strategies/crypto/token-unlock.ts`** per §9.2.
3. **Add `src/lib/strategies/options/pre-print-vol.ts`** per §9.3 (requires options venue adapter — defer until Alpaca options is wired).
4. **Event-data ingestion pipeline:**
   - `scripts/fetch-earnings-calendar.ts` — pulls upcoming earnings dates + consensus from a data vendor (Alpaca news, FMP, Polygon).
   - `scripts/fetch-token-unlocks.ts` — scrapes Tokenomist/DropsTab into `data/token-unlocks.jsonl`.
   - `scripts/fetch-macro-calendar.ts` — econoday-style RSS or BLS API.
   - `scripts/fetch-merger-events.ts` — SEC EDGAR for 8-K filings on announced deals.
5. **Event orchestrator:** `src/lib/strategies/event/orchestrator.ts` — periodically loads upcoming events, runs each detector, sizes positions, calls venue router via the existing infrastructure.
6. **Wire to risk engine** for per-event drawdown gates and to allocator for capital routing.
7. **Backtest harness:** `scripts/backtest-events.ts` running per variant on historical event data.
8. **UI surface:** `src/app/hft/events/page.tsx` showing upcoming events, open positions per event, PnL per event family.
9. **Tests:**
   - `tests/unit/pead-detector.test.ts` — SUE math + threshold logic.
   - `tests/unit/unlock-detector.test.ts` — filter logic, position sizing.
   - `tests/unit/vol-sell-detector.test.ts` — IV-premium computation.
   - `tests/integration/event-orchestrator.test.ts` — end-to-end with mock event data.

---

## 11. Asset-specific gotchas

### US equities

- **PEAD on micro-caps doesn't scale.** Tempting because effect is largest there, but you'll move the price you're trading. Stay $25M-$2B market cap.
- **Earnings whisper numbers** (informal Wall Street estimates not in official consensus) often beat consensus in the same direction. The classical SUE doesn't capture these. Pricier data feeds (StreetAccount, Estimize) do.
- **Pre-earnings positioning rules.** Some hedge funds avoid positioning in the 5 days before earnings due to internal "no event-trade" rules. This is institutional rope and *creates* the post-event drift you trade.
- **Halts / circuit breakers.** Earnings surprises can trigger LULD halts; positioning must allow for halt resumption.

### Crypto perps

- **Token unlock perp shorts have liquidation risk.** Even though you "know" the direction, intra-week volatility can liquidate a 5× leveraged short during a relief rally before the cliff.
- **Funding rate adjusts.** As short interest builds, funding goes negative → shorts pay longs. Factor this into expected PnL.
- **Cross-venue inventory.** Unlock-day liquidity may not be at your venue; pre-position at multiple venues if your size is large.

### Options (Alpaca / Deribit)

- **Pre-print straddle decay is fast.** Theta accelerates in the 24h before the event; closing the day-of saves more than waiting another 8h would buy.
- **Skew matters.** During event-anticipation, IV-rises are not uniform across strikes; OTM puts often spike more than OTM calls (or vice versa, depending on direction expectation). Position in the part of the skew that's overpriced.
- **0DTE is a different beast.** Same-day-expiry options have enormous gamma; treat 0DTE event-vol-sells as a separate strategy with much tighter risk controls.

### Polymarket

- **Resolution risk** — covered in §11 of cross-venue-arbitrage.md.
- **UMA dispute window** can lock capital for 1-2 weeks even on "clear" outcomes if anyone disputes.

---

## 12. Open questions worth answering (research directions)

1. **PEAD on crypto.** Does an analog exist for crypto exchanges that publish quarterly volume/PnL? Some have started (Coinbase quarterly); too few data points yet.
2. **Token unlock cliff perp basis trade.** Combine the short with a long-spot leg (cash-and-carry) to be funding-positive during the hold. May improve risk-adjusted returns.
3. **Pre-print event for crypto-specific events.** ETH upgrades, halving cycles, exchange listings — do they have characteristic vol patterns trade-able like macro prints?
4. **Polymarket vol around resolution.** Implied probability volatility in the final 60 minutes — can short-straddle-style trades capture vol risk premium analog?
5. **News-as-event detection.** The current event pipeline assumes scheduled events. Could a real-time news scraper (with LLM classifier) detect *surprise* events fast enough to trade them at T3?

---

## 13. References

[^garfinkel2024]: Garfinkel, M., Hribar, P., & Hsiao, P. (2024). "Post-Earnings Announcement Drift: Earnings Surprise Measuring, the Medium Effect of Investor Attention and Investing Strategy." *International Review of Financial Analysis*. [SSRN 4589824](https://papers.ssrn.com/sol3/Delivery.cfm/9412a06f-c6aa-4df1-bf29-370fe1bd0399-MECA.pdf?abstractid=4589824) · published version on [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S1057521924003922).

[^ucla2024]: UCLA Anderson Review. "Is Post-Earnings Announcement Drift a Thing? Again?" [anderson-review.ucla.edu](https://anderson-review.ucla.edu/is-post-earnings-announcement-drift-a-thing-again/) — argument that PEAD has revived in low-attention names.

[^retail2024]: "Retail Investor Horizon and Earnings Announcements." arXiv:2512.00280. [arxiv.org/abs/2512.00280](https://arxiv.org/abs/2512.00280) — long-horizon vs short-horizon stocks decomposition.

[^arb2024]: Industry coverage of ARB's March 2024 1.1B token unlock. CoinDesk: ["Arbitrum Will Unlock $1.2B ARB in March 2024"](https://www.coindesk.com/markets/2023/08/16/arbitrum-will-unlock-12b-arb-in-march-2024-token-unlocks) · [DropsTab schedule](https://dropstab.com/coins/arbitrum/vesting).

[^op2024]: DropsTab OP vesting schedule and historical cliff impact analysis. [dropstab.com/coins/optimism/vesting](https://dropstab.com/coins/optimism/vesting).

[^quantpedia_vrp]: Quantpedia. "Volatility Risk Premium Effect." [quantpedia.com/strategies](https://quantpedia.com/strategies/volatility-risk-premium-effect) — variance risk premium and the tail-risk warning.

**Other primary sources**
- Tokenomist. [tokenomist.ai](https://tokenomist.ai/) — unlock calendar.
- Cointelegraph. "Crypto projects set to unlock $2.6B in tokens in November 2024." [cointelegraph.com](https://cointelegraph.com/news/november-2024-crypto-token-unlocks).
- Wikipedia: "Post-earnings-announcement drift." [en.wikipedia.org](https://en.wikipedia.org/wiki/Post%E2%80%93earnings-announcement_drift).
- FMP. "Tracking Post-Earnings Announcement Drift (PEAD) with FMP's Market Data." [site.financialmodelingprep.com](https://site.financialmodelingprep.com/education/other/tracking-postearnings-announcement-drift-with-fmps-market-data).
- Macrosynergy. "Realistic volatility risk premia." [macrosynergy.com](https://macrosynergy.com/research/realistic-volatility-risk-premia/).
- The Hedge Fund Journal. "Harvesting the S&P 500 Volatility Risk Premium." [thehedgefundjournal.com](https://thehedgefundjournal.com/harvesting-the-s-p-500-volatility-risk-premium/).

**Related modules in this repo**
- `src/lib/strategies/near-resolution-scrape.ts` — Polymarket resolution-scrape (live).
- `src/lib/strategies/midwindow-trajectory.ts` — Polymarket event-driven trajectory trades (live).
- `src/lib/strategies/orderbook-imbalance.ts` — useful as a confirm-signal for event entry timing.
- microstructure-signals.md §2.5 (VPIN) — toxicity gate around event windows.
- execution-algos.md §2.5 (IS) — recommended execution wrapper for event entries with short alpha half-life.
- basis-funding.md — funding-rate-aware sizing for token-unlock perp shorts.
