# Early-dip resting bid — honest queue-fill verdict: DEBUNKED

**Date:** 2026-06-13
**Harness:** the G3 back-of-queue queue-fill model
(`src/lib/backtest/queue-fill.ts`) reused on the PMXT extracts already on disk
(`docs/research/G3-QUEUE-FILL-BACKTEST-2026-06-12.md`). No new fetch.
**Data:** PMXT v2 hourly parquet 2026-06-10T14–T20 UTC, btc/eth-updown-5m,
162 windows (324 token streams), real Gamma 0/1 settles. Same data as G3/V2/V3.
**Runner:** `scripts/dip-catcher-backtest.ts`.

## The idea tested

Rest a FLAT cheap bid (X ∈ {2¢, 3¢, 5¢}) on BOTH the Up (YES) and Down (NO)
token of each 5-min window for the whole window, hold any fill to the real 0/1
settle. The optimistic mid-touch backtest claimed a side often dips ≤3¢
early/mid-window then REVERSES and wins **~8%** (vs the ~3% the 3¢ price implies,
z≈8.4), beating the late penny-sniper (≈60 s pre-close, 0.83% win) because the
early dip has minutes to reverse.

## The decisive question

The optimistic backtest assumed **"mid touched 3¢ ⇒ filled at 3¢."** That is the
exact fill optimism G3 was built to kill. Honest fills require the real trade
tape to **SELL THROUGH** the resting bid: a SELL print at/through our price
consumes the visible queue ahead, then us (`queue-fill.ts`, back-of-queue). If
nobody dumps the losing side through Xc, we never fill.

## Result — the win rate collapses to the price-implied rate

| flat bid | lots filled (of 324 sides) | **honest win rate** | Wilson low | price-implied | optimistic claim | net PnL | $/staked | OOS PnL |
|---|---|---|---|---|---|---|---|---|
| **2¢** | 101 | **3.96%** | 1.55% | 2% | ~8% | +$39.27 | +84.9% | +$7.62 |
| **3¢** | 109 | **3.67%** | 1.44% | 3% | ~8% | +$20.40 | +25.6% | **−$4.77** |
| **5¢** | 121 | **5.79%** | 2.83% | 5% | ~8% | **−$12.62** | **−8.8%** | −$6.18 |

**The honest-fill win rate lands right on the price-implied probability at every
price (2%→3.96%, 3%→3.67%, 5%→5.79%) — nowhere near the optimistic 8%.** A
one-sided binomial test against H0 (true win prob = the price) does NOT reject at
any price:

| price | wins/lots | P(≥wins \| win = implied) |
|---|---|---|
| 2¢ | 4/101 | 0.145 |
| 3¢ | 4/109 | 0.414 |
| 5¢ | 7/121 | 0.402 |

Compare the optimistic claim's z≈8.4 (p<1e-16). On honest fills there is **no
statistical edge over the fair price** — the "8% win at 3¢" was an artifact of
assuming a mid-touch fills you. When you require a real seller to hit your bid,
you get filled at the fair price and win at the fair rate. The dip does reverse
sometimes — exactly as often as a 3¢ contract should resolve YES, no more.

### Why the optimism inflated it (the mechanism)

A flat 3¢ bid is the *cheapest* resting order; in the honest model it fills only
when the tape capitulates THROUGH 3¢ — i.e. precisely when the market has just
re-priced that side as a near-certain loser. The fills are adversely selected by
construction. The mid merely *touching* 3¢ (what the optimistic backtest counted)
includes all the cases where the price dipped and recovered WITHOUT a forced
seller — the very reversals the idea wanted to harvest, which by definition never
filled us. The honest model removes exactly the winning cases the optimistic one
invented.

## Discipline applied

- **Walk-forward (first-half starts = IS, second-half = OOS, split at start
  1781112900 → 80 IS / 82 OOS windows):** the only positive total (2¢) keeps a
  small positive OOS (+$7.62), but 3¢ and 5¢ go **negative OOS** (−$4.77,
  −$6.18). The IS "edge" does not survive out of sample at the prices that
  matter.
