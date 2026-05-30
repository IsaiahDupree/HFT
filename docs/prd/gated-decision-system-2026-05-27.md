# PRD — Gated decision system for live agents (2026-05-27)

**Status:** drafted-for-approval
**Owner:** Isaiah Dupree
**Drafted:** 2026-05-27
**Source of framing:** Operator-supplied architecture doc (NASA-launch-control / 12-gate model, with regulator backing in SEC Rule 15c3-5, FINRA Notice 15-09, and ESMA MiFID II Article 17).

---

## 1. Why now

The system currently has several risk + decision modules but they operate as **a sequence of independent yes/no gates**, not as a unified, explainable decision pipeline. Observable symptoms:

- All 3 live capsules ran the same strategy kind. When `poly_short_binary_directional` had a bad day, all three lost — there's no cross-strategy diversification gate.
- A losing trade is logged but the *rejection* path is not surfaced — the operator can't easily see "we almost traded X but gate Y vetoed because Z."
- There's no regime classifier — the midwindow-trajectory strategy fires on trending and chop alike (the chop filter we just shipped is a strategy-local hack, not a system-wide regime layer).
- Position size is clamped by `MAX_TRADE_USD` but not modulated by confidence, recent performance, or volatility.
- After a trade closes, the agent's fitness updates but we don't separately reward *decision quality* vs *lucky outcomes*.

The operator's framing (12 gates + approval score + state machine + audit log) is the right model. This PRD turns it into a buildable plan that extends what exists rather than rewriting it.

## 2. The mental model (preserved verbatim from operator)

Every order moves through this state machine:

```
SCAN → CANDIDATE → SIGNAL_AGREE → REGIME → EDGE → RISK →
EXECUTION → APPROVED → MANAGED → EXIT → REVIEWED
```

Each transition is guarded by a **gate** that emits one of seven actions:

```
CONTINUE | WAIT | RECHECK | REDUCE_SIZE | HEDGE_OR_OFFSET | REJECT | KILL_SWITCH
```

Gate outputs combine into a `trade_approval_score` (weighted sum, target 0..1):

```
score = 0.15·data + 0.10·market + 0.15·regime + 0.20·signal_agreement
      + 0.20·edge + 0.15·risk + 0.05·execution

score > 0.80 → full size
score 0.65–0.80 → reduced size
score 0.50–0.65 → watchlist only (paper, no live submit)
score < 0.50 → rejected (logged with reasons)
```

## 3. What exists today (gate → module map)

| # | Gate | Module(s) we already have | Status |
|---|---|---|---|
| 1 | Data Quality | `arena/snapshot.ts`, scattered staleness checks (e.g. `cross-timeframe-spread.ts` `maxStalenessSec`) | partial — no unified module |
| 2 | Market Eligibility | `risk/limits.ts` `allowed_venues` / `allowed_symbols`, `capsules/gate.ts` | exists |
| 3 | Regime | `strategies/midwindow-trajectory.ts` efficiency filter | strategy-local only — no global classifier |
| 4 | Strategy Signal | each strategy emits its own opportunity object | exists but un-standardized |
| 5 | Strategy Agreement | `scan-consensus.ts` (cross-wallet only) | gap — no cross-strategy ensemble |
| 6 | Edge | per-strategy fee + edge math (NRS, midwindow, CTS) | exists, scattered |
| 7 | Risk | `risk/engine.ts`, `capsules/gate.ts`, `capsules/circuit-breaker.ts`, `arena/risk-budget.ts` | strong; needs unification |
| 8 | Position Sizing | `arena/live-capsule.ts` `MAX_TRADE_USD` clamp; `risk-budget.ts` | size by cap only — no confidence/volatility modulation |
| 9 | Execution | `polymarket/execute.ts` (broker-error detection, price-tick clamping) | exists |
| 10 | Trade Management | strategy-local (5m-binary auto-exits at window close) | gap — no thesis-invalidation framework |
| 11 | Exit | daily-loss cap + per-strategy stop-loss | partial |
| 12 | Post-Trade Learning | `arena/evolve.ts`, `arena/score.ts`, `research-loop.ts` heuristic evaluators | exists but only rewards PnL, not decision quality |

