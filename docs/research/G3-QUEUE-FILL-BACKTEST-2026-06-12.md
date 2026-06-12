# G3 — merge-maker on real Polymarket L2 with back-of-queue fills

**Date:** 2026-06-12
**Gate:** POLYMARKET-STACK-AUDIT §5 G3 — replay the pair-maker (complete-set merge
maker, `src/lib/strategies/binary-pair-maker.ts`) through the queue-position fill
model (`src/lib/backtest/queue-fill.ts`) on REAL PMXT L2 history, so the
PnL/pair-completion read no longer rides the forward-paper loop's optimistic
front-of-queue LTP fills (RAILS-REVIEW-2026-06-11 finding 4).
**Verdict up front: NEGATIVE — and robust.** Total **−$1,130 over 162 real
5-min windows** (−$6.98/window mean, −$6.40 median), with the loss invariant
across the entire queue-assumption bracket (behind −$1,114 / prorata −$1,130 /
ahead −$1,196). Pair completion is *good* (84.6%) and it still loses: the bleed
is adverse selection, not fill starvation.

## Setup

| Piece | Value |
|---|---|
| Data | PMXT v2 hourly parquet, `2026-06-10T14 … T20` UTC (7 hours, ~3.0 GB, r2v2 bucket, $0) |
| Markets | `btc-updown-5m-*` + `eth-updown-5m-*` (June-relaunch series), every window inside the span |
| Windows | 82 starts × 2 families = 164 candidates → **162 resolved** (2 skipped: transient Gamma connection errors on the 16:20 pair), 0 empty legs |
| Extraction | `scripts/pmxt_extract_batch.py` — one DuckDB scan per hour for all tokens, per-token top-10 book-update JSONL (deduped) + trade prints; manifest carries the REAL 0/1 settle from Gamma `outcomePrices` (`closed=true`) |
| Extracts | `/Volumes/My Passport/hft-data/pmxt/extracts/2026-06-10/` (324 token streams + `manifest.json` + `g3-results-{prorata,behind,ahead}.json`) |
| Runner | `scripts/pair-maker-backtest.ts` — `planPairQuotes()` every 2 s; fills ONLY via queue-position accounting (join the BACK of the visible queue, 250 ms ack latency; same-price re-quotes KEEP queue position); complete sets merged at $1 (`settleMerge`); residual marked to the real settle |
| Fair value | `fairValueFromMinuteCloses` on real Binance 1m closes (data-api.binance.vision, disk-cached), volBars 10, spot = last COMPLETED minute's close (no intra-bar lookahead); strike = Binance 1m open at window start |
| Params | size 25 sh, mergeMargin 2¢, feeBuffer 0.5¢, maxUnpaired 50, tauFloor 60 s, safetyEdge 1¢ — identical to `binary-pair-maker-paper.ts` defaults |
| Fees | crypto category: maker rebate = 20% of the fee-equivalent curve per fill; no taker fees (we only post) |

Repro:

```bash
python3 scripts/pmxt_fetch.py 2026-06-10T14 … 2026-06-10T20
python3 scripts/pmxt_extract_batch.py --hour 2026-06-10T14 … --hour 2026-06-10T20 \
    --families btc-updown-5m,eth-updown-5m --top 10 \
    --out-dir "/Volumes/My Passport/hft-data/pmxt/extracts/2026-06-10"
npx tsx scripts/pair-maker-backtest.ts --manifest ".../manifest.json" --cancel-mode prorata
```

## Results (headline = prorata cancel attribution)

Decomposition identical to TradingBot2's `lastminute/merge_report.py`:
maker income (locked merge margin + rebates) vs residual settle PnL.

| Metric | Value |
|---|---|
| Windows | 162 (fills in 146) |
| Fills | 1,750 (33,257 shares; 19.0 sh/fill avg) |
| Merged sets | 14,062 → **pair completion 84.6%** (btc 89.1%, eth 72.9%) |
| Locked merge margin | **−$105.95** (yes, negative — see failure mode 1) |
| Rebates | +$95.88 |
| **Maker income** | **−$10.07** |
| Residual shares | 5,133 (cost $2,177.00 → settled $1,056.92, a −51% haircut) |
| **Residual settle PnL** | **−$1,120.08** over 139 residual windows — only 34 wins (24%) |
| **TOTAL** | **−$1,130.14** (−$6.98/window mean, median −$6.40; 97 neg / 49 pos; min −$59.89, max +$49.77) |
| Verdict (merge_report rule) | **NEGATIVE: adverse selection on unpaired inventory exceeds merge margin** |

### By-unpaired bucket split (same buckets as merge_report)

| Bucket | n | net | maker income | residual |
|---|---|---|---|---|
| paired(≤10) | 37 | −$45.15 | −$43.70 | −$1.45 |
| mild(10–30) | 47 | −$154.55 | +$0.84 | −$155.39 |
| heavy(>30) | 78 | −$930.45 | +$32.79 | −$963.24 |

The bleed concentrates in heavy-unpaired windows — the same shape TradingBot2's
forward track shows — **but here even the fully-paired bucket loses**, on the
merge margin itself.

### By kind

| Family | n | fills | merged | pnl | maker income |
|---|---|---|---|---|---|
| btc-updown-5m | 81 | 1,290 | 10,669 | −$533.16 | +$8.55 |
| eth-updown-5m | 81 | 460 | 3,393 | −$596.99 | −$18.62 |

