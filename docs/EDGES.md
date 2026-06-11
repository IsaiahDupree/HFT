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

## ✅ EDGE #3 — Vol risk premium (sell vol)

**Status: PAPER (real but tail-risky).** Found by the carry-discovery workflow; the most
academically-robust premium in all of finance, confirmed on crypto.

### The trade
Implied volatility systematically exceeds subsequent realized volatility — option *sellers* are
paid for bearing variance risk. Sell vol (straddles / variance) and harvest the gap.

### Evidence (Deribit DVOL implied vs Binance realized, real data via public API)
- **VRP = implied − realized(30d) = +8.87 vol points, positive 73% of 1867 days** (2021–2026).
- Honest **non-overlapping Sharpe ≈ 1.23** (36 independent 30-day blocks, won 24/36). PBO 0.17, DSR 1.00.
- The overlapping-window Sharpe (9.26) is inflated and was correctly discarded.

### Caveat (the one that matters)
Short vol has a **fat left tail / negative skew** — you collect small premiums and occasionally
lose big in a vol spike. Sharpe **does not** capture this; the honest 1.23 *overstates* the
risk-adjusted appeal. This is "pennies in front of a steamroller": real positive expectancy, real
blow-up risk. Size for the tail, not the Sharpe. (Script: `scripts/_carry-deribit-vol-risk-premium.ts`.)

---

## Adjacent variants (real but marginal)

