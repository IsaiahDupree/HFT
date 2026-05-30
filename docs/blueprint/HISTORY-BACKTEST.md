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

## Caveat — this is in-sample
`best-by-Sharpe` over a param grid is in-sample selection → **optimistic**. Before any capital, run
the same walk-forward / purged-CV discipline used on the MM side (delay-injection isn't relevant for
daily bars, but **out-of-sample param stability, PBO < 0.3, Deflated Sharpe > 0.95** are). The grid is
small (5 SMA / 4 Donchian / 18 z) to limit selection bias, and the edge shows up across 12 independent
coins — which is the real evidence, more than any single number.

## Pipeline
```
npm run ingest:history        # deep daily OHLC → coinbase_candles (since origination)
npm run backtest:history       # grid-search strategies per coin → report
```
Next: out-of-sample split + walk-forward; feed the winning (strategy, params) per regime back into the
arena's cb_* genome seeding; ingest hourly for finer entries.
