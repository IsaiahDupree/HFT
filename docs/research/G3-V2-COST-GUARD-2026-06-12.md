# G3-V2 — realized-cost pair guard on the merge-maker (same real PMXT L2)

**Date:** 2026-06-12
**Builds on:** `docs/research/G3-QUEUE-FILL-BACKTEST-2026-06-12.md` (G3 control: −$1,130,
locked margin −$106 even at 84.6% completion — legs fill sequentially so the
completing leg re-prices up and pairs merge at >$1).
**Same data, no new fetch:** `/Volumes/My Passport/hft-data/pmxt/extracts/2026-06-10/`
(PMXT v2 hourly parquet 2026-06-10T14–T20 UTC, btc/eth-updown-5m, 162 windows,
real Gamma 0/1 settles, real Binance 1m fair-value feed). Same queue-fill model
(back-of-queue, 250 ms ack, prorata cancel attribution, 2 s re-quote).

## Headline answers

1. **Does the guard fix locked margin? YES — decisively.** Summed locked margin
   goes **−$105.95 → +$837.99** and **negative-margin windows 56 → 0**. The
   structural defect G3 found is repaired exactly as designed: no pair completes
   below `mergeMargin` in realized terms.
2. **Does any config go non-negative total? NO.** All four still lose
   (−$1,130 / −$902 / −$528 / −$238). The guard converts the loss from
   "structural (negative margin)" into "directional (residual adverse
   selection)" — but does not eliminate it. The residual gets *worse* with the
   guard (it makes the completing side bid lower / withdraw, leaving more
   unpaired inventory), and that unpaired inventory is **not a coin-flip**:
   residual win-rate is 11–24% across configs.

## The realized-cost pair guard (what was ported)

`src/lib/strategies/binary-pair-maker.ts` — new optional `params.costGuard`
(+ optional `yesCost`/`noCost` inputs the planner already had on hand). When ON
and one side holds unpaired inventory, the COMPLETING bid is capped at
`1 − mergeMargin − held_avg_cost`; if no tick-valid price survives, the
completing side is withdrawn. Floors by tick WITHOUT clamping up to 0.01 (a cap
below one tick → withdraw), matching the reference. Default off → baseline
planner byte-for-byte unchanged. Ported from TradingBot2
`research/lastminute/merge_maker.py::plan_merge_quotes` (`cost_up`/`cost_down`,
commit 770329c). 5 new vitest cases; `npx vitest run` queue-fill + pair-maker =
**45/45 pass**.

## The four pre-specified configs (prorata cancel attribution, reported in full)

| | config | windows | completion | **locked margin** | neg-margin windows | rebates | maker income | residual | **TOTAL** |
|---|---|---|---|---|---|---|---|---|---|
| **(a)** | baseline, no guard | 162 | 84.6% | **−$105.95** | **56** | +$95.88 | −$10.07 | −$1,120.08 | **−$1,130.14** |
| **(b)** | +cost-guard | 162 | 76.2% | **+$837.99** | **0** | +$80.48 | +$918.47 | −$1,820.87 | **−$902.40** |
| **(c)** | +guard +cap 50→10 | 162 | 78.9% | **+$346.99** | **0** | +$44.81 | +$391.81 | −$920.11 | **−$528.30** |
| **(d)** | +guard +cap 10 +eth only | 81 | 71.1% | **+$130.08** | **0** | +$14.42 | +$144.51 | −$382.84 | **−$238.34** |

Per-window (mean / median / windows positive):
(a) −$6.98 / −$6.40 / 49 of 162 · (b) −$5.57 / −$5.04 / 54 of 162 ·
(c) −$3.26 / −$4.16 / 50 of 162 · (d) −$2.94 / −$2.10 / 26 of 81.

### By-unpaired bucket split

**(a) baseline** — maker income | residual:
- paired(≤10) n=37: net −$45.15 (maker **−$43.70**, resid −$1.45)  ← negative even when paired (the locked-margin bug)
- mild(10–30) n=47: net −$154.55 (maker +$0.84, resid −$155.39)
- heavy(>30) n=78: net −$930.45 (maker +$32.79, resid −$963.24)

**(b) +cost-guard**:
- paired(≤10) n=36: net **+$188.03** (maker +$188.21, resid −$0.18)  ← guard makes paired windows PROFITABLE
- mild(10–30) n=26: net +$72.87 (maker +$184.07, resid −$111.20)
- heavy(>30) n=100: net −$1,163.30 (maker +$546.19, resid −$1,709.49)  ← guard pushes more windows here

**(c) +guard +cap 10**:
- paired(≤10) n=45: net **+$130.86** (maker +$134.92, resid −$4.06)
- mild(10–30) n=110: net −$590.04 (maker +$248.56, resid −$838.60)
- heavy(>30) n=7: net −$69.12 (maker +$8.33, resid −$77.45)  ← cap-10 nearly empties the heavy bucket

**(d) +guard +cap 10 +eth only**:
- paired(≤10) n=26: net **+$64.43** (maker +$62.14, resid **+$2.28**)
- mild(10–30) n=50: net −$260.34 (maker +$78.70, resid −$339.04)
- heavy(>30) n=5: net −$42.43 (maker +$3.66, resid −$46.09)

