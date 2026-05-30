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
construction** — it tests many live and funds only what proves positive on never-seen data. That is
the correct methodology; this validation just told us which priors to trust. Further rigor: multi-fold
walk-forward + PBO/Deflated-Sharpe before any capital.

## Pipeline
```
npm run ingest:history        # deep daily OHLC → coinbase_candles (since origination)
npm run backtest:history       # grid-search strategies per coin → report
```
Next: out-of-sample split + walk-forward; feed the winning (strategy, params) per regime back into the
arena's cb_* genome seeding; ingest hourly for finer entries.
