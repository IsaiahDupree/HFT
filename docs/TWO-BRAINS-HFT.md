# Two Brains for the HFT carry — deterministic edge + regime/AI sizing

The carry edges (`docs/EDGES.md`) are *deterministic* — funding/basis math says what the structural
yield is. But trading a carry **flat** ignores its failure mode (basis blowout, squeeze, vol spike).
The "Two Brains" architecture adds a second loop that **sizes** the edge by detected risk:

- **Loop A — the edge (deterministic).** `calendarBasisReturns` / `deltaNeutralCarryReturns` — the
  structural yield, gauntlet-validated. It says *what* to hold.
- **Loop B — the regime layer (the judgment).** Sizes Loop A up in calm regimes and down into rising
  risk. It says *how much*. In production this is an LLM weighing rich microstructure (book
  alignment, oracle gap, squeeze proximity); in backtest it's the **feature-based proxy** of that
  judgment so it can be measured and falsified.

The non-negotiable discipline (the §7.6 test): **Loop B only counts if it beats a fixed size AND a
SHUFFLED regime AND a naive heuristic, out-of-sample.** Anything less and the "AI sizing" is
decoration — any reordering of the same sizes would do as well.

---

## Implementation

### Loop B primitives — `src/lib/backtest/regime-size.ts` (pure, +12 tests, NO-LOOKAHEAD)
| Fn | What |
|---|---|
| `rollingStd` / `rollingMean` / `trailingZ` | trailing risk features; output[i] uses only values ≤ i |
| `volTargetSize(trailingVol, targetVol)` | size ∝ targetVol/vol, clamped — big when calm, small when whippy |
| `regimeGateSize(riskZ, {cutZ, band, floor})` | full size below `cutZ`, ramps to `floor` into danger — the "cut into the dangerous regime" judgment a flat strategy can't make |
| `applySizing(returns, sizes)` | out[i] = size[i]·return[i], with size from features ≤ i |
| `shuffleSizes(sizes, block, rng)` | block-permute the sizes for the falsification null |

**No-lookahead detail:** the size for the return realized over i→i+1 is computed from the trailing
vol/z known *before* bar i (the feature series is lagged one bar). Tested via interior perturbation.

### The integration — `scripts/backtest-carry-regime.ts` (`npm run backtest:carry-regime`)
1. **Loop A:** fetch BTC/ETH spot + front-quarter continuous futures (proxy), build the calendar
   carry per coin (`calendarBasisReturns`, roll-seam-skipped), equal-weight → the fixed-size book.
2. **Loop B:** trailing vol + risk-z of the carry (lagged) → `volTargetSize` and `regimeGateSize`.
3. **Walk-forward:** the only knob — `targetVol` — is set to the in-sample median trailing vol and
   applied unchanged out-of-sample (no OOS fitting).
4. **§7.6 falsification:** the better regime variant's OOS Sharpe is compared to fixed, to 300
   block-shuffled-regime nulls (permutation p-value), and to a naive cut-when-vol-high heuristic.

---

## Result (backtest + walk-forward + falsification)

| Book | full Sharpe | **OOS Sharpe** | OOS maxDD |
|---|---|---|---|
| Loop A (fixed size) | ~3.4 | 3.39 | baseline |
| **+ regime gate (Loop B)** | 2.99 | **3.86** | **−0.5%** |
| + regime vol-target | 3.25 | 3.54 | −0.8% |
| vol-heuristic (naive) | 3.33 | 3.36 | −0.5% |

**§7.6 verdict (best regime = gate, OOS):**
- vs **fixed size**: 3.86 > 3.39 → regime improves Sharpe *and* cuts drawdown.
- vs **shuffled regime**: 300 block-shuffled nulls (mean 3.33) → **p = 0.013** → the *timing* of the
  sizing carries information; it's not just lower average gross. Survives Bonferroni for the 2
  regime variants (~0.026).
- vs **naive vol heuristic**: 3.86 > 3.36 → beats the cheap filter.

**Loop B earns its place.** The regime layer makes the carry meaningfully better risk-adjusted, and
the improvement is real (survives the shuffle), not an artifact of sizing down on average.

Honest scope: the gain is modest (Loop A was already strong) and measured on one BTC/ETH calendar
carry OOS sample — it demonstrates the architecture and clears the falsification, but it's not yet a
multi-edge, multi-regime production result.

---

## Where the AI actually fits

The backtest uses a **feature-based** Loop B (vol/z → size) because an LLM can't be re-run on every
historical bar reproducibly. In production the same Loop B is an **LLM regime classifier** that
weighs features a fixed rule can't combine — e.g. "this instrument is *most dangerous despite the
lowest vol* because the books are sign-conflicting and the oracle gap is widest" (a discriminating
call a vol filter inverts). The discipline is identical: **any AI sizing claim must be §7.6-
falsifiable** — log (regime call, features, outcome) live, and prove the AI-sized book beats the
feature-proxy / fixed / shuffled baselines on the accumulated data before believing it.

---

## Next integrations (each to be backtested + falsified the same way)
- **Per-instrument regime** (size each carry leg by its own risk) instead of portfolio-level — the
  "cut BTC, keep ETH" judgment.
- **Squeeze-risk gate for funding carry** — size down the short-perp leg when OI + funding + realized
  vol all spike (the failure mode that sank the cross-sectional version).
- **Cross-edge allocator** — a regime layer that rotates capital across the confirmed carries
  (funding / calendar / vol-premium / staking) by which regime each is in.
- **Live LLM Loop B** — accumulate (regime, features, outcome) and run the §7.6 falsification on real
  paper data, not asserted.