## What this proves and what it doesn't

- **The structural fix is real and it works.** In EVERY guarded config, the
  paired(≤10) bucket — windows where the maker actually balanced its book — is
  **profitable** (+$188 / +$131 / +$64), and zero pairs lock negative margin.
  This is the deploy-worthy result: the merge mechanic, when the maker stays
  balanced, earns the locked margin it's supposed to.
- **The remaining loss is the residual, and it's adverse, not random.** Across
  configs the residual win-rate is 24% / 15% / 14% / 11% — far below the ~50%
  a fair coin-flip at cost would give. The unpaired inventory is precisely the
  side the tape swept through while the complement sat unfilled; holding it to
  the 0/1 settle is a losing bet by construction. Tightening the cap (c, d)
  shrinks the residual loss (−$1,121 → −$920 → −$383) but never to zero,
  because every cap level still ends *some* windows unpaired, and those windows
  lose.
- **No config crosses zero on this window.** The honest verdict by the
  `merge_report` rule is NEGATIVE for all four. The guard moved the failure
  from "margin" to "completion": the lane needs completion high enough that the
  paired-bucket profit outweighs the residual on the windows that don't balance,
  and on this day it isn't.

## CALIBRATION / HONESTY

- **(b) the cost-guard is a STRUCTURAL fix — deploy-worthy on its own merits.**
  It changes no parameter; it enforces an invariant the strategy already
  claimed (every pair locks ≥ margin). It fixed locked margin from −$106 to
  +$838 with 0 negative-margin windows, which is the falsifiable structural
  prediction this round was built to test. It should ship to the G2 forward
  paper loop regardless of the total PnL on one window, because it removes a
  latent way to lose money that the optimistic live fill model can't even see.
- **(c) cap-10 and (d) btc-exclude are PARAMETER CHOICES fit to THIS 7-hour
  window. Do NOT bank their numbers.** They were pre-specified (not searched —
  the four configs were fixed before any run, per the round-2 instruction), but
  "pre-specified" is not "validated": both are in-sample selections on a single
  day's worth of correlated windows. cap-10 is a knob trading volume for
  balance; the eth-only cut is a post-hoc observation that btc lost more here
  (btc −$441 vs eth −$462 under the guard — and note that's NOT a clean eth win,
  eth simply has fewer fills). Neither is an edge until a FORWARD paper track
  with independent resolution holds them up. Treating −$238 (config d) as
  "closest to break-even therefore best" would be exactly the overfitting the
  round-2 brief flagged.
- **Effective sample size is small.** 162 windows but heavily
  cross-correlated: 7 contiguous UTC hours of ONE day (2026-06-10), one vol
  regime, BTC and ETH sharing every hour. The btc/eth split is ~2 independent
  symbol-days, and the windows within a symbol-hour share book state and the
  same Binance move. Config (d) is 81 windows = roughly one symbol-day. As a
  walk-forward read this is a single sample, not a distribution. The originally
  planned 2026-06-11 day was unavailable (PMXT archive gap after T03 at run
  time).
- **Same fill-model limitations as G3 carry over unchanged:** MBP≠MBO (queue
  position unknowable — prorata is the neutral assumption; G3 showed the verdict
  is invariant across behind/prorata/ahead); per-token `last_trade_price` tape
  (cross-book mint matches may under-print the pairing side → completion is a
  lower bound, which would *help* if corrected); flat 250 ms ack, no rate
  limits, no $1 rebate-payout threshold, no LP rewards; Binance 1m spot lags the
  live WS feed; strike = Binance 1m open vs Polymarket's own oracle.

## What would move the verdict (testable, not yet done)

1. **Forward-validate the guard** in the G2 paper loop — the structural fix
   should show positive locked margin live; that's the real confirmation, on
   independent windows.
2. **Higher completion** is the actual lever now (not margin): faster re-quote,
   pairing-priority quoting, or evidence that on-chain mint fills the pairing
   side more than the per-token tape shows (join eth_getLogs OrderFilled to the
   book — our existing backfill path). If completion rises enough that most
   windows land in paired(≤10), the profitable-paired-bucket result scales.
3. **More days / regimes** before trusting any cap or symbol choice — config (c)
   and (d) numbers are explicitly NOT banked here.

## Files

- `src/lib/strategies/binary-pair-maker.ts` — `costGuard` param + `yesCost`/`noCost` inputs + guard logic (modified)
- `tests/unit/binary-pair-maker.test.ts` — 5 new guard cases (18 total; 45/45 with queue-fill)
- `scripts/pair-maker-backtest.ts` — `--cost-guard`, `--families` filter, summed-locked-margin + neg-margin-window structural readout (modified)
- Per-config results JSON: `/Volumes/My Passport/hft-data/pmxt/extracts/2026-06-10/g3v2-{a-baseline,b-guard,c-guard-cap10,d-guard-cap10-eth}.json`
- Control: `docs/research/G3-QUEUE-FILL-BACKTEST-2026-06-12.md`