- **Concentration:** at 2¢ the entire +$39 is **4 winning lots out of 101**
  (top-10% of winners = 29% of positive PnL); at 3¢, 4 winners of 109. This is
  the optimistic version's "97% of gains in 34 bets" pathology **made worse** —
  here it's 4 lots. A handful of lucky reversals on a 162-window day is noise,
  not signal.
- **Family split:** btc carries all the (tiny, noisy) positive PnL; **eth loses
  at every price** (−$7.22 / −$9.60 / −$10.12). No coherent cross-symbol edge.
- **Effective N: ~2 symbol-days.** 162 windows but 7 contiguous UTC hours of ONE
  day, one vol regime, BTC and ETH sharing every hour and every Binance move;
  windows within a symbol-hour share book state. After honest fills only ~100–121
  lots actually fill, ≈4 of them win — the effective sample for the win-rate
  claim is a few dozen independent events at best. 1 sides total had no trade
  tape at all (queue-fill correctly filled it 0; not simulated).

## proofCouncil verdict

Run on the best-PnL price (2¢), `objective: "edge"`:

```
PROOF COUNCIL: REPAIR_FIRST
action: do NOT deploy — fix the blocker(s) before the edge claim is meaningful
advocate:
+ cumulative PnL +84.9% net of 0bps fees over 101 filled lots
+ OOS ann.Sharpe 0.50 HELD out-of-sample (walk-forward)
+ win 4.0% on 101 trades, Wilson floor 1.6%
skeptic:
- only 1/3 variants held OOS (≤ half) — selection looks like noise
```

The +84.9% "cum PnL" advocate line is itself the trap: it is +$39 on $46 staked,
driven by 4 lots, and the council's own skeptic flags the kill — **only 1 of 3
price variants held OOS**, i.e. the apparent edge is variant-selection noise. The
blocker stands: REPAIR_FIRST, do not deploy. (The honest framing the council
can't see numerically: the win rate is statistically equal to the fair price, so
there is nothing to repair — there is no edge to recover.)

## VERDICT: **DEBUNKED**

The early-dip resting bid does **not** survive honest back-of-queue fills. It is
the same fill-optimism failure as the late penny-sniper, one layer earlier: the
optimistic mid-touch backtest counted reversals that, by construction, never
filled a resting bid, because filling a cheap bid requires a seller to trade
through it — which only happens when that side has genuinely become a loser. On
honest fills:

- win rate collapses from the claimed ~8% to the **price-implied 3.7–5.8%**
  (binomial p = 0.15–0.41 vs the fair price — no edge);
- net PnL is small-and-noisy at 2¢/3¢ (4 winning lots), **negative at 5¢**, and
  **negative OOS at 3¢/5¢**;
- eth loses at every price; concentration is extreme (≈4 lots);
- proofCouncil = **REPAIR_FIRST** (variant selection looks like noise).

This is **not** the first new edge — it is the optimistic backtest's fill
assumption failing the same way G3 predicted. The honest recommendation is to
DROP the early-dip resting bid and not waste a forward track on it. (Caveat per
discipline: this is ~2 symbol-days / one regime, so the claim is "no edge
detectable on honest fills here," not a universe-wide impossibility proof — but
the mechanism argument, not just the sample, is what condemns it: cheap resting
bids fill adversely.)

## Files

- `scripts/dip-catcher-backtest.ts` — flat-Xc-both-sides mode on the G3 queue-fill harness + walk-forward + concentration + proofCouncil (new)
- `tests/unit/dip-catcher-fill.test.ts` — 4 cases locking the honest-fill mechanic (mid-touch ≠ fill; only a SELL through the bid fills) — 61/61 with queue-fill + proof-council
- Results JSON: `/Volumes/My Passport/hft-data/pmxt/extracts/2026-06-10/dip-catcher-results.json`
- Lineage: `docs/research/G3-QUEUE-FILL-BACKTEST-2026-06-12.md`, `G3-V2-COST-GUARD-2026-06-12.md`, `G3-V3-FILLRISK-2026-06-12.md`