- **Staking-hedged yield carry** (`scripts/_carry-staking-hedged-yield.ts`): stake ETH/SOL (~3.2%/7%
  APY) + short the perp to hedge price → delta-neutral staking yield, *plus* the short collects
  funding. **~5–6% net APR, beats plain funding carry, fee-robust** (survives 150 bps/yr drag) →
  **PAPER**. Real structural carry, but the headline Sharpe (~14) is inflated — it models staking as
  riskless and omits the real risks: **ETH unbond-queue illiquidity** (you can't unwind the hedge
  against a leg you can't exit for days/weeks), slashing, LST depeg, tracking error.

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
| **Cross-sectional funding "carry"** (short top / long bottom funding) | **REJECTED on honest accounting** | funding-only model = BUY (Sharpe 8.9), but the **price-aware** version (real long/short basket P&L) is **−65%, STAND_ASIDE** — the baskets don't cancel; shorting pumped high-funding alts loses more on price than the funding pays |
| Calendar *spread* / term structure (front vs back quarter) | **STAND_ASIDE** | term premium tiny (~0.3%/yr) and non-convergent — pure noise; the outright basis (edge #2) is strictly better |
| Inter-exchange funding (Binance vs OKX) | **STAND_ASIDE** | spread even smaller (1.4 bp/day) → ~0.6% APR, uneconomic; OKX API caps at 95 days |
| Basis roll-down timing | **redundant** | the underlying carry is just edge #2; the "enter in the fat band" timing is falsified (full-life is best) |
| **Negative-funding carry via DeFi borrow** (long perp + short spot, borrow on Aave) | **STRUCTURALLY CLOSED** | the fat-negative names (COMP −20% durable/100% persist, alts, memes) are **not borrowable** on Aave V3 (COMP isn't even a reserve; UNI/AAVE/CRV/SNX collateral-only). The 19 borrowable reserves are all BTC/ETH variants + LINK + stables — **all ~0% durable funding**. Borrowable ∩ fat-negative ∩ persistent = **∅**. Borrowability and funding-richness price the same risk *inversely* — unbreakable with Aave. Probe: `scripts/_aave-borrow-probe.ts` |

### Execution reality — venue + the durable-rate rule (2026-06-05)
Taking the carry to a live executor surfaced truths the backtest can't:
- **Gate carry on the DURABLE (median) funding, never the mean.** A memecoin sits at the venue funding *floor* most hours and spikes rarely; the mean is spike-inflated and uncollectable (AZTEC mean +26% vs median +11%; LAB durable 5% vs *recent* 757%). `src/lib/exec/funding-stats.ts` (+6 tests). This is the magnitude-level sibling of the persistence (sign) and tight-hedge (basket) traps.
- **0 funding carries executable on Hyperliquid** (the KYC-free both-legs venue). HL spot has no borrow → only positive-funding carries are clean, and those are pinned at HL's +11% hourly **funding floor → +8% net**, under the bar. Fat negatives need borrow (see above). A **basis guard** is mandatory: a ticker match ≠ an asset match (perp TRUMP $1.60 vs "TRUMP" spot token $0.0003 = 53M bp). Recon: `npm run carry:hl`.
- **No better cross-venue carry**: dYdX × Coinbase/Binance.US reproduces the same wall — the only name clearing 15% net (COMP) is negative-funding/needs-borrow. The binding constraint (no KYC-free short-spot-borrow on fat-funding names) is **venue-agnostic**.
- **Net**: the deployable real edge today is **edge #2 (calendar basis, ~8%/yr, convergence-locked)** — but it needs a dated-futures venue (Binance/Deribit), which HL lacks. Funding carry stays paper until a name clears *durable* funding > ~+16% APR with a real, deep, same-asset spot hedge.

### The edge-discovery workflows (2026-06-05)
Two fan-outs, 13 families total, each agent building a real no-lookahead backtest through the
gauntlet + advisor. Round 1 (7 directional/mixed): **5 rejected, calendar basis kept.** Round 2
(6 carry/structural): **vol-risk-premium + staking-hedged kept, xsection-funding-carry rejected on
verification, 3 rejected.** Reproducible scripts at `scripts/_discover-*.ts` + `scripts/_carry-*.ts`.

**The meta-finding, sharpened — carry is real *only when the hedge is tight*:**
- ✅ single-name funding carry (perp vs its *own* spot — tight), calendar basis (future→spot
  convergence *locked* at expiry — tight), staking-hedged (per-coin hedge — tight), vol premium
  (structural, no basket).
- ❌ cross-sectional funding "carry" (hedged by a *basket of different coins* — loose) looks like a
  +Sharpe-8.9 carry on funding-only, but the basket doesn't cancel and the honest price-aware
  version is **−65%**. A loose-basket "carry" is a directional bet in disguise.
- ❌ every pure **timing / directional** family (momentum, xsection price-factor, vol-reversion,
  OI-squeeze, funding-time-of-day, breadth-timing) — beta or noise, killed by a control or the
  overfit gate.

### Intraday / "massive rewards in a day" (2026-06-05) — all rejected, and *why* matters

A 5-family fan-out on real minute data (14–30 days, paginated via the proxy), net of realistic taker
costs (10–24 bps round-trip) + the shuffle control. **0/5 survive — but not because the signals are
fake.** Several are genuinely real *gross*:

| Intraday edge | Gross signal | Net verdict |
|---|---|---|
| Liquidation-cascade reversal | ~+10 bps at 15–30m (win 58%) | **NO** — < cost; random-entry control p=0.50 (filter selects nothing) |
| Minute-scale pairs stat-arb | **~+4 bps/trade, gross Sharpe ~4.5** (real reconvergence — *unlike* daily momentum) | **NO** — < 24 bps two-leg cost |
| Cross-exchange basis reversion | +3–8 bps convergence (real) | **NO** — lives entirely inside the 24 bps two-leg cost; 0% net win rate |
| Momentum-ignition breakout | ~+2 bps (real continuation) | **NO** — 16–25 trades/day × 14 bps = fee-illusion |
| Intraday vol-spike reversion | ~0 bps gross | **NO** — falsified, direction is noise |

**The decisive lesson — the mirror image of carry.** The gross intraday inefficiencies are *real but
tiny* (2–10 bps), and they're **smaller than what it costs to trade them** (12–24 bps round-trip at
retail taker fees). The firms that *can* harvest them — colocation, maker rebates, exchange membership,
near-zero fees — have already arbitraged the gross edge down to roughly the cost line. So **carry pays
because you're paid a structural yield; intraday speculation loses because you pay the spread** — and
"massive rewards in a day" lives on the wrong side of the cost line, reachable only from inside the
matching engine. This is *why* the durable edge is carry, stated as a measured result, not a prior.
(Reproducible negatives: `scripts/_intraday-*.ts`.)

**The lesson encoded:** big ROI ≠ edge. A +12,614% backtest was bull-market beta that *underperformed*
buy-and-hold. A "regime edge" found by scanning is a hypothesis count, not a result. The advisor
exists to say this in one voice every time.

---

## ✅/❌ HL same-venue funding: the HOLD is a sleeve, the ROTATION is a cost-line loss (2026-06-10)

Top pick from the open-source repo-mining workflow (HL-Delta, cgaspart): same-venue Hyperliquid 1:1 spot+perp
delta-neutral funding capture — the **tightest-hedge** member of the proven funding-carry family (zero
transfer/settlement/basis risk, the exact risk that capped cross-venue funding at ~3%). Built no-lookahead
(`src/lib/backtest/candle/hl-delta.ts`, +8 tests, lookahead-certified through `detectLookahead`) and ran the
gauntlet on **real HL fundingHistory** (BTC/ETH/HYPE/SOL, 300d, `npm run backtest:hl-delta`).

| Component | Result |
|---|---|
| **HOLD the durable-funding leader** | **HYPE +10.7% APR, BTC +5.8%, ETH +6.0%** (steady positive funding) — ✅ a real sleeve |
| Cost-aware ROTATION overlay (gate 5% / hyst 10% / 30bps) | gross +12.4% but **NET −80.3%**, 254 rotations — ❌ churns to death |
| Hysteresis ablation | naive switch −182.9% (536 rot) vs guarded −80.3% (254 rot) — the cost guard helps but can't save it |
| Overfit / walk-forward (on the rotation) | PBO 0.00 / **DSR 0.00**, OOS Sharpe −2.28 — ❌ |

**Verdict: the HOLD is the edge (funding-carry #1 on a tight same-venue hedge, ~6–11% APR); the ROTATION fails
1/5.** The rotation barely lifts gross funding (+12.4% vs +10.7% holding HYPE) because the funding *ranking* is
stable, so switching just pays 254×30bps ≈ 93%/yr in fees to capture the same premium. This is the meta-thesis
**one more time**: the structural HOLD survives, the TIMING/rotation overlay loses to the cost line. Deploy
hold-the-durable-leader (HYPE/BTC), size net of the basis haircut + HL spot depth, NOT the rotation. Executability
gate: needs HL **spot** for the held coin (same-venue hedge); funding is high *because* shorting is hard.

---

## ❌ Stablecoin peg mean-reversion — rejected as a *continuous* edge; it's a rare-EVENT trade (2026-06-10)

The hypothesis was sharp: crypto is momentum (pairs-MR dies), but stablecoins are the structural exception —
pinned to $1 by redemption/arb, so peg deviations should revert (a locked anchor like calendar-basis convergence).
Built no-lookahead (`src/lib/exec/stable-mr.ts`, +8 tests) and ran the full gauntlet on **real Binance hourly
klines** for USDC/TUSD/FDUSD vs USDT, ~540d (`npm run backtest:stable-mr`).

| Test | Result |
|---|---|
| Best variant (entry 20bp / 168h) | APR **+1.1%**, Sharpe **0.44** — tiny |
| Overfit battery | **PBO 0.34** (want <0.30), **DSR 0.33** (want >0.95) — ❌ overfit |
| Block-shuffle control (200 perms, 24h blocks) | real Sharpe 0.44 vs **shuffled null mean 2.70, p=1.000** — ❌ shuffling the bar order does BETTER ⇒ zero real reversion structure |
| Cost realism | positive at 1–2 bps, **negative at ≥5 bps/side** — ❌ fee-dominated |
| Beta (hold the stable) | −0.05% APR (≈0) — confirms it's ~pure-alpha, but there's no alpha |

**Verdict: FAILS (1/4) — not a continuous edge.** The decisive *why*: the 540d window (Dec-2024→now) contains
**no actual depeg** (the SVB USDC crisis was Mar-2023, outside it). With no real dislocation to revert, the residual
deviations are sub-10bp bid-ask micro-noise — and like the intraday families, the gross move is **smaller than the
fee to trade it**. The shuffle's p=1.000 is the clean tell: there is nothing temporal to exploit in calm regimes.

**The sharpened map:** stablecoin MR is a **rare-EVENT trade** (buy a *real* depeg — USDC at 0.88 in the SVB
event reverted to 1.00), not a yield you harvest continuously. And the event is doubly cursed: the depegs big
enough to clear fees are exactly the moments where the **terminal-collapse tail** (UST→0, the depeg that never
recovers) is live. So even the event version is "catch a falling knife that *usually* bounces" — sized for the
tail, not the Sharpe. Reproducible: `scripts/backtest-stable-mr.ts`. (A proper event test needs 2023 data; DAIUSDT
delisted and USDPUSDT failed to fetch, so only the calm-regime — and clearly-negative — result is established.)

---

## The Polymarket program — prediction-market lanes (2026-06-10 → 11)

A parallel edge program on Polymarket crypto binaries, run with the same gauntlet discipline.
Trigger: the viral "$1M bot" article (audited honestly in `docs/POLYMARKET-STACK-AUDIT.md`).
Two wallet sweeps (148 wallets profiled), lag-aware copy backtests, a 24/7 paper-maker forward
track, and an hourly lag-measurement cron produced the verdicts below. The 5-MIN Up/Down series
(7 assets, a market every 5 minutes) relaunched ~2026-06-10 and is the central venue.

### ✅ (strongest) Merge-maker + rebates — "be coinman2, don't copy him"
**Status: PAPER, forward-accruing (TradingBot2 Lane A) — the lane with the most independent
confirmation.** Buy BOTH Yes and No below a combined $1.00, merge complete sets back to $1 USDC,
collect maker rebates; inventory risk nets out at the pair level.
- **Existence proofs (on-chain, verified):** coinman2 **+$1.09M/558d** (maker/merge fingerprint,
  ~1.4% of volume); 0x6db568e6 **+$1.58M, 7.2% margin** (merge-maker hybrid, 54d); Bonereaper
  **+$999k/77d, 0.69% margin, maxDD only −$8.7k**.
- **Calibration fingerprint of the profitable cohort** (round-2 sweep): $1–14 median fills, quote
  the FULL 0.02→0.99 lifecycle, ~3s requote; the −$1.29M dead maker ran 4× clips at 13s requote.
- **Our forward paper** (TradingBot2 `merge_maker.py`): first 4 finalized windows 73.7% pair
  completion, income decomposition **maker-driven** (+$24.10 maker vs +$3.50 residual) — tiny n,
  let it accrue. Independent prior: evan-kolberg's forward-validated `passive_pair_accumulation`.
- **Falsifier to watch:** pair-completion rate collapsing (unpaired inventory = naked directional).

### 🟡 Binary fair-value naked maker (G2 forward track) — honest readout: LOSING so far
**Status: PAPER, currently NEGATIVE — do not promote.** Single-token two-sided quoting off a CEX
fair value (`maker:paper:daemon`, 24/7 across the 5-min/15-min/hourly series).
- **First ~18h clean data (183 sessions, 1,650 fills):** **−$2,066 paper** (and fills are
  OPTIMISTIC front-of-queue), rebates only $118. Naked inventory rides directional moves into
  resolution — adverse selection dwarfs spread+rebates.
- **Model A/B/market: MARKET MID beats baseline beats enhanced** — and the ranking SURVIVED the
  methodology audit (RAILS-REVIEW found the naive pooled scoring circular near expiry and
  tick-pool-skewed toward hourly sessions; after excluding the final 120s and weighting per
  session: **mid 0.1186 < baseline 0.1198 < enhanced 0.1247** over 129 sessions / 9,891 ticks).
  The fair value carries NO information beyond the book. A maker quoting off a worse fair than
  the mid is *supplying* edge. This is the formal demotion of the naked-FV thesis, delivered by
  its own pre-registered benchmark. Review also showed the −$2,066 is itself OPTIMISTIC (fill
  sim has maker-favorable lookahead; a failed final book fetch used to mark at 0.5) — the true
  naked-maker PnL is worse. Full findings: `docs/research/RAILS-REVIEW-2026-06-11.md` (17
  findings; the cap-and-ride mechanism is the minEdge gate killing the inventory-REDUCING quote).
- **Verdict (2026-06-11): the lane's edge is in PAIRED quoting (merge lane), not a better fair
  value.** Consistent with every profitable wallet examined (all pair/merge; none holds naked
  inventory). G2 keeps running as infrastructure + a data feed for G3, but promotion of naked
  quoting is dead unless a future fair value *beats the mid's Brier* — that bar is now explicit
  in `maker:paper:report`.

### ❌ Taker latency-snipe on 5-min binaries — lane empty, claim dead
The article's "2.7s lag" is gone in June 2026: across **39 cron measurements** (BTC+ETH, all
three series), median Binance→Polymarket xcorr lag is **0.5s**; in the only ≥20bps impulse event
captured so far the book repriced in 13.4s with **zero** stale-quote no-reprices ≥30s. Wallet
forensics agree: **0 profitable takers among 3,189 wallets** touching 5-min binaries (33k fills).
Two brand-new public 5-min bots appeared within 48h of the series relaunch — competition is
arriving, not leaving. The G1 cron keeps counting; promotion would need a daily recurring
(impulse × stale × spread>fees) triple that simply hasn't appeared.

### 🟡 LP rewards lane (Polymarket liquidity rewards)
**Status: PAPER (TradingBot2).** Honest Jun 5–10 ledger after the inventory-accounting fix:
reward **+$630** + inventory **+$119** = **+$749 ≈ $134/day on $200 paper stake** — but
170/191 pools were zero-fill and the inventory term carries ±$400 heavy-tail variance. Real
income, concentration risk; judge after weeks, size for the tail.

### 🟡 Copy-trading — one survivor out of 148 wallets
The two-gate machinery (copyable mechanics AND verified realized edge) plus lag-aware
backtests (1-min CLOB history, +1¢ spread cost, no lookahead) demoted nearly everything:
- ✅ **0x418d51e1: COPYABLE at ≤300s** — copy +13.5% vs leader +14.8% (n=103, retains 91%);
  alpha is *side selection*, not timing — which is exactly why it survives delay. Forward
  shadow (2 weeks) before any sizing; `observe:wallet` needs latency/spread/clip recording first.
- 🟡 alwaysfade: +10.1% @60s but only on ≥$1k clips and n=19 — shadow only.
- ❌ ethanaz (+$2.46M leader): copy **−2.6%** @60s on the same 944 bets — his post-fill drift IS
  the alpha; the copier pays it. The pre-registered falsifier fired; demoted.
- ❌ Naive copy-trading at large: forward-falsified twice (21-daemon walk + these backtests).

### ❌ Near-cert 95–99¢ grinding — debunked as structural
Long-span lane grinders are net LOSERS (richerZ −$94k/514d; the only profitable pure grinder is
32 days old). The lane's wins are selection-driven, not structural — do NOT scale it on
structure alone. (Flagged for reconciliation against TradingBot2's PARTIAL near-cert verdict.)

### Evidence trail
`docs/POLYMARKET-STACK-AUDIT.md` (audit + gates + measurements log) · `docs/wallets/SWEEP-2026-06-10.md`
+ `SWEEP-2026-06-11-ROUND2.md` (148 wallets) · `docs/wallets/COPY-BACKTEST-2026-06-11.md` ·
`docs/research/EVAN-KOLBERG-BACKTESTER-ASSESS.md` (G3 data: PMXT free L2 archive) ·
`maker:paper:report` (live A/B) · `leadlag-campaign.jsonl` (passport).

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
- **Model the hedge, not just the income.** A carry's funding-only view omits the price risk of its
  hedge legs and inflates the Sharpe. Always build the *price-aware* version. If the hedge is tight
  (perp-vs-own-spot, dated-future convergence) it survives; if it's a loose basket of different names
  it can flip negative (the cross-sectional funding "carry" went +8.9 Sharpe → −65% when priced
  honestly). `backtest:xsection-carry` is the cautionary keeper.
