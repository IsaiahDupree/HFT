# Implementation Plan — Gated Decision System + Capsule Portfolio Governance + Selective Micro-Edges

**Date:** 2026-05-27, extended 2026-05-28
**Source PRDs:**
- `docs/prd/gated-decision-system-2026-05-27.md` (per-trade decision gating)
- `docs/prd/capsule-portfolio-governance-2026-05-27.md` (portfolio-level diversification)
- `docs/prd/selective-micro-edges-2026-05-28.md` (edge discovery + calibration)

**Sequencing principle:** **additive only**. The live trading system stays up the whole time. Every phase ships independently; if phase N+1 misbehaves, rolling back phase N+1 leaves N working.

**Three workstreams, one plan:**
- Phases 1–5 ship the per-trade decision pipeline (gated decision system PRD) — DONE
- Phases 6–11 ship the capsule portfolio governance layer — DONE
- Phases 12–15 ship selective micro-edges + calibration (this extension)
- They share infrastructure (`decision_journal`) but can be developed in parallel.

---

## Quick reference — what we're NOT rebuilding

These exist and don't change in this plan (only get wrapped):

- `src/lib/risk/engine.ts` — `RiskEngine.check()` (pre-trade global risk)
- `src/lib/capsules/gate.ts` — `checkOrder()` (per-capsule)
- `src/lib/capsules/circuit-breaker.ts` — consecutive-error auto-pause
- `src/lib/stages/gate.ts` — release-stage gate
- `src/lib/arena/risk-budget.ts` — dimensionless risk derivation
- `src/lib/polymarket/execute.ts` — broker-error detection, price clamping
- Per-strategy detectors in `src/lib/strategies/` — fee + edge math stays inside each detector

The pipeline calls these; their behavior is unchanged.

---

## Phases — 5 phases, ~12–16 hours of focused work

### Phase 1 — Foundation: types, envelope, audit log (~3 hours)

**Goal:** stand up the `DecisionContext` / `GateResult` types and the `decision_journal` table. No behavior change to live trading yet — just observability infrastructure.

| Sub-task | File(s) | Change |
|---|---|---|
| 1.1 | `src/lib/decision/types.ts` (new) | Export `GateAction`, `GateResult`, `DecisionContext`, `DecisionResult` types per PRD §5.1 |
| 1.2 | `src/lib/db/schema.sql` + migration helper | Add `decision_journal` table per PRD §5.4 |
| 1.3 | `src/lib/decision/journal.ts` (new) | `recordDecision(result, ctx)` writes one row |
| 1.4 | `tests/unit/decision-types.test.ts` (new) | Type-level + journal write round-trip tests |

**Verification:** `npx vitest run tests/unit/decision-types.test.ts` green. `SELECT * FROM decision_journal LIMIT 1` returns the dummy row inserted by the test.

**Rollback:** `DROP TABLE decision_journal;` — no other code path touches it yet.

---

### Phase 2 — Pipeline orchestrator + gate-wrapping (~4 hours)

**Goal:** ship `runDecisionPipeline()` that wraps every existing gate. Pipeline runs in **shadow mode** — its result is journaled but the real trade path still uses the legacy gates.

