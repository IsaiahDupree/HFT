# Steelman pass — two debunked edges through the existing gauntlet (2026-06-12)

An **advocate pass** on the strongest steelman of two already-debunked edges, run through HFT-work's
EXISTING strategy-evaluation machinery (`src/lib/backtest/advisor.ts`, `proof-council.ts`,
`trade-advocate.ts`, `shuffle-control.ts`, `candle/stats.ts`). No new statistics were hand-rolled —
every metric flows through the same functions the discovery scripts already use. Real data only.

Branch: `feat/oracle-snapshot-capture`. Vitest: 190/190 pass on the touched modules.

---

## STEELMAN 1 — full-cycle funding-as-directional-signal → **DEBUNKED**

**Prior verdict (catalog):** "funding-as-directional-signal — DO NOT SIZE: OOS Sharpe 1.41 but
PBO 0.40, sign-flip control fails, single ~1.4yr bear window."

**The steelman:** the debunk tested ONE bear window. Test on a FULL market cycle (bull + bear, multi-year).

### Setup
- Script: `scripts/_steelman-funding-fullcycle.ts` — a faithful clone of
  `scripts/_discover-funding-as-return-signal.ts` (identical `VARIANTS`, `dailyFunding` /
  `fadeFunding` / `priceReturns` / `portfolio` no-lookahead logic, identical gauntlet calls), but
  loading the FULL-CYCLE sample instead of the 2025-only jsonl + the (down) TimescaleDB.
- Gauntlet (existing): `sharpe` → walk-forward OOS (70/30) → `pbo` → `deflatedSharpe` →
  `adviseTrade` (advocate/skeptic) → block-shuffle permutation control → `proofCouncil`.

### Data coverage (explicit)
- Source: the data lake on My Passport.
  - Funding (8h, Binance perp): `/Volumes/My Passport/hft-data/crypto/funding/binance/<COIN>/YYYY-MM.parquet`
  - Daily OHLCV (Binance USDⓂ perp): `/Volumes/My Passport/hft-data/crypto/ohlcv/binance/um/<COIN>/1d/YYYY-MM.parquet`
- Exported to `data/funding-fullcycle/*.binance.jsonl` and `data/candles-fullcycle/*.ONE_DAY.jsonl`
  via a pyarrow bridge (timestamps in unix seconds; funding 28800s-spaced, OHLCV 86400s-spaced — verified).
- **10 coins**: ADA, AVAX, BNB, BTC, DOGE, ETH, LINK, LTC, SOL, XRP.
- **Sample: 1825 portfolio-days, 2020-06-01 → 2025-05-30** — covers years 2020,2021,2022,2023,2024,2025
  = the 2020-21 bull, the 2022 bear, the 2023-24 recovery, and 2025. A REAL multi-regime cycle,
  not a single ~1.4yr bear window. (Lake funding ends 2025-05; that is the honest data limit — it
  still spans 5 calendar years and every major regime.)
- Effective N: 1825 daily portfolio bars × 6 variants; 6 distinct calendar-year regimes.

### Gauntlet verdict (real output)
```
variant         ann.Sharpe  OOS-Sh     cum PnL
long-only@3bp   1.02        0.52 OK    +130%
long-only@5bp   0.95        1.21 OK    +91%
fade@10bp      -0.98       -0.78 X     -82%
fade@1bp       -1.00       -1.24 X     -99%
fade@3bp       -1.03       -1.17 X     -97%
fade@5bp       -1.05       -0.52 X     -90%
EW buy&hold     1.31        1.12       +3733%

best(full): long-only@3bp ann 1.02 · IS-best long-only@3bp walk-fwd OOS 0.52 HELD
PBO 0.00 · DSR 0.21 · 2/6 held OOS · corr(best, EW-BH) 0.46 · regimes(yrs) 6

per-year ann.Sharpe of best variant (long-only@3bp):
  2020: strat  3.18  beta  2.05
  2021: strat  1.71  beta  2.93
  2022: strat  0.30  beta -1.08
  2023: strat  1.62  beta  2.06
  2024: strat -0.13  beta  1.46
  2025: strat  1.13  beta -0.24

CONTROL block-shuffle (1000 perms, block 5): observed Sharpe 0.0534 · p(greater) 0.675
  -> does NOT survive (consistent with noise/structure-free)

ADVISOR — STAND_ASIDE  (conviction 4/100)
  bull: low overfit (PBO 0.00); basket compounds (BH Sharpe 1.31); +130% cum @ Sharpe 1.02
  bear: 59% of return in a few bars (artifact); DSR 0.21 << 0.95; scanned 6 cells, 0 survive correction
  ONE VOICE: "the numbers aren't trustworthy enough to act on; this is a data problem, not a trade."

PROOF COUNCIL: REPAIR_FIRST — only 2/6 variants held OOS (≤ half) — selection looks like noise
```

### Why the single-window result was a regime artifact
The original "edge" is the **fade** (short crowded longs / long crowded shorts). On the full cycle
**every `fade@*` variant is net-negative** (Sharpe −0.98 to −1.05, cum −82% to −99%). Fading funding
only "worked" in the 2025 mean-reverting bear window the debunk happened to sample. The only positive
variant is `long-only@3bp`, which is **levered beta, not alpha**: corr 0.46 to the equal-weight basket,
underperforms buy-and-hold massively (+130% vs +3733%, Sharpe 1.02 < 1.31), and **fails the block-shuffle
control** (p=0.675 — indistinguishable from a structure-free null). DSR 0.21 (needs >0.95). Per-year it
loses to beta in every bull year (2021/2023/2024) and only "wins" 2022/2025 by sitting defensively flat.

