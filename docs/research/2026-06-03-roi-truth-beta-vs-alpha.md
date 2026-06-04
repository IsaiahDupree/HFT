# Big ROI ≠ Edge: the +12,614% audit, the Trade Advocate, and cross-venue data truth

**Date:** 2026-06-03
**Branch:** `feat/oracle-snapshot-capture`
**TL;DR:** A relative-strength rotation showed **+12,614%** cumulative — and it is **real prices, not a
data artifact** — but it is **market beta that UNDERPERFORMS buy-and-hold** (+22,710%) with **negative
out-of-sample alpha**. We encoded that lesson as a reusable `tradeAdvocate()` that gives affirmative
reasons to trade *only* when a strategy beats beta out-of-sample and clears the overfit gauntlet, and
we added a second independent data source (Kraken) plus a cross-venue agreement check that confirms the
warehouse is clean (median **1.6 bps** Coinbase↔Kraken disagreement over 718 daily bars).

---

## 1. The audit: is +12,614% a warehouse artifact?

The cross-asset relative-strength variant `rs20/top2` (hold the top-2 strongest of ~78 coins by trailing
20-day return, daily rotation, 10 bps/turn) reported **+12,614%** over 3,938 daily bars with an annualized
Sharpe of **0.94** and a **Deflated-Sharpe of 0.98** (clears the deflation bar). On its face: a goldmine.

We ran four independent checks:

| Check | Result | Reading |
|---|---|---|
| **Return concentration** | max single bar +41%; top-5 bars ≈ 188% (~1.5% of total); only 2 coins ever had a >100% day | **distributed** — not one lucky tick |
| **Beta benchmark** (equal-weight buy-and-hold of the same universe) | beta cum **+22,710%**, Sharpe **1.02** | buy-and-hold did **BETTER** |
| **Excess over beta (alpha)** | full-sample alpha-Sharpe **+0.20**; **OOS alpha-Sharpe −0.06** | no alpha out-of-sample |
| **PBO** (probability of backtest overfit) | **0.51** | the *config selection* is overfit (IS-best collapses 0.94→0.18 OOS) |

**Conclusion:** the +12,614% is **bull-market beta, captured *worse* than just holding the basket**. It is
not a data artifact and not a tradeable edge. The DSR 0.98 is a trap here — deflation alone doesn't catch
that the whole *family* is beta; the PBO 0.51 and the beta benchmark do.

> The lesson: **a large cumulative number means nothing without a beta benchmark and an out-of-sample
> alpha check.** "It made 126×" is not a reason to trade if buy-and-hold made 227×.

---

## 2. The Trade Advocate — affirmative reasons, honest truth

`src/lib/backtest/trade-advocate.ts` · `tradeAdvocate(case, thr)` → `{ recommendation, roiVerdict, advocate[], truth[], metrics }`

It is built to **advocate** (the user wants reasons to trade and to buy) — but it earns the right to
advocate by first telling the truth about what a big ROI actually is:

| `roiVerdict` | When | `recommendation` |
|---|---|---|
| `artifact_risk` | >50% of the growth sits in ≤5 bars | `NO_TRADE` (audit the data) |
| `underperforms_beta` | buy-and-hold beat it (cum or Sharpe) | `JUST_HOLD` (hold the basket) |
| `beta_not_alpha` | ties/beats beta in-sample, **OOS excess ≤ 0** | `JUST_HOLD` |
| `real_edge` + PBO≥0.3 or DSR≤0.95 | beats beta OOS but not robust | `PAPER` |
| `real_edge` (clean) | **beats beta OOS** + PBO<0.3 + DSR>0.95 | `TRADE` |
| `too_thin` | < 250 bars | `NO_TRADE` |

On the **real** relstr case it renders:

```
TRADE ADVOCATE: JUST_HOLD  (underperforms_beta)
strategy +12614% / Sharpe 0.94  vs  beta +22710% / Sharpe 1.02  · OOS alpha-Sharpe -0.06

advocate (reasons to act):
+ cumulative +12614% over 3938 bars
+ ann.Sharpe 0.94
+ Deflated-Sharpe 0.98 > 0.95 (survives multiple-testing)

truth:
- a buy-and-hold of the basket did BETTER (+22710% vs +12614%, Sharpe 1.02 vs 0.94) — the big
  number is (worse-captured) market BETA, not edge. The reason to "buy" is to HOLD the basket.
```

It still lists the genuine positives (the affirmative case), then states plainly why this particular ROI
is not a reason to run the strategy. The affirmative `TRADE` verdict fires **only** for a genuine,
robust out-of-sample edge over beta — which is exactly the bar a real "reason to buy" has to clear.

Wired into `npm run backtest:relstr` (prints under the Proof Council). Pairs with:
- **Proof Council** (`proof-council.ts`) — edge vs penny-lock objectives, gates capsule promotion.
- The **equal-weight buy-and-hold benchmark** (`cross-asset.ts` `equalWeightBuyHoldReturns`) — the beta yardstick.

---

## 3. Multi-venue data — Coinbase + Kraken, and an artifact detector

