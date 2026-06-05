# Edges — what's real, what's beta, and how we know

This is the running catalog of trading edges tested in HFT-work, with the **honest verdict** for
each. The thesis of the whole project: a backtest number proves nothing; an *edge* has to survive
a gauntlet designed to kill it. Everything below has been through that gauntlet. As of 2026-06-05,
**one** edge has cleared it — funding carry on persistent-funding alts — and we documented exactly
why, including the caveats that keep it from being a slam-dunk.

---

## The gauntlet (how a candidate becomes an "edge")

Every strategy runs the same ladder. A number that survives all of it is an edge; a number that
dies at any rung is beta, an artifact, or noise.

1. **Lake backtest** — real warehouse candles / real funding, NO-LOOKAHEAD (position[i] uses only
   data ≤ i, realize i→i+1). Tested invariant: perturbing a far-future bar can't change earlier
   returns.
2. **Walk-forward** — pick the variant in-sample (first 70%), measure it out-of-sample (last 30%).
   An edge holds OOS; an overfit one fades.
3. **Overfit battery** — **PBO** (probability of backtest overfit, want < 0.3) + **Deflated-Sharpe**
   (DSR, want > 0.95 — corrects the best-of-N-variants selection).
4. **Shuffle / permutation control** — re-run on time-shuffled data. If shuffling the bar order
   doesn't hurt the Sharpe, the "edge" needed no real temporal structure → it's a static artifact.
   (`src/lib/backtest/shuffle-control.ts`.) Doesn't apply to income strategies (carry is
   order-independent) — there the test is fee/basis realism, not shuffle.
5. **One-voice advisor** — `adviseTrade` synthesizes beta-vs-alpha, the overfit metrics, data
   integrity (universe splice, cross-venue), multiple-testing, and absolute-return honesty into a
   single verdict: **BUY / TRADE_SMALL / PAPER / HOLD_BETA / STAND_ASIDE**. It refuses to call
   "beats a worse benchmark while net-negative" alpha; it says BUY the basket when a strategy is
   just beta.
6. **Execution realism** (for anything that clears 1–5) — re-cost with a **data-measured fee**
   (`maker-fill.ts` calibrates the touch-order fill rate from real L2 → effective fee), and for
   carry, model the **basis risk** the funding-only view omits (`backtest:basis`).

---

## ✅ EDGE #1 — Funding carry on persistent-funding alts

**Status: leans GO** (paper → small live). The only thing tested that clears the full gauntlet at
a realistic, data-measured fee.

### The trade
Perp funding is paid 3×/day; positive funding means longs pay shorts. A **delta-neutral carry**
holds the funding-*receiving* leg of a perp+spot hedge (short the perp + long spot when funding is
positive), so the price legs cancel and you **harvest the funding**, price-neutral. The edge is the
funding income; the risk is the spot-perp basis + execution cost.

### Why it's real (the evidence)
| Test | Result |
|---|---|
| Lake backtest, 28 high-funding alts, 500d | every variant positive; best **+22% APR, Sharpe 8.07** |
| Walk-forward OOS | held (**OOS Sharpe 7.51**) |
| PBO / DSR | **PBO 0.00, DSR 1.00** — not overfit, deflation-clean |
| Advisor | **BUY (92/100)** — genuine OOS alpha, no material objection |
| Basis risk (`backtest:basis`, real spot+perp) | Sharpe 10.8 → **6.7** (~38% haircut) — real but survives |
| Data-measured fee (`carry:maker-fill`, 20% L2 fill rate → 4.22bp/leg) | still **+37% APR, Sharpe 7.7, BUY** |

It survives a 4× higher (realistic) fee because the **persistence-selected names have low turnover**
— you pay the entry fee rarely and collect funding many times. That's the key: pick the right names.

### The deployment path
1. **Universe** — `discover:funding-persistence` ranks coins by sign-stability × magnitude ÷ flips.
   Trade the top (steady, fat, low-turnover): e.g. **LAB** (90% one-sided, 61% APR, 13 flips/yr),
   **BEAT** (78%, 64% APR). Avoid high-flip fee-traps (DASH 252 flips/yr).
2. **Execution** — maker fills matter (the 20% measured rate already costs 4.22bp/leg; alts fill
   worse). Post passively; don't chase.
3. **Risk** — monitor the spot-perp basis (the ~38% Sharpe haircut is real; a basis blowout during a
   squeeze is the tail risk). Watch borrow availability — funding is high *because* shorting is hard.
4. **Sizing** — capacity-limited (illiquid alts). Start small; this is yield-harvesting, not a
   moonshot. Net of every honest haircut it's plausibly a mid-single-to-low-double-digit-APR,
   Sharpe-1-to-3 sleeve — a *real* yield, not a fantasy.

### The caveats (so we don't fool ourselves)
- Funding-only Sharpe is **inflated** (no basis risk); the basis backtester is the honest number.
- The fill rate was calibrated on **liquid dYdX majors** → optimistic for the alts we trade.
- The perp leg needs **Binance-global (proxy) / Hyperliquid / dYdX** — *not* Binance.US (spot-only).

### Tooling
`discover:high-funding` → `fetch:funding:binance` → `discover:funding-persistence` →
`backtest:carry-neutral` → `backtest:basis` → `carry:maker-fill`. All reuse
`deltaNeutralCarryReturns` / `basisCarryReturns` (pure, no-lookahead, tested) + `adviseTrade`.

---

## ✅ EDGE #2 — Calendar (dated-futures) basis carry

**Status: PAPER → deployable.** A second clean *carry* edge, found by the edge-discovery workflow
and independently verified. Arguably **lower-risk than funding carry** — the convergence is locked.

