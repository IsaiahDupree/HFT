# Implementation Plan: Arena Decision Framework + Lunar Strategies

**Date:** 2026-05-25
**Scope:** Combines both PRDs in one execution sequence.
**Source PRDs:**
- `arena-agent-decision-framework.md` (incentive fix + multi-strategy + WS feed)
- `lunar-inspired-arena-strategies.md` (4 new genome kinds + EV/Kelly rails)

---

## Quick reference — current state

**What already exists** (don't re-implement):
- `src/lib/quant/formulas.ts` — `expectedValue`, `kellyFraction`, `bayesianUpdate` (tested)
- `tracked_wallets` + `wallet_fills` schemas + 7 seeded wallets
- Per-agent live diagnostic on `/arena` (shipped earlier this session)
- Force-close-on-retire in `evolve.ts` (shipped earlier this session)
- All-time-top filter using EXISTS instead of trades_count (shipped earlier this session)

**What's broken** (the symptom that started this work):
- All gen-12 agents stuck at `$100 / 0% / 0 trades`. Root causes: fitness rewards inaction (no activity bonus), no aggressive seeds per gen, agents are single-strategy with no AI in the loop.

---

## The plan — 9 phases, ~13 hours of focused work

Each phase is independently shippable, has its own task IDs (#7 onward, already created), and ends with verification on `/arena` before moving to the next.

### Phase 1 — Incentive + seeding fix (~90 min) · Tasks #7–#11

**Goal:** Make the arena reward activity. Without this, every new genome we add will just learn to do nothing.

| Sub-task | File(s) | Change |
|---|---|---|
| #7  L1a | `scripts/init-db.ts`, `tests/helpers/db.ts`, migration helper | `ALTER TABLE paper_agents ADD COLUMN entries_count INTEGER NOT NULL DEFAULT 0` + one-shot backfill from `paper_trades` |
| #8  L1b | `src/lib/arena/sim.ts`, `src/lib/arena/types.ts`, `src/lib/arena/db.ts` | Increment `agent.entries_count` in `applySignal` entry branch; persist + load |
| #9  L1c | `src/lib/arena/score.ts` | `activity_bonus = min(entries_count, 5) × 0.005` added to fitness |
| #10 L1d | `src/lib/arena/evolve.ts` | Force `entries_count === 0` agents into cull bucket with reason `"no-activity"` |
| #11 L1e | `src/lib/arena/seed-presets.ts` (new), `src/lib/arena/evolve.ts` | `aggressivePresets(genNumber)` returns 4 low-threshold genomes; inject into every new gen |

**Verify:** After 1 evolve cycle post-deploy, `/arena` shows ≥ 1 agent with `entries_count > 0`. Sealed gen log shows `top_score > 0` (or at least non-zero from the activity bonus on the best active agent).

### Phase 2 — EV+Kelly risk wrapper (~45 min)

**Goal:** Centralize the math from the Lunar article so every Polymarket entry that has a `P_true` estimate goes through `expectedValue` and `kellyFraction`.

| Sub-task | File(s) | Change |
|---|---|---|
| P2.1 | `src/lib/arena/risk-wrapper.ts` (new) | `applyRiskRails(signal, ctx, agent)` returns null (skip) or modified Signal (Kelly-sized) |
| P2.2 | `src/lib/arena/genome.ts` | Add optional `risk_rails: "off" \| "ev_kelly"` to every kind, default `"off"` for existing |
| P2.3 | `src/lib/arena/sim.ts:applySignal` | Call `applyRiskRails` for entry signals; honor the rail's decision |
| P2.4 | `tests/integration/arena-risk-wrapper.test.ts` (new) | Verify EV < 5% → skip; Kelly-size override; backward compat for `risk_rails: "off"` |

**Verify:** A test agent with `risk_rails: "ev_kelly"` and a synthetic `P_true = 0.6` against `P_market = 0.55` (EV = 5%, borderline) sizes correctly via Quarter Kelly.

### Phase 3 — Category schema + `category_specialist` genome (~90 min)

**Goal:** Implement the majorexploiter archetype — laser-focused single-category trader.

| Sub-task | File(s) | Change |
|---|---|---|
| P3.1 | Migration | `ALTER TABLE market_snapshots ADD COLUMN category TEXT` |
| P3.2 | `src/lib/polymarket/category.ts` (new) | Keyword classifier: `classifyMarket(slug, question) → Category` |
| P3.3 | `scripts/snapshot-worker.ts` | Populate `category` column on insert |
| P3.4 | `scripts/categorize-markets.ts` (new) + `npm run market:categorize` | One-shot backfill |
| P3.5 | `src/lib/arena/genome.ts` | Add `CategorySpecialist` to discriminated union |
| P3.6 | `src/lib/arena/sim.ts` | `decideCategorySpecialist` filters `ctx.snapshots` by category then delegates to fade-spike or breakout |
| P3.7 | `src/lib/arena/diagnostic.ts` | Status label shows `category=geopolitics, candidates=N` |

**Verify:** A `category_specialist(category="elections")` agent's diagnostic shows only election markets in its candidate count.

### Phase 4 — `wallet_copy_filtered` genome (~60 min)

**Goal:** Mirror tracked wallets, filtered by their category dominance.

| Sub-task | File(s) | Change |
|---|---|---|
| P4.1 | `src/lib/arena/genome.ts` | Add `WalletCopyFiltered` |
| P4.2 | `src/lib/arena/sim.ts` | `decideWalletCopyFiltered` reads `wallet_fills WHERE address=? AND tick_at > now - delay_min` joined with `market_snapshots.category = ?` |
| P4.3 | `src/lib/wallet/category-stats.ts` (new) | `walletWinRateByCategory(address, days)` |
| P4.4 | `src/lib/arena/diagnostic.ts` | Status label shows `following=HorizonSplendidView · cat=crypto · win_rate=0.71` |

**Verify:** Pre-seed a `wallet_fills` row for tracked wallet, run tick, agent should fire if category matches and win-rate gate passes.

### Phase 5 — Multi-strategy composite genome (~2 hr)

**Goal:** The "agents pick the strategy" change. Composite agent with 2–4 sub-genomes; tick walks subs in order and returns first non-hold.

| Sub-task | File(s) | Change |
|---|---|---|
| P5.1 | `src/lib/arena/genome.ts` | `SubGenomeSchema` (existing kinds minus `multi_strategy`); `MultiStrategy` with `subs[]`, `selection`, `entry_size_usd` |
| P5.2 | `src/lib/arena/sim.ts` | `decideMultiStrategy` iterates `subs`, calls sub-decide via dispatcher, returns first non-hold signal |
| P5.3 | `src/lib/arena/mutate.ts` | 50% perturb-sub / 25% replace-sub / 15% reorder / 10% flip selection mode |
| P5.4 | `src/lib/arena/diagnostic.ts` | Aggregate sub-diagnostics; surface the closest-to-fire sub |
| P5.5 | `tests/integration/arena-multi-strategy.test.ts` (new) | Composite of mean-rev + momentum fires when either sub would |

**Verify:** Seal one gen; mutation cohort UI (`/arena/mutations`) shows composite-vs-single fitness comparison.

### Phase 6 — `llm_probability_oracle` genome (~3 hr)

**Goal:** The 20-line Claude brain — AI estimates `P_true`, rule-based code executes. Inert by default (`ARENA_LLM_ORACLE_ENABLED=0`).

| Sub-task | File(s) | Change |
|---|---|---|
| P6.1 | Migration | `llm_call_log` table |
| P6.2 | `prompts/llm-probability-oracle.v1.md` (new) | Versioned prompt template; matches article's framing (calibrated, base-rate-aware) |
| P6.3 | `src/lib/arena/llm-oracle.ts` (new) | Calls Claude API; returns `{probability, confidence}`; caches by (market_id, prompt_version, hour) |
| P6.4 | `src/lib/arena/llm-oracle-budget.ts` (new) | Daily budget guard; refuses calls when budget exhausted |
| P6.5 | `src/lib/arena/genome.ts` | `LlmProbabilityOracle` genome |
| P6.6 | `src/lib/arena/sim.ts` | `decideLlmProbabilityOracle` picks K markets, calls oracle, runs EV+Kelly rail, returns signal |
| P6.7 | Diagnostic | Status: `last_call=12s ago · p_true=0.62 · ev=4.1% · budget=$3.20/$5.00` |

**Verify:** With env enabled and budget unspent, the oracle agent makes ≥ 1 entry per tick when EV-positive markets exist.

### Phase 7 — WS sub-minute data plane (~2 hr)

**Goal:** Use the existing WS feed for sub-minute price freshness.

| Sub-task | File(s) | Change |
|---|---|---|
| P7.1 | Migration | `realtime_ticks` table + index |
| P7.2 | `scripts/worker-realtime.ts` | Debounce WS crypto ticks to 1/sec/symbol; persist; daily cleanup keeps last 24h |
| P7.3 | `src/lib/arena/context.ts` | `buildLiveTickContext` reads `realtime_ticks` for last 90s; overrides `latest.price` in matching `SnapshotWindow` |
| P7.4 | `src/app/arena/page.tsx` header | New pill: `WS ✓ btc=Xs ago` (red if > 60s stale) |

**Verify:** Start `worker:realtime`, then ticks land in DB; arena context shows fresher prices than `coinbase_snapshots` alone.

### Phase 8 — `polymarket_market_maker` sim-only (~90 min)

**Goal:** CemeterySun archetype as a sim-only agent. Quotes both sides at midpoint ± spread/2, collects spread.

| Sub-task | File(s) | Change |
|---|---|---|
| P8.1 | `src/lib/arena/genome.ts` | `PolyMarketMaker` |
| P8.2 | `src/lib/arena/sim.ts` | `decidePolyMarketMaker` opens 2 synthetic positions; uses volume_24h_pct_change as fill proxy; flattens on inventory cap |
| P8.3 | `src/lib/arena/diagnostic.ts` | Status: `inventory=$23 (cap $50) · spread=2pts · vol_today=$1.2M` |

**Verify:** Sim-MM agent shows non-zero `entries_count` after 2 ticks on a high-volume poly token.

### Phase 9 — Mental-bug guardrails (~60 min)

**Goal:** Encode the 5 bugs from the article as test-asserted code-level guardrails.

| Sub-task | File(s) | Change |
|---|---|---|
| P9.1 | `tests/unit/sim-no-sunk-cost.test.ts` (new) | Asserts exits at -50% use same criteria as exits at +50% |
| P9.2 | `src/lib/arena/risk-wrapper.ts` | Extreme-probability guard: `P_true > 0.95 or < 0.05` requires second signal source or size ≤ $10 |
| P9.3 | `scripts/seed-tracked-wallets.ts` | Validation: refuse wallets with < 100 trades / 30 days |
| P9.4 | `src/lib/arena/replay-fitness.ts` | Already requires N ≥ 30 trades — add explicit test |
| P9.5 | `tests/unit/guardrails.test.ts` (new) | One test per bug, asserts the guardrail triggers |

**Verify:** All guardrail tests pass; manual review confirms each scenario is blocked.

---

## Verification cadence

After each phase ships, before starting the next:
1. Run `npx vitest run tests/integration/arena` (must stay green).
2. Run `npm run arena:tick` once and watch the log — confirm agents of the new kind are alive and acting.
3. Refresh `/arena` — confirm the Status column and new columns render.
4. Wait one evolve cycle (~30 min) and inspect the sealed gen's `top_score` + which kind won.

**Failure mode escape hatch:** every phase is a separate commit. If a phase causes the arena to crash, `git revert` that commit; prior phases keep running.

---

## What you'll see on `/arena` when this is done

- Status column shows live readings for 11 strategy kinds + composite multi-strategy
- A `category` pill on each poly market in the diagnostic context
- "WS ✓ btc=2s ago" header pill
- All-time top agents includes wallet-copy + LLM oracle entries
- Mutation cohort comparison: aggressive presets vs evolved survivors vs LLM oracle
- Capsule activation gate still requires human approval — nothing auto-promotes to live

---

## Open questions to resolve before P6 ships

1. **LLM oracle daily budget cap** — start at $5/day or $1/day? Recommend $1 until cache hit ratio measured.
2. **Prompt v1 wording** — base it on the article's example, but tune for `caplaiton-prompt-engineering` best practices (XML tags, examples, fallback). Need a draft + review.
3. **Tracked wallet `claimed_profit_usd` vs measured** — should the gating filter on measured PnL only? Lunar's wallets have `claimed_profit_usd` set but `actual_profit_usd` not yet computed for all of them.

These can be resolved in their respective PR reviews; nothing in P1–P5 depends on them.

---

## Memo: what NOT to do

Per `project_research_ingestion.md` guidance, even though the Lunar article inspired this work, we are NOT adopting:
- Affiliate flows (kreo.app, Telegram bots, copytrade calls)
- "20-line script that prints money" framing — we have a venue router + capsule + stage pipeline; the right surface for production
- Marketing performance claims as test fixtures — `claimed_profit_usd` stays distinct from measured PnL
- The `polymarket-copy-trading-bot` repo (per the article's own malware-incident note from Dec 2025)
