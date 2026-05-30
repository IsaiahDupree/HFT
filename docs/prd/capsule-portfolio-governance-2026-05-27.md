# PRD — Capsule Portfolio Governance (2026-05-27)

**Status:** drafted-for-approval
**Owner:** Isaiah Dupree
**Drafted:** 2026-05-27
**Source of framing:** Operator-supplied architecture doc (capital capsules + global risk governor + correlation engine + cluster kill switches + loss-overlap metric).
**Companion PRD:** `gated-decision-system-2026-05-27.md` — that one is per-trade decision gating; this one is portfolio-level diversification governance.

---

## 1. Why now

Today's setup runs three live capsules — all bound to elite agents that share the same strategy kind (`poly_short_binary_directional`, 5m-binary). When that kind has a bad day, all three lose simultaneously. That's not three diversified strategies — it's one strategy in three costumes. The operator's principle, verbatim:

> A capsule gets more capital only if it made money *differently* from the other capsules. Five agents that all made money from the same bull trend are not five edges — they are one edge split into five costumes.

What's missing:

- Capsules have no **diversity profile** (strategy family, asset class, regime, time horizon, signal source) so the system can't detect when two capsules are effectively the same.
- No **correlation engine** measures PnL / signal / asset overlap between live capsules.
- No **cluster-level kill switches** — only individual capsule daily-cap pauses. When *every* crypto-momentum capsule loses on the same dump, the cluster keeps trading until each individual cap is hit.
- No **global risk governor** — capsules collectively make all capital decisions; there's no veto layer above them.
- No **capsule lifecycle stages** beyond `paper | live | paused`. A new genome that just earned championship goes straight from paper to live without micro-live / probation phases.
- No **reserve capsule** — 100% of deployable capital is reachable by the trading system. No "money the bot cannot touch."

This PRD adds those five capabilities.

## 2. Mental model (preserved verbatim from operator)

```
Global Portfolio Governor
│
├── Reserve Capsule              (no trading — survival floor)
├── Conservative Paper-to-Live   (validated agents, tiny size)
├── Trend Capsule                (momentum, breakout, trend-state)
├── Mean Reversion Capsule       (z-score, bollinger, range-bound)
├── Volatility Capsule           (ATR breakout, vol expansion)
├── Market-Neutral Capsule       (pairs, spreads, hedge-based)
├── On-Chain / Event Capsule     (whale flow, consensus, news)
└── Experimental Capsule         (tiny allocation, high learning)
```

Above the capsules: **Global Risk Governor** with absolute veto on:
- total account exposure
- max correlated exposure across capsules
- max same-direction exposure
- max same-asset exposure
- max strategy-family exposure
- global drawdown kill switches

Loss-overlap metric (the highest-value signal):

> When this capsule loses, how often do OTHER capsules lose at the same time?
> High loss-overlap = capsule is not adding diversification, regardless of return.

## 3. What exists today (capability → module map)

| Capability | What we have | Gap |
|---|---|---|
| Per-capsule risk limits | `capsules` table + `risk-budget.ts` (capital, daily-loss, total-DD, max-trades-per-day) | ✓ exists |
| Per-capsule kill switch | `circuit-breaker.ts` (auto-pause on 5+ errors / 0 wins in 15min) | ✓ exists |
| Per-capsule status lifecycle | `status: paper | live | paused` in `capsules` table | partial — no micro-live/probation stages |
| Capsule diversity profile | None | **gap** |
| PnL correlation engine | None | **gap** |
| Cluster kill switches | None | **gap** |
| Global risk governor | `RiskEngine` is per-order, not portfolio-level | partial — no portfolio veto |
| Reserve capsule | None | **gap** |
| Loss-overlap metric | None | **gap** |
| Strategy-family exposure caps | None | **gap** |
| Capsule promotion rules | `auto-promote.ts` picks top-N elites, no correlation check | partial — needs correlation veto |

## 4. The gap → what we build

### 4.1 Capsule diversity profile

New columns on the `capsules` table (additive — defaults preserve existing behavior):

