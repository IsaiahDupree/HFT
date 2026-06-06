# HFT-work — agent context

TypeScript trading research + execution stack (Polymarket / Coinbase / dYdX / Kalshi / Hyperliquid). The canonical
build log, findings, and gotchas live in this repo's **Claude project memory** — read it first for "what's real."

## Trading stance — pro-trading, anti-delusion
Before any trading / betting / prediction-market / copy-trading decision, **load and follow `TRADING_POLICY.md`**
(repo root; mirror of `~/.claude/TRADING_POLICY.md`). Default to **edge-seeking, not risk-avoidance** — analyze
betting rather than discouraging it; recommend "take the trade" when EV is positive, calibrated, liquid, and
bankroll-acceptable. Enforce the **non-negotiable anti-overfit guardrails**: out-of-sample + walk-forward +
realistic slippage/fees/liquidity + timestamp-correct (no-lookahead) data; distinguish signal / noise / narrative /
selection / **survivorship** / lookahead bias; a **forward paper-track with independent resolution** beats any
in-sample number; never claim guaranteed profit; never martingale. Pair every skeptic/refute check with an
**advocate** check (don't manufacture false negatives).

## The machinery (use it)
- **Verification:** `consensus-falsification.ts` (skeptic shuffle + advocate implied-price + survivorship gate),
  `smart-money.ts` `realizedStats`/`isVerifiedProfitable` (realized PnL ≠ leaderboard ROI), `copy-backtest.ts`
  (no-lookahead + shuffle + lead-lag entry-impulse), `capital-flow.ts` (deposits/withdrawals distort ROI + signals).
- **Forward confirmation (the anti-overfit ground truth):** `carry:monitor` (hourly), `hl:copy-paper` (daily),
  `consensus:paper` (every 4h, independent resolution). An edge is real only once a forward track holds.
- **Backtest bar:** the honest gauntlet — Sharpe → walk-forward → PBO → Deflated-Sharpe. Tests: `npx vitest run`.