## 4. The actual gap

Five concrete deliverables would close the gap between "we have gates" and "we have a gated decision system":

1. **`DecisionContext` + `GateResult` types** — a standardized result envelope every gate emits.
2. **`DecisionPipeline.run()`** — orchestrates the existing gates in order, collects results, computes the approval score, returns `{ decision, score, gateResults[] }`.
3. **`gates/regime.ts` — global regime classifier** — runs once per market snapshot, surfaces `{ regime: trending|chop|breakout|news_shock, confidence, vol_state }`. Strategies declare which regimes they're for via metadata; the gate downweights or skips when mismatched.
4. **`decision_journal` table + UI** — every decision (approved, reduced, rejected) lands here with `gate_results_json` so the operator can answer "why didn't we trade X?" from the UI.
5. **Sizing modulator** — extends `live-capsule.ts` to scale stake by `approval_score × confidence_multiplier × drawdown_multiplier`, replacing the current "always max_trade_usd" sizing.

The other gate types (data quality, ensemble, trade management) are deferred — high cost, lower immediate value while we only have a handful of live strategies. They go in a v2 PRD.

## 5. Scope — what's in

### 5.1 Types + envelope

```ts
// src/lib/decision/types.ts
type GateAction = "CONTINUE" | "WAIT" | "RECHECK" | "REDUCE_SIZE"
                | "HEDGE_OR_OFFSET" | "REJECT" | "KILL_SWITCH";

type GateResult = {
  gate: string;                  // "regime" | "edge" | "risk" | …
  status: "pass" | "fail" | "partial";
  score: number;                 // 0..1, contributes to approval score
  action: GateAction;
  reason: string;                // human-readable
  details?: Record<string, unknown>;
};

type DecisionContext = {
  agentId: number;
  capsuleId: string;
  strategyKind: string;
  proposal: {
    venue: string; symbol: string; side: "BUY" | "SELL";
    sizeUsd: number; price: number; conditionId: string;
  };
  snapshot: { … };               // market data — passed by caller
  ts: string;
};

type DecisionResult = {
  decision: "APPROVED_FULL" | "APPROVED_REDUCED" | "WATCHLIST" | "REJECTED" | "KILL_SWITCH";
  approval_score: number;
  size_multiplier: number;       // 1.0 full, 0.5 reduced, 0 if watchlist/rejected
  gate_results: GateResult[];
  decision_ts: string;
};
```

### 5.2 The pipeline

`src/lib/decision/pipeline.ts` exports `runDecisionPipeline(ctx: DecisionContext): Promise<DecisionResult>`. It walks the gates in a defined order, short-circuits on `KILL_SWITCH` or any `REJECT` in a non-overridable gate (data quality, risk), and aggregates a weighted score.

### 5.3 Regime classifier

`src/lib/decision/gates/regime.ts` exposes `classifyRegime(snapshot)` → `{ regime, confidence, vol_state }`. v1 implementation: directional efficiency over last 5 minutes + realized vol percentile vs trailing 24h. Strategies declare regime-fit in their `initialSpec` (e.g. `{ regimes: ["trending", "breakout"] }`); the gate scores 1.0 on match, 0.4 on mismatch.

### 5.4 Decision journal

```sql
CREATE TABLE decision_journal (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL,
  agent_id        INTEGER,
  capsule_id      TEXT,
  strategy_kind   TEXT,
  market_id       TEXT,
  decision        TEXT NOT NULL,   -- APPROVED_FULL | APPROVED_REDUCED | WATCHLIST | REJECTED | KILL_SWITCH
  approval_score  REAL NOT NULL,
  size_multiplier REAL NOT NULL,
  proposal_json   TEXT NOT NULL,
  gate_results_json TEXT NOT NULL,
  order_id        TEXT             -- populated if submitted
);
CREATE INDEX idx_decision_ts ON decision_journal(ts);
CREATE INDEX idx_decision_capsule ON decision_journal(capsule_id, ts);
```