**CONCLUSION: DEBUNKED on a full cycle.** The advocate's best-case (full bull+bear sample) makes the
edge *worse*, not better — it exposes the single-window result as a regime artifact + worse-captured beta.
Gauntlet recommendation: **STAND_ASIDE / REPAIR_FIRST. DO NOT SIZE.**

---

## STEELMAN 2 — daily-strike Binance→Polymarket latency lag → **DEBUNKED** (real-but-not-exploitable)

**Prior verdict:** "Binance→PM latency snipe DEBUNKED (lane empty): median lag 0.5s on 5-min series;
0 profitable takers in 3,189 wallets."

**The steelman:** the lag is real on DAILY-strike series (~11s), just not 5-min — daily strikes reprice slowly.

### Setup
- Machinery: `scripts/binance-poly-leadlag.ts` (cross-correlation + impulse event-study) and the
  campaign harness `scripts/leadlag-campaign.ts` → `leadlag-campaign.jsonl`.
- Evaluation: `scripts/_steelman-dailystrike-leadlag.ts` runs the REAL measured evidence through the
  existing `adviseTrade` + `proofCouncil` (penny_lock objective) for the verdict.

### Data coverage (explicit)
- **Evidence A — campaign captures (REAL Binance+PM, `leadlag-campaign.jsonl`, 98 rows / 34 measured):**
  ALL 34 measured markets are sub-daily (max tau **42.8 min**). Cross-correlation median lag **0.50s**
  (the original debunk number), BUT the impulse→reprice **event-study median response is 13.4s** — the
  steelman's "~11s slow reprice" IS visible in the response time. However only **1** ≥20bps impulse event
  was captured across all 34 markets (they are too quiet), and **0** stale-no-reprice. Real-but-thin.
- **Evidence B — LIVE daily-strike book probe (Gamma/CLOB, 2026-06-12):**
  Of **36** daily-strike BTC/ETH "above/below $X on <date>" markets, **0 have a two-sided book**
  (vol24h = 0, empty book, spread = **$1.00**). The most-liquid crypto market on the whole board is the
  HOURLY "BTC Up/Down — June 13, 12AM ET" at **$106 / 24h**. There is no liquid daily-strike Up/Down lane.
- **Live-capture data limit (honest):** a fresh `binance-poly-leadlag.ts` capture returned `binance 0 trades`
  — the data proxy IP (104.253.36.150) is currently geo-blocked by Binance (HTTP 451 on both REST and WS).
  This blocks a *new* live lag measurement, but NOT the verdict: the liquidity probe settles it independently.

### The exploitable-triple math (made explicit)
The lane needs (Binance impulse ≥20bps) × (stale PM quote) × (spread < the staleness edge). Granting the
steelman a real 13.4s staleness on a 50-delta NTM strike, a 20bps move mis-prices it by ~3¢. To TAKE it you
must cross the PM spread. On an empty-book daily strike the spread is $1.00 (100¢):
```
net edge per take = staleness ~3c  −  cross-spread 100c  =  −97c   (negative → not takeable)
```

### Gauntlet verdict (real output)
```
PROOF COUNCIL: REPAIR_FIRST — the penny-lock objective (keep winning + stay net positive) is not met
  - sample only 0 takeable snipes (< 100) — a high win rate is not yet established
  - net ROI -97.0% ≤ 0 — a penny-lock that isn't net positive fails its own objective

ADVISOR — STAND_ASIDE (conviction 0/100)
  ONE VOICE: "the numbers aren't trustworthy enough to act on; this is a data problem, not a trade."
```

**CONCLUSION: DEBUNKED.** The steelman is *half right* — daily/near-expiry strikes DO reprice slowly
(13.4s impulse-response staleness is real). But the lag is **real-but-not-exploitable**: the daily-strike
lane has **no resting two-sided quote (0/36 books) and ~$0 volume**, so the stale quote can't be lifted and
the impulse×stale×spread triple fails at the liquidity leg. The edge is eaten by spread/empty-book before
fees even matter. Gauntlet recommendation: **STAND_ASIDE.** (Caveat: should the proxy unblock, a fresh live
capture on a genuinely liquid daily strike — if one ever appears — would be the cleaner confirmation; today
none exists to capture.)

---

## Discipline notes
- **No in-sample cherry-picking:** STEELMAN 1 reports the WHOLE 6-variant grid + per-year breakdown, not the
  single best window. The IS-best variant is chosen in-sample and tested OOS (walk-forward 70/30).
- **Permutation / shuffle control:** block-shuffle (1000 perms, block 5) run on the best variant — fails (p=0.675).
- **Effective N reported:** S1 = 1825 daily bars × 6 variants × 6 year-regimes; S2 = 34 measured markets (all
  sub-daily) + 36 live daily-strike books probed.
- **Advocate paired with skeptic:** both verdicts come from the same advocate/skeptic council, so the negative
  is not manufactured — the advocate genuinely tried (S1 bull case: PBO 0.00, basket compounds; S2: granted the
  13.4s staleness). The data vetoed it, not the vibe.

## Files
- `scripts/_steelman-funding-fullcycle.ts` — STEELMAN 1 runner (lake → existing gauntlet)
- `scripts/_steelman-dailystrike-leadlag.ts` — STEELMAN 2 runner (real evidence → existing gauntlet)
- `data/funding-fullcycle/*.binance.jsonl`, `data/candles-fullcycle/*.ONE_DAY.jsonl` — lake export (gitignored if large)
- `docs/research/STEELMAN-HFTWORK-2026-06-12.md` — this report