```sql
ALTER TABLE capsules ADD COLUMN strategy_family TEXT;       -- "momentum" | "mean_reversion" | "vol_breakout" | "market_neutral" | "consensus" | "scrape" | "experimental" | "reserve"
ALTER TABLE capsules ADD COLUMN asset_class TEXT;           -- "crypto" | "equity" | "macro" | "stable" | "prediction_market"
ALTER TABLE capsules ADD COLUMN allowed_assets_json TEXT;   -- ["BTC","ETH",...] subset of asset_class
ALTER TABLE capsules ADD COLUMN time_horizon TEXT;          -- "1m" | "5m" | "15m" | "1h" | "1d" | "to_resolution"
ALTER TABLE capsules ADD COLUMN regime_dependency TEXT;     -- "trending" | "chop" | "high_vol" | "low_vol" | "any"
ALTER TABLE capsules ADD COLUMN directional_bias TEXT;      -- "long_only" | "short_only" | "long_short" | "neutral"
ALTER TABLE capsules ADD COLUMN diversity_profile_json TEXT; -- escape hatch for richer metadata
```

These get populated for existing capsules via a one-shot script that infers them from the bound agent's strategy kind.

### 4.2 Correlation engine

`src/lib/portfolio/correlation.ts` — pure module. Inputs: time series of per-capsule daily PnL (read from `capsules.daily_pnl_usd` history). Outputs:

```ts
type CapsulePair = { a: string; b: string };
type CorrelationReport = {
  pair: CapsulePair;
  pnl_correlation: number;       // Pearson over last N days
  asset_overlap: number;         // |A ∩ B| / |A ∪ B| of allowed_assets
  strategy_family_match: boolean;
  loss_overlap: number;          // fraction of days where BOTH had negative pnl
  drawdown_overlap: number;      // fraction of agent-A drawdowns that overlap with agent-B drawdowns
  signal_correlation?: number;   // v2 — requires decision_journal
  verdict: "diversified" | "correlated_safe" | "too_similar";
};
```

`recordDailyCorrelations()` runs once at UTC midnight, walks all live capsule pairs, writes to a new `capsule_correlations` table for trend tracking.

### 4.3 Loss-overlap metric (the highest-value scalar)

Surfaced per capsule:

```ts
loss_overlap_score(capsuleId) = mean over last 30 days of: P(other_capsule_lost | this_capsule_lost)
```

A capsule with consistent +returns but 80%+ loss-overlap is treated as **redundant** by the global allocator — its allocation gets capped regardless of profitability.

### 4.4 Cluster kill switches

Define clusters by shared `strategy_family + asset_class` (and optionally `regime_dependency`). The kill switch ladder:

```
Individual capsule loses > 2% in 1 day  →  pause capsule (already exists via daily-loss cap)
Strategy-family cluster loses > 4% in 1 day  →  pause cluster (NEW)
Asset-class cluster loses > 6% in 1 day  →  pause cluster (NEW)
Global PnL loses > 5% in 1 day  →  global risk-off (reduce all live capsules to 25% size)
Global PnL loses > 10% in 1 day  →  global kill switch (all capsules paused)
```

Implementation: `src/lib/portfolio/cluster-killswitch.ts` runs on every tick, checks each cluster's aggregated PnL against threshold, writes pause-events to `evolution_log` and updates capsule statuses.

### 4.5 Global Risk Governor

`src/lib/portfolio/governor.ts` — sits **above** the per-trade `RiskEngine` and `capsules/gate.ts`. Veto power on:

- **Same-trade collision**: if N capsules want to enter the same `(asset, direction, time_horizon)` in a 5-minute window, treat as one trade and cap aggregate size at the single-trade cap.
- **Correlated exposure cap**: tracks `total_long_crypto_exposure_usd` across all capsules; rejects new orders that would push above `MAX_CORRELATED_EXPOSURE_PCT × total_live_capital`.
- **Strategy-family cap**: each family has a max % of live capital it can control. Reject if a new capsule activation would exceed it.
- **Reserve floor**: `total_deployed ≤ (1 - RESERVE_PCT) × total_account_usd`. Reserve is untouchable.

Called by the decision pipeline (companion PRD) as the **portfolio-level gate** after per-capsule gates pass.

### 4.6 Capsule lifecycle stages

Extend `capsules.status` from `paper | live | paused` to:

```
idea  →  backtest  →  paper  →  micro_live  →  probation_live  →  full_live  →  degraded  →  frozen  →  retired
```

Promotion + demotion are governed by `auto-promote.ts` (extended) using:

