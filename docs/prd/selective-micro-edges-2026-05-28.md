# PRD — Selective micro-edges + complement-sum arbitrage (2026-05-28)

**Status:** drafted-for-approval
**Owner:** Isaiah Dupree
**Drafted:** 2026-05-28
**Source of framing:** Operator-supplied analysis arguing the right model isn't "predict direction every 5 minutes" but "find the rare 5-minute windows where the market is measurably mispriced + take tiny, repeatable wins."
**Companion PRDs:**
- `gated-decision-system-2026-05-27.md` — per-trade gating (provides the *enforcement* layer)
- `capsule-portfolio-governance-2026-05-27.md` — portfolio diversification (provides the *isolation* layer)

This PRD is about *edge discovery + calibration* — what trades to take in the first place. The other two PRDs are about safely *acting on* trades. Together they form the full system.

---

## 1. Why now

Today's setup tries to predict direction on every 5-min crypto Up/Down binary. The midwindow-trajectory backtest looked great in crypto-only mode (85–91% hit rate) but the live equivalent gets crushed because:

- **The market reprices fast** — by T+2min the MM has already moved the quote in the direction of the trajectory. The trajectory's predictive value is mostly priced in.
- **No edge quantification** — strategies place trades without computing `(p_model − q_market)`. Every trade is treated equal regardless of how much the market disagrees with the model.
- **No calibration audit** — we don't track whether 87%-confidence predictions actually win 87% of the time. Without that, model confidence is a vibe, not a signal.
- **One signal in five costumes** — the cross-wallet consensus engine treats 3 clusters of similar bots as 3 independent signals when they're effectively one.

The operator's reframe:

> Don't ask: "can we beat the market every 5 minutes?"
> Ask: "can we find the few 5-minute windows where the market is mispriced enough to justify a tiny, controlled bet?"

This PRD codifies that into three trading models, ranks them by certainty, and identifies what to build vs. what's already in place.

## 2. Three trading models, ranked by mechanical certainty

### Model A — Complement-sum arbitrage (cleanest)

Polymarket binaries pay $1 to the winner and $0 to the loser. If both sides are quoted cheap enough that `Up_ask + Down_ask < $1`, buying both = guaranteed positive payout at resolution.

```
profit_per_pair  = $1 − Up_ask − Down_ask − fees − slippage
viable_when      = profit_per_pair > 0
```

**Mechanical edge.** No directional model required. Edge survives even if you have zero predictive ability. Risk = resolution risk + fee miscalibration + adverse partial fills.