### The trade
Binance quarterly delivery futures trade at a premium to spot (contango). Long spot + short the
dated future (cash-and-carry); at delivery the future **must** converge to spot, so a positive
basis is harvested as the gap collapses. Unlike funding carry there are no funding cash flows and
no open-ended basis risk — held to expiry the payoff is **locked at the entry basis**.

### Evidence (real Binance `continuousKlines` front-quarter vs spot, via the proxy)
| Test | Result |
|---|---|
| Annualized basis | **BTC +8.07% (contango 100% of days), ETH +7.66% (98%)** |
| Best variant (contango>0, 1bp) | Sharpe **3.06**, **+8.5%/yr**, +24.7% over 999d |
| PBO / DSR | **PBO 0.00, DSR 1.00** |
| Carry signature | realized return == observed basis (a *true* carry, not an artifact) |
| Advisor | **PAPER (72)** — clean metrics, downgraded only for the 5-cell scan; modest absolute return |

No-lookahead verified independently: side from the basis at i, realized i→i+1, and the
contract-**roll seams are skipped** so the stitch jump can't leak into returns. Core math extracted
to the tested `calendarBasisReturns` (pure, +5 tests). Run: `npm run backtest:calendar-basis`.

### Caveats
- ~8%/yr is modest; the daily MTM is volatile (the Sharpe reflects basis fluctuation, not the
  locked terminal payoff). Roll/execution costs + margin on the short-future leg eat into it.
- Liquid on BTC/ETH (deep quarterly futures) — good capacity, unlike the illiquid funding-carry alts.

---

## Adjacent variants (real but marginal)

- **Cross-venue funding arb** (Binance − Hyperliquid, `backtest:funding-xvenue`): the venue funding
  *spread* is small (~2.5 bps/day, mostly arbed away) → only **~3% APR at maker fees**, negative at
  3bp → **PAPER**. Lower-risk than single-venue (perp-perp basis is tight) but lower-return.
- **Funding-as-directional-signal** (fade crowded funding, `scripts/_discover-funding-as-return-signal.ts`):
  Sharpe 1.41, OOS held, *not* pure inverse-beta (residual 0.89), block-shuffle control survives
  (p=0.023) — **but** PBO 0.40, DSR 0.81, the sign-flip control fails (p=0.115), and the whole window
  is a single ~1.4-yr alt bear market → **PAPER, do not size**. A genuinely-not-just-beta timing
  signal that fails the overfit gauntlet on too-short a sample.

---

## ❌ Tested and rejected (beta / artifact / noise)

| Surface | Verdict | Why |
|---|---|---|
| Relative-strength / momentum rotation | **HOLD_BETA** | underperforms equal-weight buy-and-hold; shuffle control p=1.000 (no time-series edge) |
| Cross-sectional long/short (xsection) | **STAND_ASIDE** | doesn't beat the basket; PBO clean but no alpha |
| Pairs / stat-arb | **HOLD_BETA** | BH +16068% vs pairs −58% — crypto is momentum, not pairs-MR |
| Regime-conditional "defensive" cells | **rejected** | 66 "edges" → 0 survive Bonferroni; permutation null beats the real pattern; was a warehouse-splice artifact |
| Funding carry on *majors* | **STAND_ASIDE** | fee-dominated — funding too small vs fees |
| dYdX market-making (inventory MM) | **REPAIR_FIRST** | fills too rarely on deep books (11 maker fills / 4595s) to capture spread |
| Cross-sectional funding factor (L low / S high) | **STAND_ASIDE** | gross sign right but fee-dominated (~2×/day turnover); PBO 0.86, shuffle p=0.24 |
| Funding settlement seasonality (time-of-day) | **falsified** | the 3 slots are identical (3.60–3.66%/yr, 0.16 bp spread) — no clock-hour edge |
| Realized-vol mean-reversion (daily) | **falsified** | vol *persists* — a top-decile spike predicts ~2.45× **higher** next-day vol |
| Open-interest × funding squeeze | **rejected** | shuffle p=0.92 (a random reorder out-Sharpes the real timing) — annualization mirage on 31 days |
| Aggregate-funding market timing (breadth) | **STAND_ASIDE** | net-negative OOS — de-grossing a −68% bear basket is defensive beta-reduction, not alpha |

### The edge-discovery workflow (2026-06-05)
A 7-family fan-out, each agent building a real no-lookahead backtest through the gauntlet + advisor.
**Result: 5 cleanly rejected, 2 PAPER (calendar basis = the keeper), 0 BUY.** The meta-finding the
whole project keeps confirming: **CARRY / income edges are real** (funding carry, calendar basis);
**TIMING / directional edges are beta or noise** (every directional family above failed a control or
the overfit gate). Reproducible negatives kept at `scripts/_discover-*.ts`.

**The lesson encoded:** big ROI ≠ edge. A +12,614% backtest was bull-market beta that *underperformed*
buy-and-hold. A "regime edge" found by scanning is a hypothesis count, not a result. The advisor
exists to say this in one voice every time.

---

## Methodology notes worth remembering

- **Beta benchmark is mandatory.** "It made 126×" means nothing until you compare to holding the
  basket (which made 227×).
- **Correct for multiple testing.** Scanning N cells, ~5% clear p<0.05 by chance; use Bonferroni /
  a permutation null.
- **Verify the data.** A warehouse splice (66 USDT coins dying 2024-12-31) silently inflated results
  until `universeHealth` caught it. Cross-venue agreement (Coinbase↔Kraken 1.6 bps) validates feeds.
- **Re-cost with reality.** Maker-vs-taker fees and basis risk turn many "edges" negative. Measure
  the fee from L2; model the basis from both legs.
- **Income ≠ timing.** Carry is order-independent (shuffle doesn't apply); momentum is a timing edge
  (shuffle is the right test). Use the right control for the right edge.