`src/lib/data/` adds a second, independent, **keyless** price source and a cross-venue check, so we stop
being hostage to a single venue's candles (the audit's deeper worry).

- `venue-candles.ts` — one normalized `VenueCandle` shape + `sanitizeCandles` (drop non-positive /
  impossible / duplicate bars, sort) + Coinbase Exchange/Advanced parsers.
- `kraken.ts` — `fetchKrakenOHLC(product, granularity)` (Kraken `OHLC`, BTC→XBT/DOGE→XDG pair mapping,
  true-OHLC row order), no auth.
- `cross-venue.ts` — `crossVenueAgreement(a, b)` → `agree | minor_drift | suspect`, `flagDivergentBars`
  (single-source artifacts), `consolidatedCloses` (robust mean where venues agree).
- `scripts/cross-venue-check.ts` → `npm run data:cross-venue`.

**Real run (Coinbase warehouse vs live Kraken, ONE_DAY):**

```
coin       overlap  med bps  p95   max    only-CB/KR   verdict
BTC-USD    718      1.6      6.2   67.7   3251/3       ✗ suspect (only the latest bar)
ETH-USD    718      1.7      6.6   126.0  2946/3       ✗ suspect (only the latest bar)
SOL-USD    718      1.9      7.5   81.1   1092/3       ✗ suspect (only the latest bar)
```

Two findings:
1. **The warehouse is clean.** Median 1.6–1.9 bps disagreement over 718 daily bars is two independent
   exchanges telling the same story — strong corroboration that the relstr returns are *real prices*
   (reinforcing "beta, not artifact").
2. **The latest bar (2026-05-31) is stale/partial** on every coin (68–126 bps off Kraken). **Don't trade
   on the freshest warehouse bar without refreshing it** — that single bar is the only "suspect" in 718.

---

## 4. Bottom line — the honest answer to "what happens with \$100?"

On real data, **no strategy family clears the bar to deploy** (all → `REPAIR_FIRST`):
- cross-sectional momentum (`momT-10d`): OOS-Sharpe 0.32 held + PBO 0.00, but only 4/9 family held → weak.
- relative strength (`rs20/top2`): big cum + DSR 0.98 but **PBO 0.51 + underperforms beta** → `JUST_HOLD`.
- pairs stat-arb: OOS −0.89, −55% cum, 0/9 held → **crypto is momentum, not pairs-MR**.
- momentum pack (harden:priors): 0/6 hardened (`super`/`@btc` competitive but not clean).

So the truthful answer remains: **don't deploy \$100 into any of these yet.** The next real progress is
**data and regime**, not more strategies — deflation makes adding "brains" strictly harder, and the
honest edge has to beat *holding the basket* out-of-sample, which none of these do.

What the advocate *would* greenlight: a strategy that beats equal-weight buy-and-hold **out-of-sample**
with **PBO < 0.3** and **DSR > 0.95**. That's the live bar. Nothing meets it today — and that is the
truth the advocate exists to tell.

---

## 5. "Is there a REGIME with alpha?" — and the warehouse splice it uncovered

The honest follow-up: unconditional strategies are beta, so does a strategy beat buy-and-hold *inside a
regime*? `src/lib/backtest/candle/regime.ts` labels each bar (vol / trend / breadth, all no-lookahead,
self-calibrating) and `regimeConditionalAlpha` computes excess-over-beta OOS per regime;
`npm run analyze:regime` scans the strategy × regime grid.

**The multiple-testing trap, made concrete.** Scanning 195 cells, **66 "beat beta OOS"** by ≥0.3 excess
Sharpe — but that ignores sample size + search width. With a one-sided **Bonferroni** bar (t > 3.47 over
195 tests; best observed t ≈ 2.2), **0/195 survive**. The 66 were a multiple-testing illusion. The tool
now prints this verdict directly (`multipleTestingReport`), not the misleading lead count.

**A "defensive / crisis-alpha" pattern appeared — and adversarial verification destroyed it.** 20 cells
showed the strategy positive while buy-and-hold was negative (low-vol/bear), the trend-following
go-to-cash signature. An 8-agent verification workflow (3 independent verifiers + 3 refute-by-default
skeptics) found:

- **Direct pre-registered test** (`scripts/trend-defensive-test.ts`, `npm run test:trend-defensive`):
  the trend portfolio is a **~0.8× beta clone**, not a diversifier — corr(trend, beta) **0.81–0.83**,
  down-capture ≈ up-capture (convexity gap **−0.02**), mean return on down-beta days **−1.9…−2.3%**
  (t −18…−21). It *never* makes money when the market falls. **REFUTED.**
- **Permutation null:** a 200× time-shuffle (destroys any real regime→return link) yields *more*
  defensive cells (18.9) than the real definitions (11.4), median p = 0.985 — the pattern is a
  descriptive arithmetic coincidence, not a regime effect.
- **The root cause — a DATA SPLICE.** Three skeptics independently found the warehouse is two ingests
  glued together: **12 Coinbase `-USD` symbols** (full history → 2026) and **66 Binance `USDT` symbols
  that all die 2024-12-31**. The OOS window crosses that date, so the equal-weight buy-and-hold benchmark
  **loses 85% of its names mid-sample** (active count collapses 78 → 12 on 2025-01-01).