| Sub-task | File(s) | Change |
|---|---|---|
| 2.1 | `src/lib/decision/pipeline.ts` (new) | `runDecisionPipeline(ctx)` orchestrator. Walks gates in order: data-quality → market-eligibility → regime → signal → edge → risk → execution. Short-circuits on `KILL_SWITCH` or non-overridable `REJECT`. Returns `DecisionResult`. |
| 2.2 | `src/lib/decision/gates/risk.ts` (new) | Thin wrapper: calls existing `RiskEngine.check()` + `checkOrder()` + circuit-breaker, returns `GateResult` |
| 2.3 | `src/lib/decision/gates/edge.ts` (new) | Wrapper: extracts `edge`, `feeBps` from the strategy's opportunity object → `GateResult` |
| 2.4 | `src/lib/decision/gates/market-eligibility.ts` (new) | Wrapper: liquidity + spread checks → `GateResult` |
| 2.5 | `src/lib/decision/gates/data-quality.ts` (new) | Stub for v1 — always returns `pass, score=1.0` (placeholder; v2 expands) |
| 2.6 | `src/lib/decision/gates/regime.ts` (new, **the only NEW gate logic**) | `classifyRegime(snapshot)` — efficiency over last 5min + vol percentile vs 24h. Returns `{ regime, confidence, vol_state }`. Strategies declare `regimes: string[]`; gate scores 1.0 on match, 0.4 on mismatch, 0 on `news_shock` (always reject). |
| 2.7 | `src/lib/decision/score.ts` (new) | Weighted sum per PRD §2: `score = 0.15·data + 0.10·market + 0.15·regime + 0.20·signal + 0.20·edge + 0.15·risk + 0.05·execution`. Bands → `decision` enum. |
| 2.8 | `src/lib/arena/live-capsule.ts` | **Shadow-mode integration**: after constructing the order but BEFORE submit, call `runDecisionPipeline()` and journal the result. Do NOT use the result to modify behavior yet. Env-gated by `DECISION_PIPELINE_SHADOW=1`. |
| 2.9 | Tests | `tests/unit/decision-pipeline.test.ts` (weighted score math, kill-switch short-circuit, every gate's wrapper returns valid GateResult), `tests/unit/regime-classifier.test.ts` (synthetic trending/chop/breakout ticks) |

**Verification:** With shadow mode on, run an arena tick; `decision_journal` has new rows; no live-trading behavior change observed (orders submitted same as before). `/decisions` UI not yet built — verify by direct SQL query.

**Rollback:** Set `DECISION_PIPELINE_SHADOW=0` — live-capsule skips the pipeline call entirely.

---

### Phase 3 — Sizing modulator + active enforcement (~2 hours)

**Goal:** flip the pipeline from shadow mode to active. The `approval_score` now modulates trade size + can REJECT.

| Sub-task | File(s) | Change |
|---|---|---|
| 3.1 | `src/lib/arena/live-capsule.ts` | When `DECISION_PIPELINE_ENABLED=1`: use `result.size_multiplier` as a multiplicative clamp on top of existing `MAX_TRADE_USD` + capsule-available clamps. If `result.decision === "REJECTED"`, return early (no submit). If `WATCHLIST`, submit as paper-only. |
| 3.2 | `src/lib/arena/live-capsule.ts` | Defensive: if pipeline throws or returns malformed result, fall back to legacy path (log warning to evolution_log). Pipeline failure ≠ trade failure. |
| 3.3 | Tests | `tests/integration/decision-pipeline-live.test.ts`: pipeline approves → trade fires at full size; pipeline reduces → trade fires at reduced size; pipeline rejects → no trade + journal row |

**Verification:** Flip `DECISION_PIPELINE_ENABLED=1` on staging-like config (e.g. one live capsule). Run arena tick. Observe that trades with low regime-fit get reduced sizing; observe that all decisions land in `decision_journal`. Roll forward to all capsules.

**Rollback:** `DECISION_PIPELINE_ENABLED=0` reverts to legacy path. Pipeline still runs in shadow mode (still journals) if `DECISION_PIPELINE_SHADOW=1`.

---

### Phase 4 — `/decisions` UI (~2 hours)

**Goal:** operator-visible audit log so "why didn't we trade X?" is answerable from the UI.

| Sub-task | File(s) | Change |
|---|---|---|
| 4.1 | `src/app/decisions/page.tsx` (new) | Server component, last 50 decisions, filterable by `decision` and `strategy_kind`. Each row shows: ts, capsule, strategy, decision, score, top-failing gate + reason. |
| 4.2 | `src/app/api/decisions/route.ts` (new) | JSON endpoint backing the page (for live refresh + CSV export). |
| 4.3 | `src/components/NavMenu.tsx` | Add `/decisions` link. |
| 4.4 | `tests/ui/decisions.spec.ts` (new) | Playwright: page loads, renders ≥1 row when journal has rows, filter narrows results. |

**Verification:** Visit `/decisions`, see real decisions from phase 3 trading. Filter to `REJECTED` and confirm failing-gate reasons render.

**Rollback:** delete the route — pipeline still functions without UI.

---

### Phase 5 — Strategy-level regime declarations + rollout (~1 hour)

**Goal:** every existing strategy declares its preferred regimes so the regime gate has something to match against. Without this, every strategy gets a neutral regime score and the gate is effectively a no-op.

| Sub-task | File(s) | Change |
|---|---|---|
| 5.1 | `scripts/seed-strategies-gen2.ts` | Add `regimes` array to each gen-2 strategy's `initialSpec`: NRS = `["any"]`, CTS = `["trending"]`, OBI = `["any"]`, drift-midwindow = `["trending", "breakout"]`, hydra = `["any"]`. |
| 5.2 | `scripts/seed-strategies.ts` (gen-1) | Add `regimes` to each gen-1 kind. `poly_short_binary_directional` = `["trending", "breakout"]`; `polymarket_market_maker` = `["chop", "low_vol"]`; etc. |
| 5.3 | `src/lib/decision/gates/regime.ts` | Read `regimes` from the strategy_version spec_json; if missing, default to `["any"]` (regime score = 1.0). |
| 5.4 | Tests | `tests/unit/regime-classifier-strategy-fit.test.ts`: verify each kind's declared regimes get matched on synthetic snapshots. |

**Verification:** Run `db:seed:gen2` + `db:seed`. Confirm every strategy's spec_json now has a `regimes` field. Re-run an arena tick and observe regime gate emitting non-trivial scores (some 1.0, some 0.4).

**Rollback:** `regimes` field is additive — old code that doesn't read it is unaffected.

---

---

# Workstream B — Capsule Portfolio Governance

Phases 6–11 implement the capsule portfolio governance PRD. They build on Phase 1's `decision_journal` infrastructure but otherwise can run in parallel with Phases 2–5.

### Phase 6 — Capsule diversity profile (~2 hours)

**Goal:** stamp every capsule with `strategy_family`, `asset_class`, `time_horizon`, `regime_dependency`, `directional_bias`. Pure metadata — no behavior change.

| Sub-task | File(s) | Change |
|---|---|---|
| 6.1 | `src/lib/db/schema.sql` + migration helper | Add columns per PRD §4.1 (additive `ALTER TABLE`, all NULL-safe defaults) |
| 6.2 | `src/lib/capsules/types.ts` | Add `DiversityProfile` type + fields on `Capsule` |
| 6.3 | `scripts/infer-capsule-diversity.ts` (new) | One-shot: walks live + paused capsules; infers profile from bound `agent.kind`; writes columns. Idempotent — re-running updates only NULL columns unless `--force`. |
| 6.4 | `src/app/arena/page.tsx` | Surface diversity-profile chips on each capsule card |
| 6.5 | Tests | `tests/unit/capsule-diversity-inference.test.ts`: verify each known kind → expected profile mapping |

**Verification:** `SELECT id, strategy_family, asset_class FROM capsules WHERE status IN ('live','paused')` shows non-NULL for all rows. `/arena` shows the new chips.

**Rollback:** Columns are nullable + un-indexed; ignored by existing code.

---

### Phase 7 — Correlation engine + daily worker (~3 hours)

**Goal:** compute and persist daily PnL / asset / strategy-family correlation matrices across live capsules. No veto power yet — observability only.

| Sub-task | File(s) | Change |
|---|---|---|
| 7.1 | `src/lib/db/schema.sql` | Add `capsule_correlations` table: `(id, snapshot_date, capsule_a, capsule_b, pnl_corr, asset_overlap, loss_overlap, drawdown_overlap, sample_days, verdict, created_at)` |
| 7.2 | `src/lib/portfolio/correlation.ts` (new) | Pure module: Pearson PnL corr, Jaccard asset overlap, joint-loss frequency, joint-drawdown frequency. Inputs are arrays of daily PnL; module is testable without DB. |
| 7.3 | `src/lib/portfolio/loss-overlap.ts` (new) | `lossOverlapScore(capsuleId, otherCapsules, windowDays)` — mean P(other_lost \| this_lost) over window |
| 7.4 | `scripts/worker-portfolio-snapshot.ts` (new) | Daily worker (runs at UTC midnight via scheduler): writes a row per capsule pair to `capsule_correlations`; writes per-capsule `loss_overlap_score` to a new `capsule_diagnostics` table |
| 7.5 | Tests | `tests/unit/correlation-math.test.ts` (Pearson + Jaccard math), `tests/unit/loss-overlap.test.ts` (synthetic 30-day PnL streams) |

**Verification:** Run worker manually; `SELECT * FROM capsule_correlations ORDER BY snapshot_date DESC LIMIT 10` shows recent pairs. Loss-overlap for the 3 current live capsules (all same kind) should be very high (>0.70) — sanity check that the metric detects today's lack of diversification.

**Rollback:** Stop the worker; tables stay (harmless).

---

### Phase 8 — Cluster kill switches (~2 hours)

**Goal:** add veto layer above per-capsule daily-cap. Strategy-family and asset-class clusters get their own pause thresholds.

| Sub-task | File(s) | Change |
|---|---|---|
| 8.1 | `src/lib/portfolio/cluster-killswitch.ts` (new) | `checkClusters(liveCapsules, ts)` walks each cluster (group-by strategy_family, group-by asset_class); aggregates `daily_pnl_usd`; if cluster sum < `-cluster.threshold`, returns capsule IDs to pause |
| 8.2 | `src/lib/arena/evolve.ts` | At each gen-seal: call `checkClusters()`, apply pauses, log to `evolution_log` with `event_type='cluster-killswitch-trip'` |
| 8.3 | `.env.local` (operator) | New env: `CLUSTER_KILLSWITCH_STRATEGY_FAMILY_PCT=0.04`, `CLUSTER_KILLSWITCH_ASSET_CLASS_PCT=0.06`, `GLOBAL_RISK_OFF_PCT=0.05`, `GLOBAL_KILLSWITCH_PCT=0.10` (defaults from PRD §4.4) |
| 8.4 | Tests | `tests/unit/cluster-killswitch.test.ts`: 3 same-family capsules each lose 1.5% → cluster sum 4.5% → expect all 3 paused. Asymmetric: 2 capsules one family, 1 capsule other family → only matching family pauses. |

**Verification:** Manual test: in dev DB, set `daily_pnl_usd` for 3 same-family capsules to total > 4% threshold; run `arena:tick`; observe all 3 status changes to `paused` with cluster reason in `evolution_log`.

**Rollback:** Set all `CLUSTER_KILLSWITCH_*_PCT=1.0` to effectively disable.

---

### Phase 9 — Global Risk Governor (~3 hours)

**Goal:** portfolio-level veto layer above per-trade gates. Same-trade collision detection + correlated-exposure caps + strategy-family caps + reserve floor.

| Sub-task | File(s) | Change |
|---|---|---|
| 9.1 | `src/lib/portfolio/governor.ts` (new) | `checkPortfolioImpact(proposal, liveCapsules)` returns `{ ok, reason, cap_size_usd?, action }`. Implements PRD §4.5 rules: same-trade collision, correlated-exposure cap, strategy-family cap, reserve floor. |
| 9.2 | `src/lib/decision/pipeline.ts` (already exists post-Phase 2) | Add governor as the final gate before submit. Gate result feeds the approval-score weighted sum (new weight `0.10` for governor; rebalance others). |
| 9.3 | `.env.local` | `MAX_CORRELATED_EXPOSURE_PCT=0.30`, `MAX_STRATEGY_FAMILY_EXPOSURE_PCT=0.25`, `ARENA_RESERVE_PCT=0.50` |
| 9.4 | `src/app/api/portfolio/exposure/route.ts` (new) | JSON endpoint returns current exposure breakdown by asset, direction, strategy family |
| 9.5 | Tests | `tests/unit/portfolio-governor.test.ts`: same-trade collision; correlated-exposure cap; strategy-family cap; reserve floor (hard); reserve floor cannot be zeroed out |

**Verification:** Simulated test from PRD §7: capsule A long BTC $5 already filled; capsule B tries long BTC $5 → governor flags as same-trade collision, caps B at $0 (since A already at single-trade cap). Live observation: `/portfolio` exposure endpoint returns current breakdown.

**Rollback:** `DECISION_PIPELINE_ENABLED=0` skips the pipeline (and the governor). Governor module remains but is unreachable.

---

### Phase 10 — Capsule lifecycle stages + correlation-aware promotion (~2 hours)

**Goal:** extend `capsules.status` lifecycle. Auto-promote uses correlation as a veto.

| Sub-task | File(s) | Change |
|---|---|---|
| 10.1 | `src/lib/db/schema.sql` + migration | `capsules.status` allowed values expanded: `idea | backtest | paper | micro_live | probation_live | full_live | degraded | frozen | retired | reserve`. Backfill: existing `live` → `full_live`, existing `paper` stays `paper`, existing `paused` stays `paused`. |
| 10.2 | `src/lib/arena/auto-promote.ts` | When picking new live elites: read `capsule_correlations` for proposed agent's strategy_family; if any pair would have predicted `pnl_corr > 0.55` with existing live, skip. Promotion ladder: a new capsule starts `paper` → `micro_live` (smallest size) → `probation_live` → `full_live` based on trade count + correlation + drawdown thresholds. |
| 10.3 | `src/lib/portfolio/lifecycle.ts` (new) | `checkPromotion(capsule)` and `checkDemotion(capsule)` rules per PRD §4.6. Hooks into `arena:tick`. |
| 10.4 | `.env.local` | `LIFECYCLE_MIN_TRADES_MICRO=5`, `LIFECYCLE_MIN_TRADES_PROBATION=20`, `LIFECYCLE_MAX_CORR_PROMOTE=0.55`, `LIFECYCLE_LOSS_OVERLAP_DEMOTE=0.70` |
| 10.5 | Tests | `tests/unit/capsule-lifecycle.test.ts`: promotion path, demotion on loss-overlap breach, correlation veto blocks promotion |

**Verification:** Run `arena:tick` with one new high-correlation candidate elite; verify it stays `paper` instead of being auto-promoted. Manually demote one current `full_live` capsule; verify allocation decreases.

**Rollback:** New stages are accepted aliases; existing code reading `status='live'` still works against `full_live` via a backward-compatibility view (`CREATE VIEW capsules_legacy AS SELECT ... WHERE status IN ('live','full_live','probation_live','micro_live')`).

---

### Phase 11 — Reserve capsule + `/portfolio` UI (~2 hours)

**Goal:** make the reserve un-deployable; ship operator-visible correlation matrix.

| Sub-task | File(s) | Change |
|---|---|---|
| 11.1 | `scripts/init-reserve-capsule.ts` (new) | Seeds one row with `status='reserve'`, `strategy_family='reserve'`, `capital_allocated_usd = ARENA_RESERVE_PCT × total_account_usd`. Idempotent (re-runs update only if `--force`). |
| 11.2 | `src/lib/portfolio/governor.ts` | Hard rule: any proposal where `capsule.strategy_family === 'reserve'` returns REJECT immediately, before any other check. |
| 11.3 | `src/app/portfolio/page.tsx` (new) | Server component. Correlation matrix heatmap (rows + cols = live capsules; cell = `pnl_corr`). Side panel: loss-overlap rank, exposure breakdown by asset + family, reserve %. |
| 11.4 | `src/app/api/portfolio/correlations/route.ts` (new) | JSON endpoint for the matrix |
| 11.5 | `src/components/NavMenu.tsx` | Add `/portfolio` link |
| 11.6 | Tests | `tests/ui/portfolio.spec.ts` (Playwright): page loads, matrix renders, sort-by-loss-overlap works |

**Verification:** Visit `/portfolio`, see today's 3 live capsules with their pair correlations + loss-overlap scores. Reserve % displayed prominently. Test reserve-floor enforcement: attempt to manually set a capsule's capital to push total_deployed above (1 − reserve_pct); governor rejects.

**Rollback:** Reserve capsule status can be set to `retired` via SQL if it ever blocks legitimate flow. Recommended: don't.

---

---

# Workstream C — Selective Micro-Edges (added 2026-05-28)

Phases 12–15 implement the selective-micro-edges PRD. Edge discovery + calibration on top of the gating + governance infrastructure from workstreams A + B.

### Phase 12 — Complement-sum arbitrage scanner (~3 hours)

**Goal:** mechanical arbitrage when `Up_ask + Down_ask < $1`. Cleanest new edge; doesn't require any predictive model.

| Sub-task | File(s) | Change |
|---|---|---|
| 12.1 | `src/lib/strategies/complement-sum-arb.ts` (new) | Pure detector. Input: `BinaryBookSnapshot` (conditionId, up/down best-ask + depth). Output: `ComplementArbOpportunity` with profit/pair, max_pairs, time-to-resolve. |
| 12.2 | `scripts/scan-complement-sum.ts` (new) | Polls Polymarket binaries, calls detector, persists to `evolution_log` with `event_type='complement-sum-opportunity'`. Dedup by conditionId + day-bucket. |
| 12.3 | `scripts/worker-complement-sum-exec.ts` (new) | Gated executor. ATOMIC two-leg fill: place Up + Down orders; on partial-fill retry up to N times; on persistent partial, unwind. `COMPLEMENT_ARB_LIVE=1` env to arm. |
| 12.4 | Tests | `tests/unit/complement-sum-arb.test.ts`: combined cost above/at/below 1.0; fees clipping; insufficient depth → max_pairs=0; invalid prices return null; time-to-resolve filter. |
| 12.5 | Seed | Add `complement-sum-arbiter` gen-2 agent to `scripts/seed-strategies-gen2.ts`. |

**Verification:** Run `npm run scan:complement-sum` — outputs opportunity rows when combined-cost dips below 0.97. Run executor in sim mode against synthetic snapshots; verify atomic unwind on partial-fill.

**Rollback:** `COMPLEMENT_ARB_LIVE=0` → scanner still surfaces opportunities to `/opportunities` UI, no live execution.

---

### Phase 13 — Calibration tracker (~2 hours)

**Goal:** measure whether journaled decision scores predict realized outcomes. Bucket by approval_score band, compute win-rate per bucket, surface on `/calibration`.

| Sub-task | File(s) | Change |
|---|---|---|
| 13.1 | `src/lib/decision/calibration.ts` (new) | Pure module: `bucketDecisions(rows, bins?)` → `[{ lo, hi, n, wins, win_rate, expected_rate, calibration_error }]`. Maps decision_journal rows to outcomes via paper_trades / live fill resolution. |
| 13.2 | `src/app/calibration/page.tsx` (new) | Renders calibration table + reliability diagram (per-bucket actual vs expected win-rate). Filter by strategy_kind + capsule. |
| 13.3 | `src/app/api/calibration/route.ts` (new) | JSON endpoint backing the page. |
| 13.4 | `src/components/NavMenu.tsx` | Add `/calibration` under Capsules group. |
| 13.5 | Tests | `tests/unit/calibration.test.ts`: synthetic decision-rows + outcomes → expected bucket stats. |

**Verification:** Wait 24h after Phase 12 + shadow mode running. Visit `/calibration`. Look for buckets with `calibration_error > 0.10` — those are bands where the score is dishonest and the bucketing in `score.ts` needs tuning.

**Rollback:** delete the route — calibration math doesn't affect live trades.

---

### Phase 14 — Independent-signals agreement gate (~2 hours)

**Goal:** wire the `signal_agreement` weight slot in `DEFAULT_GATE_WEIGHTS` (already 0.15) to an actual gate. Counts UNIQUE INFORMATION CLUSTERS, not raw signal count. Implements the operator's "5 agents looking at one Markov signal are not 5 independent edges" principle.

| Sub-task | File(s) | Change |
|---|---|---|
| 14.1 | `src/lib/decision/gates/signal-agreement.ts` (new) | Pure gate. Input: `ctx.proposal.metadata.signals[]` — each tagged with `cluster` (one of: `price-action`, `volatility`, `microstructure`, `cross-venue`, `smart-money`, `event`). Output: 5+ clusters agree → score 1.0; 3-4 → 0.7 + REDUCE; ≤2 → 0.3 + REDUCE; hard conflict → REJECT. |
| 14.2 | `src/lib/decision/pipeline.ts` | Insert signal-agreement gate between regime + edge. |
| 14.3 | Strategy updates | Existing strategy detectors (NRS, CTS, midwindow, OBI, consensus) emit their primary signal cluster + direction so the gate has data to aggregate. |
| 14.4 | Tests | `tests/unit/signal-agreement.test.ts`: 5 same-cluster signals → counted as 1 vote; 5 distinct-cluster signals → full agreement; conflicting strong signals → reject. |

**Verification:** Decision journal entries after Phase 14 ships should show non-trivial signal_agreement scores. Strategies that previously fired alone now see their pipeline result depend on whether OTHER independent clusters agree.

**Rollback:** Set gate weight to 0 in env override; or remove from pipeline.

---

### Phase 15 — Slippage-aware edge gate + vol-scalp detector (~3 hours)

**Goal:** make the existing `edge` gate honest by subtracting expected slippage from the model edge. Ship vol-scalp as a research-only detector for v1.

| Sub-task | File(s) | Change |
|---|---|---|
| 15.1 | `src/lib/decision/slippage.ts` (new) | Pure: `estimateExecutionPrice(sizeUsd, orderBookL2)` → volume-weighted expected fill. Returns midpoint + impact_bps. |
| 15.2 | `src/lib/decision/gates.ts` `edgeGate()` | When `ctx.snapshot.orderBook` present, call slippage estimator + subtract impact from net edge before threshold check. |
| 15.3 | `src/lib/strategies/vol-scalp.ts` (new) | Pure detector for straddle setups: signals when realized 2-min vol < entry premium AND time-remaining ≥ MIN_HOLD. Returns ScalpOpportunity with expected payoff. |
| 15.4 | `scripts/backtest-vol-scalp.ts` (new) | Replays BTC/ETH candles + (synthetic mid-prices for Up/Down) to validate the thesis. |
| 15.5 | Tests | `tests/unit/slippage.test.ts` (thick + thin book) + `tests/unit/vol-scalp.test.ts` (detector triggers + filters). |

**Verification:** Decision journal `gate_results_json` for an `edge` gate now includes `details.impact_bps`. Vol-scalp backtest reports hit-rate; v1 ships as research-only signal source.

**Rollback:** edge gate falls back to current behavior when `ctx.snapshot.orderBook` absent. Vol-scalp script is a one-shot, no live trading impact.

---

## Deferred to v2 (not in this plan)

| What | Why deferred |
|---|---|
| Cross-strategy ensemble (gate 5) | Only valuable when ≥2 strategies fire on the same market simultaneously; today's mix is mostly disjoint by market. |
| Unified data-quality gate (gate 1) | Current scattered staleness checks are sufficient for v1. Builds out when we add multi-source price feeds. |
| Thesis-invalidation framework (gate 10) | 5m binaries auto-exit at window close; NRS holds to resolution. Little room for active mid-trade management today. |
| Decision-quality scoring (gate 12 extension) | Needs `decision_journal` populated for several weeks before there's signal to learn from. |
| Real Polymarket historical prices for backtests | Separate research workstream — not gate-related. |
| Signal correlation between capsules | Needs `decision_journal` (Phase 1) to be populated for weeks. v2. |
| Stress-test harness (drawdown replays) | Separate workstream after correlation engine ships. |
| Bayesian capsule allocator (Markowitz-style) | Useful at 8+ live capsules. We have 3. Premature. |
| Hedge generation (force hedge before exposure) | v3. Needs reliable inverse-asset markets. |
| News/sentiment regime detector | Requires external data source. Separate research. |

---

## Time + sequencing summary

**Workstream A — Per-trade decision pipeline:**

| Phase | Hours | Status after phase | Operator value |
|---|---|---|---|
| 1 | 3 | Decision-journal table exists; types defined. No live behavior change. | Foundation only |
| 2 | 4 | Pipeline runs in shadow mode, journals every "would-have-decided". Regime classifier ships. | Observability: see every rejected trade |
| 3 | 2 | Pipeline actively modulates size + can reject. | Real diversification — bad-regime strategies get reduced sizing automatically |
| 4 | 2 | `/decisions` UI live. | "Why didn't we trade X?" answerable in 5 seconds |
| 5 | 1 | Every strategy has declared regimes. | Regime gate becomes meaningful (not no-op) |

**Workstream B — Capsule portfolio governance:**

| Phase | Hours | Status after phase | Operator value |
|---|---|---|---|
| 6 | 2 | Every capsule has diversity profile (strategy family, asset, regime). | System knows when capsules are similar |
| 7 | 3 | Correlation engine + daily worker. `capsule_correlations` + `loss_overlap_score` populate. | "Are these capsules truly diversified?" answerable |
| 8 | 2 | Cluster kill switches active. | One bad day for a strategy family no longer takes down all same-family capsules independently |
| 9 | 3 | Global Risk Governor enforces same-trade collision + correlated-exposure caps + reserve floor. | Portfolio-level veto — no more "5 agents all long BTC" |
| 10 | 2 | Lifecycle stages + correlation-aware promotion. | New capsules can't auto-promote into already-saturated correlation slots |
| 11 | 2 | Reserve capsule un-deployable; `/portfolio` UI live. | Always-on survival floor + operator sees the whole portfolio in one view |

**Workstream C — Selective micro-edges:**

| Phase | Hours | Status after phase | Operator value |
|---|---|---|---|
| 12 | 3 | Complement-sum scanner + executor (sim default; live with env arm). | First mechanical (non-predictive) edge in the system |
| 13 | 2 | Calibration tracker + `/calibration` UI. | Honest answer to "do 87%-confidence trades actually win 87%?" |
| 14 | 2 | Independent-signals agreement gate wired. | Filters out trades where 5 correlated signals masquerade as 5 votes |
| 15 | 3 | Slippage-aware edge gate + vol-scalp research detector. | Edge gate stops counting top-of-book mid as the fill price |

**Total: 36 hours** across all three workstreams (12 + 14 + 10). Workstreams A + B are DONE (26h). Workstream C (Phases 12–15, 10h) is the remaining work.

**Recommended sequencing for Workstream C:**
1. **Phase 13 first** (calibration tracker) — cheapest, read-only, immediately useful: lets you see whether the existing shadow-mode decisions are well-calibrated before building anything else.
2. **Phase 12** (complement-sum arb) — cleanest new edge. Mechanical, doesn't depend on any model. If filled at viable prices, it's profitable in isolation.
3. **Phase 14** (independent-signals gate) — turns existing infrastructure into a real ensemble.
4. **Phase 15** (slippage + vol-scalp) — makes the edge gate honest; ships vol-scalp research-only.

**Done sequencing (for reference):**
1. ✅ Phase 1 (foundation)
2. ✅ Phase 6 (diversity profile)
3. ✅ Phase 2 (shadow pipeline + regime)
4. ✅ Phase 7 (correlation engine)
5. ✅ Phase 4 (decisions UI)
6. ✅ Phase 5 (regime declarations backfill)
7. ✅ Phase 8 (cluster kill switches)
8. ✅ Phase 9 (Global Risk Governor)
9. ✅ Phase 11 (reserve + portfolio UI)
10. ✅ Phase 10 (lifecycle + correlation-aware promote)
11. ✅ Phase 3 (active enforcement wiring — env-gated)

## Pre-flight checklist before phase 3 (flipping active)

Do not flip `DECISION_PIPELINE_ENABLED=1` until:

1. Shadow mode has run for ≥24h with ≥10 real journaled decisions.
2. Audit `decision_journal`: no decision has `approval_score = NaN` or empty `gate_results_json`.
3. Manually inspect 5 random `REJECTED` rows — every rejection reason is sensible.
4. Manually inspect 5 random `APPROVED_FULL` rows — none would obviously have been bad trades.
5. Capsule daily-cap + circuit-breaker are still operative (run `apply-risk-budget.ts` immediately before flipping).
6. `RISK_STAKE_USD` is still at the operator-chosen low value ($2) so even a misbehaving pipeline can't cost much.