Capital efficiency at various spreads (operator's table):

| Up+Down combined | Profit/pair | Active capital needed for $300/day across 288 windows |
|---|---|---|
| $0.95 | $0.05 | ~$20/window |
| $0.97 | $0.03 | ~$34/window |
| $0.98 | $0.02 | ~$51/window |
| $0.99 | $0.01 | ~$103/window |
| $1.00 | $0.00 | no profit |
| $1.01 | -$0.01 | guaranteed loss |

The $300/day target is realistic IF combined entries below $0.97 appear often enough — and the live order book actually fills at those prices. Both are open questions.

### Model B — Volatility scalp (straddle-like)

Buy BOTH Up and Down for `< $1.10` (modest premium), then exit one side after a directional move expands the price gap. Net profit if either side moves past the breakeven before resolution.

```
example:
  Buy Up at $0.49 + Down at $0.49 = $0.98 cost
  BTC spikes up:
    Up rises to $0.70
    Down falls to $0.28
  Sell Up at $0.70 + hold Down (or sell for $0.28)
  Realized: $0.70 + $0.28 − $0.98 = $0.00 (best case break-even on equal spike)
  or sell Up + let Down go to 0 if BTC stays up: $0.70 − $0.98 = −$0.28 (loss)
```

**This is a long-straddle profile** — profits when realized vol exceeds implied vol. Requires real volatility, not just directional certainty. Hardest mode is choosing the right moment (low implied vol → expensive realized vol).

### Model C — Selective directional with model-vs-market edge

The realistic version of "we predict direction." Enter only when:

```
edge = (p_model − q_market_ask)
      > spread + slippage + fees + latency_penalty + safety_margin
```

Default behavior is **no trade.** The pipeline should reject most 5-minute windows. Only enter when:
1. Multiple INDEPENDENT signals (not 5 variants of Markov) agree
2. Price is far from the strike line
3. Realized vol over recent ticks is contained (not in news-shock)
4. Order book is deep enough to exit cleanly
5. Daily loss limit not yet hit

Critical metric: **calibration.** If you label a trade "90% confidence," it should win 90% of the time over hundreds of samples. Without calibration, confidence is just a number.

## 3. Core math the system must compute (and journal)

For every proposed trade:

```
q     = market ask on the side we want                     (read from CLOB top-of-book)
p     = model's estimated probability of that side winning  (strategy outputs this)
edge  = p − q                                                 (the magnitude of mispricing)
ROI_win = (1 − q) / q                                         (if we win)
ROI_lose = −1                                                 (lose entire stake)
EV    = p × (1 − q) − (1 − p) × q
       = p − q                                                (this is the same as edge)
EV_pct = (p − q) / q                                          (expected return as %)
```

**Critical observations:**
- `EV` equals `p − q` exactly. Many docs confuse "ROI if win" `(1−q)/q` with EV.
- Buying at $0.90 means **1 loss wipes out 9 wins**. The system must filter aggressively.
- Spread + slippage + fees must be subtracted from `edge` BEFORE deciding to fire.

The `edge` gate already exists in our decision pipeline (Phase 2). What's missing is feeding it the right inputs — strategies need to compute `p` honestly and emit `metadata.edge = p - q`.

## 4. Independent-signals principle

The cross-strategy ensemble (deferred to v2 in the gated-decision-system PRD) becomes critical here. The risk: 5 Markov-chain agents all looking at the same price series are NOT 5 independent edges. They're one signal wearing five costumes — the operator's exact phrase.

True independence requires different *information sources*:

| Source | Independent because |
|---|---|
| Markov persistence on recent ticks | Pure price-action |
| Distance from strike line | Geometric, not statistical |
| Realized vol over 2 min | Vol-state classification |
| CEX (Coinbase) price-action divergence from CLOB-implied | Cross-venue signal |
| Order-book imbalance (top-3 depth) | Microstructure |
| Cross-wallet consensus (clusters, not raw count) | Smart-money flow |
| News / liquidation-spike filter | Event-driven |

**Decision rule:** trade only when 5+ INDEPENDENT-CLUSTER signals agree. Two correlated signals contribute as one vote.

## 5. What already exists (capability → module map)

Don't re-build:

| Need | Existing module | Status |
|---|---|---|
| `edge` gate | `src/lib/decision/gates.ts` `edgeGate()` | Wire strategies to emit `metadata.edge` |
| Strategy declares regime preference | spec_json.regimes (Phase 5 backfill) | Done |
| Reject when edge < fees | `edgeGate` already does this | Done |
| Per-pair complement-sum scan | none yet | **NEW** |
| Calibration tracking (do 90%-confidence preds actually win 90%) | decision_journal has approval_score; need resolution lookup | **NEW** |
| Vol-state classification | `regime.ts` already has sigma_total | Reuse |
| Cross-strategy ensemble (independent-signals voting) | none yet | **NEW** |
| Order-book imbalance signal | `src/lib/strategies/orderbook-imbalance.ts` | Surface in pipeline |
| Cross-wallet consensus | `scan-consensus` already collapses by cluster | Reuse |
| Order-book depth + slippage estimation | none yet | **NEW** (for clean exit math) |

## 6. What we build

### 6.1 Complement-sum arbitrage scanner (Model A)

```
src/lib/strategies/complement-sum-arb.ts   (pure detector)
scripts/scan-complement-sum.ts              (poll Polymarket binaries; emit signals)
scripts/worker-complement-sum-exec.ts       (gated executor, sim-default)
```

Detector accepts:
```ts
type BinaryBookSnapshot = {
  conditionId: string;
  asset: string;
  windowOpenMs: number;
  windowCloseMs: number;
  upBestAsk: number;
  downBestAsk: number;
  upDepthUsd: number;      // depth at current ask
  downDepthUsd: number;
  estimated_fee_bps: number;
};
```

Returns:
```ts
type ComplementArbOpportunity = {
  conditionId: string;
  combined_cost: number;        // upBestAsk + downBestAsk
  profit_per_pair: number;      // 1 − combined − fees
  max_pairs: number;            // floor(min(upDepthUsd, downDepthUsd) / pair_cost)
  roi_pct: number;
  time_to_resolve_min: number;
};
```

Gates: combined_cost ≤ `MAX_ARB_COMBINED` (default 0.97), profit_per_pair ≥ `MIN_ARB_PROFIT` (default $0.02), time_to_resolve ≥ `MIN_ARB_HOLD_MIN` (default 1).

### 6.2 Calibration tracker

```
src/lib/decision/calibration.ts
src/app/calibration/page.tsx
```

For every journaled decision with `decision_journal.approval_score`, lookup the eventual trade outcome (paper_trades.realized_pnl or polymarket fill resolution). Bucket decisions by approval_score (e.g. 0.5–0.6, 0.6–0.7, …, 0.9–1.0). Compute realized win-rate per bucket. Surface on `/calibration` page so the operator can see whether the model is honest.

Decision pipeline becomes self-tuning over time: if 85%-score predictions only win 65% of the time, the score formula needs adjustment.

### 6.3 Independent-signals agreement gate (signal_agreement)

The gate slot `signal_agreement` exists in `DEFAULT_GATE_WEIGHTS` (weight 0.15) but no gate emits it yet. Build:

```
src/lib/decision/gates/signal-agreement.ts
```

Accepts `ctx.snapshot.signals[]` — an array tagged with `cluster: 'price-action' | 'volatility' | 'microstructure' | 'cross-venue' | 'smart-money' | 'event'`. Counts unique clusters, returns:
- 5+ clusters agree on direction → score 1.0, action CONTINUE
- 3-4 clusters agree → score 0.7, action REDUCE_SIZE
- ≤2 clusters or conflicting → score 0.3, action REDUCE_SIZE
- Hard conflict (strong opposite signal in another cluster) → action REJECT

Strategies populate `signals[]` on the proposal metadata before submitting; this gate aggregates.

### 6.4 Order-book depth + slippage estimator

```
src/lib/decision/slippage.ts
```

Pure function: given `sizeUsd` + L2 order-book snapshot → estimated execution price including market-impact slippage. Used by the `edge` gate so net edge accounts for the actual fill price, not the top-of-book price.

### 6.5 Volatility-scalp strategy (Model B, research-only v1)

```
src/lib/strategies/vol-scalp.ts   (detector only)
scripts/backtest-vol-scalp.ts
```

v1 is research-only — emits signals to `evolution_log` for operator review. Live execution deferred until backtest validates that realized vol exceeds implied vol often enough to clear the entry premium. This strategy is the LOWEST priority of the four because it requires the most complex execution (managing two positions, deciding when to sell one side).

## 7. Scope — what's out (deferred)

- **Cross-venue arb (Coinbase ↔ Polymarket implied)** — already partially in `cross_venue_arb` genome kind; this PRD doesn't expand it.
- **News/event detection** — requires external feed (X / RSS / event API). Separate ingestion workstream.
- **Real-Polymarket-historicals backtest of midwindow-trajectory** — separate research workstream from this PRD.
- **Live deployment of Model B (vol-scalp)** — needs sim validation first; v1 detector only.
- **Bayesian probability updating** — for now strategies emit a static `p_model`; v2 can iterate.

## 8. Acceptance criteria

- `detectComplementSumArb()` is a pure function with unit tests covering: combined-cost below/at/above 1.0; fees clipping the profit; insufficient depth (max_pairs = 0); invalid prices.
- `scan-complement-sum` script writes opportunities to `evolution_log` with `event_type='complement-sum-opportunity'` and deduplicates within a single condition.
- `signal_agreement` gate is wired into the pipeline; strategies attach `signals[]` to proposal metadata; the gate counts unique clusters.
- Calibration tracker: `SELECT decision_bucket, COUNT(*), SUM(won) FROM ...` returns reasonable numbers within 24h of shadow data accumulation; `/calibration` renders the table.
- Slippage estimator: given a $5 BUY against an L2 book with $2 at best ask + $3 at second-best, returns the volume-weighted expected fill price; unit tests cover thin-book + thick-book cases.
- Vol-scalp detector returns opportunities only when `recent_vol > entry_premium / window_remaining_min`; v1 sim-only.
- All new modules + scripts wire into `npm run` scripts; documented in README at the operator level.

## 9. Safety / risk

- Complement-sum arb is the **safest** new code path — locked payout once both legs fill. The risk is partial-fill (one leg fills, the other doesn't). Mitigation: `worker-complement-sum-exec` must atomically place both orders OR back out; `MAX_PARTIAL_FILL_RETRY` env caps how long it tries before unwinding.
- Calibration tracker is **read-only** — it analyzes journaled decisions, doesn't affect live trades.
- `signal_agreement` gate is **additive** — it can only REDUCE size or REJECT; can never amplify. Existing per-capsule + governor gates still enforce.
- Vol-scalp v1 is **simulation-only** — no live submit; eliminates execution risk while we validate the thesis.
- Per the gated-decision-system PRD: rolling out via `DECISION_PIPELINE_SHADOW` first, only flipping `DECISION_PIPELINE_ENABLED=1` after pre-flight passes.

## 10. Operational notes

- **The complement-sum scanner is the highest-leverage piece** — it's a mechanical edge that doesn't require any predictive model. If we can fill at sub-$0.97 combined on Polymarket 5m binaries, we have a profitable system regardless of every other model's accuracy.
- The calibration tracker is the SECOND most important piece because it turns the existing decision_journal into a learning system — every shadow-mode decision contributes evidence about the model's honesty.
- Independent-signals voting is the "consensus across uncorrelated views" piece — it implements the operator's "5 agents looking at the same Markov signal are not 5 independent signals" insight.
- This PRD intentionally does NOT introduce a new "high-confidence predictor" strategy. The existing midwindow-trajectory + heuristic strategies are sufficient *signal sources*; what we need is better *filtering* via signal-agreement + slippage-aware edge calc + calibration audit.