UI: new `/decisions` page that lists last N decisions with the rejected reasons surfaced.

### 5.5 Sizing modulator

`live-capsule.ts` calls the pipeline. If the result is `APPROVED_REDUCED`, the existing `size = Math.min(signal.size_usd, capsuleAvailable, MAX_TRADE_USD)` is wrapped to `size = base × result.size_multiplier`. Existing clamps still apply on top — modulator can only reduce, never amplify.

## 6. Scope — what's out (deferred to v2)

- **Cross-strategy ensemble (gate 5)** — useful once we have ≥2 strategies firing on the same market simultaneously. Today's strategy mix is mostly disjoint by market, so building this now is premature.
- **Data-quality unification (gate 1)** — current scattered staleness checks are sufficient for v1. v2 introduces a unified `DataQualityGate` once we add multi-source price feeds.
- **Trade-management thesis-invalidation (gate 10)** — 5m binaries auto-exit at window close, so there's little room for active management on the dominant strategy. NRS holds-to-resolution so also limited. Re-evaluate when we add strategies with active mid-trade management.
- **Post-trade decision-quality scoring (extending gate 12)** — needs decision_journal to exist first so there's data to analyze. v2.

## 7. Acceptance criteria

- `runDecisionPipeline()` accepts a `DecisionContext`, returns a `DecisionResult` with non-empty `gate_results[]`.
- Every existing gate is wrapped to emit a `GateResult` (no behavior change for the underlying checks — only the envelope changes).
- `classifyRegime()` returns one of `{ trending, chop, breakout, news_shock, low_vol }` and matches the strategy's declared `regimes` array.
- A rejected trade lands in `decision_journal` with `decision='REJECTED'` and a populated `gate_results_json` explaining which gate(s) failed.
- A reduced trade actually gets submitted with `size = base × size_multiplier`, verified via `paper_trades.size_usd` reconciliation.
- `/decisions` UI shows the last 50 decisions across all live capsules with filter by `decision` and `strategy_kind`.
- `live-capsule.ts` calls the pipeline; if the call fails or pipeline returns malformed result, the order falls back to the **existing** code path (i.e. no regression in trading behavior — the pipeline is additive).
- Unit tests cover: weighted score math, kill-switch short-circuit, regime classifier on synthetic trending/chop/breakout ticks, sizing modulator monotonicity (higher score ⇒ higher or equal size).

## 8. Safety / risk

- The pipeline is **wrapped, not replaced**: existing `risk/engine.ts` and `capsules/gate.ts` continue to enforce their own checks even if the pipeline says CONTINUE. A trade can only proceed if BOTH the pipeline approves AND the existing gates pass.
- Sizing modulator is bounded `[0, 1]` — it cannot increase a position above what the existing clamps allow.
- Kill-switch is a separate, sticky flag (already in `risk/engine.ts`). The pipeline can SET kill-switch but cannot CLEAR it (manual operator intervention required).
- All gate failures are journaled regardless of whether the trade would have been blocked anyway — so we can detect "double-rejected" situations (multiple gates failing) and use that as a signal for evolution.

## 9. Operational notes

- **Backward compatibility**: existing strategies don't have a `regimes` declaration. Default behavior when missing = no regime modulation (score 1.0). This lets us ship the pipeline without forcing every strategy to be updated on day 1.
- **Auditability**: every decision is one row. Easy to ship to a CSV for offline analysis.
- **Reversibility**: a `DECISION_PIPELINE_ENABLED=0` env flag short-circuits the pipeline back to the legacy code path. Used if the pipeline misbehaves in production.