### Queue-assumption bracket (MBP ≠ MBO honesty)

| cancel mode | filled sh | completion | maker income | residual | TOTAL |
|---|---|---|---|---|---|
| behind (pessimistic) | 31,687 | 84.2% | −$43.36 | −$1,070.92 | **−$1,114.28** |
| prorata (neutral) | 33,257 | 84.6% | −$10.07 | −$1,120.08 | **−$1,130.14** |
| ahead (optimistic) | 34,759 | 84.4% | −$2.09 | −$1,193.78 | **−$1,195.86** |

The verdict does not move anywhere in the bracket. More fills ≠ more money —
the *ahead* mode fills MORE and loses MORE, which is the adverse-selection
signature in one line.

## The two failure modes the optimistic fill model masked

1. **Sequential-leg fills break the pair budget.** `planPairQuotes` enforces
   `bidYES + bidNO ≤ 0.975` on the two *currently resting* bids — but the legs
   fill at different times. The first leg fills when the market moves against
   it; the planner then re-prices the second leg UP (fair moved), and when it
   finally fills, the *realized* pair cost can exceed $1. **56 of 146 active
   windows merged pairs at negative margin**, aggregating to −$105.95 locked
   "margin". The live paper loop's LTP fill model fills both legs essentially
   simultaneously at the quoted prices, so its locked margin is positive by
   construction — this failure mode is invisible there.
2. **The residual is the losing side, almost deterministically.** The unpaired
   remainder isn't a coin-flip: it is precisely the inventory the tape swept
   through while the other leg sat unfilled. Residual cost basis $2,177 settled
   to $1,057 — a 51% haircut vs the ~0% a fair coin-flip at cost would expect —
   and only 24% of residual windows won. With a 25-share quote and a 50-share
   cap, 78/162 windows ended heavy (>30 unpaired).

Both are the same root cause at different scales: **back-of-queue makers in
these books get filled exactly when they're wrong.** Pair completion (84.6%)
was never the problem.

## LIMITATIONS (read before acting on this)

- **Coverage: 7 hours of ONE day** (2026-06-10 14:00–21:00 UTC), one vol
  regime, June-relaunch era of the 5m series. 162 windows but heavily
  cross-correlated (BTC and ETH share the same hours). This is a walk-forward
  read on real data, not a multi-regime study. PMXT archive had a gap after
  2026-06-11T03 at run time, so the originally-planned 2026-06-11 day was
  unavailable.
- **Trade tape = v2 `last_trade_price` prints, per token.** Two opposed biases:
  (a) cross-book matches (a DOWN buyer crossing with our UP bid via mint) may
  not print on our token's tape → we *under-fill* the pairing side
  (pessimistic for completion); (b) the post-trade book update can arrive
  before its print, double-counting queue consumption (optimistic — documented
  queue-fill boundary). Neither is modeled; they pull in opposite directions.
- **MBP, not MBO:** true queue position is unknowable from L2. That is exactly
  why the three cancel-attribution brackets are reported; the verdict is
  invariant across them.
- **Fair-value feed:** Binance 1m closes (spot lags ≤60 s vs the live loop's
  WS trade ticks) and strike = Binance 1m open (Polymarket resolves these off
  its own oracle source). Both affect WHERE we quote, not how fills or settles
  are computed. A finer spot feed would move quotes somewhat, not repeal
  failure mode 2.
- **Fixed params, no sweep:** size 25 / cap 50 / margin 2¢ / 2 s re-quote, the
  forward-paper defaults. Not optimized — deliberately, to judge the strategy
  as it actually runs in the G2 daemon.
- **Latency = flat 250 ms ack;** no rate limits, no $1 rebate payout
  threshold, no LP reward credits.
- 2 of 164 windows lost to transient Gamma resolution errors (recorded in
  `manifest.json.skippedSlugs`).

**What could change the verdict (testable with this same harness):**
(i) a *realized-cost* pair guard — cap the second leg's bid at
`$1 − margin − heldLegAvgCost` instead of vs the current first-leg quote
(directly attacks the −$106 locked margin); (ii) a much tighter unpaired cap
(10 instead of 50) or pairing-only quoting (attacks the heavy bucket, at the
cost of volume); (iii) evidence that cross-book mints materially under-print
the pairing side (would raise completion AND shrink residuals — needs on-chain
OrderFilled backfill joined to the book, our existing eth_getLogs path);
(iv) more hours/regimes showing this day was an outlier. Until one of those
lands, **G3 says the merge-maker as currently parameterized is not deployable**
— the G2 forward-paper's positive locked margin is an artifact of its
optimistic fill model, exactly what this gate existed to check.

## Files

- `scripts/pmxt_extract_batch.py` — batch window extractor (new)
- `scripts/pair-maker-backtest.ts` — G3 backtest runner (new)
- Data + per-run results JSON: `/Volumes/My Passport/hft-data/pmxt/` and
  `…/extracts/2026-06-10/` (parquet + extracts stay on the passport, not in git)
- Existing, unchanged: `src/lib/backtest/queue-fill.ts` (27 tests),
  `src/lib/strategies/binary-pair-maker.ts` (13 tests), `src/lib/backtest/pmxt.ts`