**The fix** (`src/lib/backtest/candle/universe.ts`): cohort selection (`restrictToConvention`, `aliveAtEnd`)
+ a **splice detector** (`universeHealth` flags the largest one-day active-coin drop). Both analysis
scripts take `--universe all|usd|usdt|alive` and auto-print a `⚠ SPLICE` warning.

Re-running on clean single-source cohorts:

| Universe | relstr verdict | regime defensive cells | Bonferroni survivors |
|---|---|---|---|
| `all` (spliced) | JUST_HOLD (OOS excess vs spliced beta) | 20 | 0 / 195 |
| `usd` (12 coins, clean) | **JUST_HOLD — OOS excess Sharpe −0.00, pure beta** | **1** | 0 / 195 |
| `usdt` (66 coins, 2021-24) | **NO_TRADE — artifact_risk, DSR 0.74** | 23 | 0 / 135 |

The "20 defensive cells" collapse to **1** on the clean USD universe — ~95% of the finding was a splice
artifact. **No regime-conditional alpha survives multiple-testing on any clean cohort.**

**What this thread actually delivered:** the "next progress is data/regime" turned out to mean *the data
was broken*. Adversarial verification caught a warehouse splice that was inflating the relstr audit and
manufacturing a fake "defensive sleeve." The honest, corrected verdict is stronger than before — on clean
current data (`usd`), relstr is pure beta with **zero** out-of-sample alpha — and backtests now detect and
refuse the splice automatically. The lesson that started this (big ROI ≠ edge) now has a companion:
**a "regime edge" found by scanning is a hypothesis count, not a result — correct for it, and verify the
data underneath it before believing anything.**

---

## 6. Which source is ahead? Cross-venue agreement + lead-lag (2026-06-04)

After unlocking the **full Binance API** (geo-block bypass: the repo's existing Webshare proxy,
`src/lib/polymarket/proxy-routing.ts`, generalized to data venues in `src/lib/data/proxy-fetch.ts`
+ `binance.ts` — funding rates included), we asked which venue leads on price.

**The "13% gap" was a red herring** — a date misalignment (Coinbase 05-31 vs Binance 06-03). On
matched timestamps (`npm run analyze:lead-lag`, minute candles):

| Pair | Median divergence | Verdict |
|---|---|---|
| Coinbase ↔ Binance | **15 bps** (the USDT/USD basis) | agree |
| Coinbase ↔ Kraken | **1.6 bps** | agree |

So the mirror-sourced USDT backfill is validated, and minute lead-lag is **synchronous** (lag 0,
corr 0.96) — venues sync within a minute, so the real lead is sub-second.

**Sub-second answer (`npm run analyze:ws-leadlag`, live WS ticks)** — Coinbase direct vs Binance
through the proxy, cross-correlating returns on 200–250ms buckets, two runs:

| Clock | Run 1 (90s) | Run 2 (120s) |
|---|---|---|
| Exchange-time (true) | **Binance leads 400ms** | **Binance leads 500ms** |
| Receive-time (proxy-biased) | Binance leads 200ms | Binance leads 250ms |

**Binance leads Coinbase** — robustly, on both clocks and both runs. The receive-clock figure is a
*conservative lower bound*: Binance leads even though the proxy ADDS latency to its path, so the
true market lead is larger (the exchange-clock ~400–500ms). This matches the well-documented
reality that **Binance is the dominant BTC price-discovery venue; Coinbase follows.**

Caveat / honesty: lead-lag is descriptive, not directly tradeable — a venue you can't reach
faster than your own latency (here, *plus* a proxy hop) is not an executable edge. It tells you
which feed to trust for price *discovery* (Binance) and which is downstream (Coinbase).

---

## Files / commands

| Path | What |
|---|---|
| `src/lib/backtest/trade-advocate.ts` | `tradeAdvocate` + `renderTradeAdvice` |
| `src/lib/backtest/candle/cross-asset.ts` | `equalWeightBuyHoldReturns` (beta benchmark) |
| `src/lib/data/{venue-candles,kraken,cross-venue}.ts` | multi-venue data + artifact detector |
| `src/lib/backtest/candle/regime.ts` | regime labels + `regimeConditionalAlpha` + `multipleTestingReport` (Bonferroni) |
| `src/lib/backtest/candle/universe.ts` | cohort selection + splice detector (`universeHealth`) |
| `npm run backtest:relstr -- --universe usd` | relstr gauntlet + Proof Council + Trade Advocate (clean cohort) |
| `npm run analyze:regime -- --universe usd` | regime-conditional alpha scan + Bonferroni verdict |
| `npm run test:trend-defensive` | pre-registered down-capture test (trend = beta clone) |
| `npm run data:cross-venue -- --coins BTC-USD,ETH-USD` | Coinbase vs Kraken agreement report |

Tests: `tests/unit/{trade-advocate,cross-asset,cross-asset-trend.props,venue-candles,kraken,cross-venue,regime.props,universe}.test.ts`.
