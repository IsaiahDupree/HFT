# Backtesting — replay market_snapshots with arena scoring

The backtester replays `market_snapshots` rows through a decision function
and scores using TradingBot's arena formula:

```
score = pnl_pct × 100 − k × max_dd_pct × 100        (k default = 2.0)
```

A +20% return with 15% max drawdown gives score `20 − 2 × 15 = −10`.
A +8% return with 0% drawdown gives score `+8`. The drawdown penalty
favors steady earners over volatile gamblers.

## Run from CLI

```bash
npm run backtest -- --version 12 --token <token_id>            # defaults
npm run backtest -- --version 12 --token <token_id> \
  --buy 0.40 --sell 0.55 --size 50                              # custom params
```

Writes a row to `performance_metrics(window='backtest')` AND logs a
`backtest` event to `evolution_log` with the full result payload.

## Run programmatically

```ts
import { runBacktest, loadSnapshotsForToken, thresholdMeanReversion } from "@/lib/backtest/engine";

const snaps = loadSnapshotsForToken("<token_id>");
const decide = thresholdMeanReversion({
  buyBelow: 0.40,
  sellAbove: 0.55,
  sizeShares: 50,
});
const result = runBacktest(snaps, decide, { startingCash: 1000, dragPenalty: 2.0 });

console.log(result.pnlUsd, result.maxDrawdownPct, result.score);
```

## Decision function contract

```ts
type DecisionFn = (snapshot: SnapshotPoint, state: BacktestState) => Decision;

type Decision =
  | { action: "enter"; side: "YES" | "NO"; size: number }   // size = shares
  | { action: "exit" }
  | { action: "hold" };
```

The engine carries the trade state. Strategies are pure: input `(snapshot, state)`,
output `Decision`. No side effects.

## Built-in strategies

- **`thresholdMeanReversion({ buyBelow, sellAbove, sizeShares })`** — buy YES when midpoint dips below `buyBelow`, exit when midpoint recovers above `sellAbove`.

Add new ones in `src/lib/backtest/engine.ts` (or your own file — they're
plain TS).

## Caveats

- **Fills at midpoint.** No slippage, no walk through bid/ask, no latency.
  For binary markets with tight spreads (often 1¢), defensible. For Coinbase
  cross-venue arb, optimistic. A fill-realism layer is planned
  (`MIGRATION-TARGETS.md` § 5).
- **No short selling.** YES and NO are the two "sides" — you can BUY either,
  not SELL short.
- **Cash-bound entries.** If the order would cost more than current cash,
  it's silently skipped. Good for safety, but loud failures might be more
  informative when designing a strategy.
- **No fee model.** Polymarket has near-zero fees, but Coinbase does — when
  the backtester grows to handle Coinbase prices, add a fee.

## Scoring sanity checks

Run a baseline against random snapshots to see what "0 score" looks like:

```ts
const flatDecision: DecisionFn = () => ({ action: "hold" });
const baseline = runBacktest(snaps, flatDecision);
// Expected: pnlUsd=0, maxDrawdown=0, score=0
```

Anything beating this for any strategy is at least directionally interesting.
But until fill realism + fees are in, treat backtest score as a **relative
ranking signal**, not a profit forecast.