```ts
promote_to_next_stage requires:
  - >= ARENA_PROMOTE_MIN_TRADES at current stage
  - positive expectancy at current stage
  - pnl_correlation to existing same-stage capsules < 0.55
  - drawdown < stage's max
  - regime fit confirmed (regime gate from companion PRD)

demote requires:
  - drawdown breach
  - correlation rise above ceiling
  - slippage worsening trend
  - loss-overlap > 0.70 sustained for 7 days
```

### 4.7 Reserve capsule

A pseudo-capsule with `status='reserve'`, `strategy_family='reserve'`, capital allocated but **not deployable** by any agent. Enforced by:

```ts
// In Global Risk Governor:
if (capsule.strategy_family === 'reserve') return REJECT;
```

Default reserve sizing: `ARENA_RESERVE_PCT=0.50` (50% of total account untouchable). Operator-overridable but with floor of 0.25.

## 5. Scope — what's in

- All seven sub-deliverables in §4.1–§4.7.
- Schema migrations (additive only — existing capsules continue to function).
- One-shot inference script for existing capsules (`scripts/infer-capsule-diversity.ts`).
- Operator UI: extend `/arena` to show per-capsule diversity profile + cluster pause state; add `/portfolio` page for correlation matrix + loss-overlap.
- Unit tests for correlation math, cluster kill-switch ladder, governor veto rules.
- Integration test: simulate 3 correlated capsules taking the same trade; assert governor caps aggregate size.

## 6. Scope — what's out (deferred)

- **Signal correlation** between capsules (requires `decision_journal` from companion PRD to be populated for weeks first).
- **Stress-testing harness** for new capsules (backtest replay of historical drawdown periods). Separate workstream.
- **Bayesian capsule allocator** (Markowitz-style portfolio optimization across capsules). v2 once we have 8+ live capsules to allocate across.
- **Hedge generation** ("force hedge before opening long-crypto exposure"). v3.
- **News/sentiment data ingestion** for the news-shock regime detector. Requires external data source — separate research.

## 7. Acceptance criteria

- `capsules` table has all new diversity columns; existing capsules have inferred values written by the one-shot script.
- `capsule_correlations` table populates daily; `SELECT * FROM capsule_correlations ORDER BY created_at DESC LIMIT 5` returns recent pair stats.
- Loss-overlap score is computed and viewable per capsule on `/arena`.
- Cluster kill switches: simulated test where 3 same-family capsules each lose 1.5% in a day → cluster crosses 4% → all 3 pause with reason "cluster-killswitch:strategy-family-loss".
- Global Risk Governor: simulated test where capsule A goes long BTC $5, capsule B tries long BTC $5 → governor flags as same-trade collision, caps aggregate at $5 not $10.
- Reserve capsule: `total_deployed_usd` (sum of `capital_allocated_usd` where `status='live'`) ≤ `(1 - RESERVE_PCT) × total_account_usd` enforced on auto-promote.
- A capsule with loss-overlap > 0.70 sustained 7 days gets demoted from `full_live` → `degraded` automatically (allocation reduced; not killed).
- `/portfolio` page renders the correlation matrix as a heatmap; rows sortable by loss-overlap.

## 8. Safety / risk

- **All additive, never destructive**: new gates only veto; they never increase exposure beyond what existing limits allow. Companion PRD's "additive only" principle holds here too.
- **Reserve floor is hard**: governor cannot be bypassed by setting `ARENA_RESERVE_PCT=0`. Floor is enforced in code at 0.25.
- **Cluster pause is reversible**: paused-by-cluster capsules auto-resume at next UTC midnight, same as the existing daily-cap behavior. Operator manual override still works.
- **Correlation requires data**: `pnl_correlation` over <7 days of data is flagged as `low_confidence` — the governor doesn't act on it. Prevents bootstrapping false positives when a new capsule just turned live.
- **Diversity profile is operator-overridable**: inferred values get a `confidence: 'inferred'` flag; operator can edit via UI to set `confidence: 'operator_set'` (locks the value against future inference re-runs).

## 9. Operational notes

- The companion PRD (gated-decision-system) and this PRD share the `decision_journal` table — companion writes per-trade gate results, this PRD reads them for signal correlation (v2).
- This PRD's Global Risk Governor is called by the companion's `runDecisionPipeline()` as the final gate before submit. The two PRDs are tightly coupled at that integration point.
- Cluster pauses log to `evolution_log` with `event_type='cluster-killswitch-trip'` so the evolution loop can learn that a cluster failed and adjust mutation pressure toward orthogonal kinds.
