# Deep-history backtest — daily crypto strategies since origination

`npm run ingest:history` pulls daily OHLC for 12 major coins since their Coinbase origination
(BTC 2015-07 · ETH 2016-05 · LTC 2016-08 · BCH 2017-12 · LINK/XRP 2019 · SOL/DOGE/DOT/AVAX/ADA/MATIC
2021) into `coinbase_candles` (granularity `ONE_DAY`, idempotent). `npm run backtest:history`
grid-searches SMA-trend / Donchian-breakout / z-mean-reversion per coin and reports the best by
annualized Sharpe vs buy-and-hold, after 10 bps/turnover fees. Long-flat, no shorting.

## Headline finding (real, after fees, full history)
**Trend-following beats buy-and-hold on a risk-adjusted basis across most major coins — with lower
drawdowns.** Best-by-Sharpe winner by coin: **SMA-trend ×5, Donchian ×4, z-mean-rev ×3**.

| coin | yrs | buy&hold | best strategy | vs buy&hold |
|------|-----|----------|---------------|-------------|
| BTC  | 10.9 | +26,211% (Sh 1.10, dd 84%) | **SMA-50 +64,947% (Sh 1.47, dd 59%)** | higher return, **far lower dd** |
| ETH  | 10.0 | +15,205% (Sh 1.00, dd 94%) | **SMA-20 +113,713% (Sh 1.36, dd 59%)** | higher return, lower dd |
| SOL  | 5.0  | +110% (Sh 0.65) | **Donchian-20 +2,380% (Sh 1.29)** | dominates |
| LTC  | 9.8  | +1,344% (Sh 0.76) | SMA-20 +4,165% (Sh 0.84) | beats |
| AVAX | 4.7  | -87% (Sh 0.03) | **Donchian-10 +518% (Sh 0.92)** | turns a loser positive |
| ADA  | 5.2  | -81% | z-mean-rev +178% (Sh 0.60) | mean-rev rescues a downtrender |
| XRP  | 7.3  | +323% (Sh 0.71) | SMA-20 +878% (Sh 0.81) | beats |
| DOT  | 5.0  | -95% (Sh -0.25) | (all weak; best z Sh 0.21) | nothing works well |

(Full table: run `npm run backtest:history`.)

## How to read this
- **The momentum/trend edge is real and persistent** in crypto — riding uptrends and stepping aside
  in downtrends both raises return and cuts the brutal 80–95% buy-and-hold drawdowns.
- **Mean-reversion** is the right tool only on chronic downtrenders (ADA, DOT) — consistent with the
  arena's live "regime = chop → mean-reversion" logic.
- This directly justifies the arena's `cb_breakout` / `cb_momentum_burst` / `cb_mean_reversion`
  genome families — they encode exactly these edges.

## ⚠️ Out-of-sample VERDICT — the headline was mostly overfit
`npm run validate:history` does the honest test: pick the best params on the in-sample **first 70%**
of each coin, then score those SAME params on the held-out **last 30%**. Result (10 bps/turn):

| coin | IS-picked | IS Sharpe | **OOS Sharpe** | OOS PnL | verdict |
|------|-----------|-----------|----------------|---------|---------|
| **BTC** | SMA-50 | 1.59 | **1.17** | +204% | **HELD ✓ (beats b&h)** |
| **ADA** | z-rev    | 0.54 | **0.73** | +66% (b&h −42%) | **HELD ✓** (mean-rev on a downtrender) |
| MATIC | Donchian | 0.76 | 0.18 | −6% (b&h −72%) | HELD ✓ (capital protection) |
| ETH | SMA-20 | 1.66 | 0.32 | +15% | held (under b&h) |
| BCH | SMA-20 | 0.88 | 0.20 | −15% | held (under b&h) |
| AVAX, SOL, LTC, XRP, DOGE, DOT, LINK | — | 1.0–1.7 | **negative** | — | **FADED ✗** |

**OOS Sharpe stayed positive on only 5/12 coins; beat buy-&-hold OOS on 5/12.** The IS-best params on
AVAX/SOL/LTC/XRP (IS Sharpe 1.2–1.7) **collapsed to negative out-of-sample** — classic grid overfit.

### What actually survives
- **BTC trend-following (SMA-50)** is a *real, robust* edge — held strongly OOS.
- **Mean-reversion on chronic downtrenders (ADA)** is real — matches the arena's "regime=chop → mean-rev".
- "Trend-following always wins" does **NOT** generalize — most coins' IS winners were noise.

### The right conclusion
Do **NOT** wire IS-best params into live seeding — they overfit. The deep-history backtest gives
*priors* (which coin × strategy-TYPE has a genuine edge: BTC trend, ADA-style mean-rev), not
deploy-ready params. And the **arena's continuous evolve+allocate loop IS out-of-sample by
construction** — it tests many live and funds only what proves positive on never-seen data.

## 🔬 Full overfit battery — `npm run harden-priors`
The strict gate (handbook §11): a prior is **HARDENED** only if **PBO < 0.3** (Probability of Backtest
Overfit — combinatorial CV) **AND DSR > 0.95** (Deflated Sharpe — multiple-testing + non-normality
corrected) **AND median multi-fold-WF OOS Sharpe > 0**. Per-period (daily) Sharpes, 10 bps/turn:

| coin | IS-best | PBO | DSR | medOOS | folds (OOS Sh) | verdict |
|------|---------|-----|-----|--------|----------------|---------|
| **BTC** | SMA-50 | **0.00** | **0.94** | +0.059 | 0.1/0.0/0.1/0.1 | borderline (DSR just shy of 0.95) |
| SOL | Donchian-20 | 0.07 | 0.79 | +0.007 | 0.2/0.0/-0.0/-0.1 | partial |
| ETH | SMA-20 | 0.00 | 0.68 | +0.021 | 0.1/-0.0/0.0/0.0 | partial |
| ADA | z-rev | 0.53 | 0.73 | +0.031 | … | partial (PBO too high) |
| DOT/XRP/LINK/MATIC/DOGE/LTC | — | 0.4–0.81 | — | negative | … | **REJECT** |

**HARDENED: 0/12 under the strict triple-gate.** BTC is the single strongest (PBO 0.00 = its IS-best is
*never* below median OOS; DSR 0.94; **all 4 walk-forward folds OOS-positive**) but doesn't quite clear
DSR > 0.95. The honest read: crypto daily-momentum is a *real but modest* edge — strongest on BTC,
nowhere near the slam-dunk the in-sample numbers implied. Don't bet the account on it.

**Implication for the arena:** keep `cb_breakout`/`cb_momentum` genomes (BTC-trend prior is the most
defensible), but rely on the **live evolve+allocate loop as the final OOS judge** — it's already doing
exactly the right thing (funding the survivors, culling the losers).

## 🔬 Hourly bars + inverse-vol sizing — hypothesis FALSIFIED
The next experiment asked: do **finer entries (hourly bars) + a risk-sizing overlay** lift BTC over the
DSR > 0.95 bar? We ingested hourly OHLC since origination (**BTC 95,158 · ETH 87,749 · SOL 43,387** bars,
`--granularity ONE_HOUR`), built an **inverse-vol position-sizing overlay** (`sizing.ts`, chosen by a
3-design judge panel; no-lookahead proven by a perturbation test — a future close never changes an earlier
size), scaled the trend windows ×24 so the *same* slow-trend edge is tested at hourly resolution, and —
critically — **registered every sized config as an extra trial** in the Deflated-Sharpe pool so SR0 is
deflated honestly (`npm run harden:priors -- --granularity ONE_HOUR --sized`):

| coin | best | PBO | **DSR** | medOOS | folds (OOS) | turn× | verdict |
|------|------|-----|---------|--------|-------------|-------|---------|
| **BTC** | sma50d**+vt** | 0.00 | **0.60** | +0.007 | 0.01/−0.00/0.01/0.00 | **0.80** | partial |
| ETH | sma20d+vt | 0.00 | 0.19 | +0.006 | 0.02/0.00/0.01/0.00 | 0.54 | partial |
| SOL | don20d | 0.10 | 0.46 | +0.008 | 0.03/0.02/0.00/−0.01 | 1.00 | partial |

**The sizing overlay did its job — and the prior still did NOT harden. DSR FELL 0.94 → 0.60.** The honest
read: (1) the overlay **reduced turnover** (BTC `turn× 0.80`, ETH `0.54` — *fewer* fees, not more) and kept
all walk-forward folds OOS-non-negative, exactly as designed; (2) but the per-*hour* trend edge is
structurally tiny, and **doubling the trial pool (raw + sized) raises SR0**, so the Deflated Sharpe drops.
Finer bars added noise and trials, not signal. **The DAILY BTC trend prior (DSR 0.94) remains the single
most defensible representation of the edge** — hourly entries don't strengthen it, and sizing can't
manufacture statistical significance the hourly signal doesn't carry. This is a *negative result worth
having*: it falsifies "trade it faster" and re-centers everything on the **live arena loop as the final
OOS judge**. (Pass-1 deliberately froze posMax=1.0 / conviction OFF to isolate variance-reduction; per-asset
vol targets or conviction sizing would only add trials to deflate against, not change this conclusion.)

## Pipeline
```
npm run ingest:history        # deep daily OHLC → coinbase_candles (since origination)
npm run backtest:history       # grid-search strategies per coin → report
```
Next: out-of-sample split + walk-forward; feed the winning (strategy, params) per regime back into the
arena's cb_* genome seeding; ingest hourly for finer entries.
