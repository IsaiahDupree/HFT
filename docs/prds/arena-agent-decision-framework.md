# PRD: Arena Agent Decision Framework

**Status:** Draft
**Author:** Isaiah Dupree
**Created:** 2026-05-25
**Owner:** PolymarketAutomation / Arena subsystem
**Related code:** `src/lib/arena/`, `src/app/arena/`, `scripts/arena-*.ts`

---

## 1. Problem statement (verbatim, from the user)

> "Agents should be deciding what patterns and strategies to use, and when to let their system use one strategy or pattern vs another, and that's what they have decision over. Software and AI both give answer for their system. Let's say if a bet is 'if BTC up or down within 5 minutes', then AI and the system learn from that, but AI alone should not be deciding if BTC up or down within 5 minutes.
>
> What data are agents pulling from? We have sources for live crypto up to a minute increments? Why don't have any active or aggressive agents? This system should be rewarding agents who make action and trade."

This PRD captures the design changes implied by that critique and breaks them into ship-able layers.

---

## 2. Background: what the arena does today

A population of `paper_agents` runs every 5 minutes (Windows scheduled task `PolymarketArenaTick`). Each agent owns a single typed `Genome` (a discriminated union over seven strategy kinds: `poly_fade_spike`, `poly_breakout`, `cb_breakout`, `cb_mean_reversion`, `cross_venue_arb`, `cb_momentum_burst`, `random_walk_baseline`). On each tick the agent's `decide()` returns one of `{entry, exit, hold}`; `applySignal` updates an in-memory bookkeeping then persists. Every `ARENA_EVOLVE_EVERY=6` ticks (30 min) the open generation is sealed, the bottom 50% by fitness gets retired, and survivors are mutated to seed the next generation.

Fitness today: `pnl_pct − 2 × max_dd_pct`. Round-trip trade count is tracked but not part of the fitness formula.

The user surfaced this problem looking at `/arena` showing 28 agents in gen 12 all at `$100.00 / 0% / 0% / 0 trades / 0 fitness`, with the same 0.0000 top-score across the prior 3 sealed generations.

---

## 3. Findings — why the page shows zeros

### 3.1 Fitness rewards inaction
A do-nothing agent scores `0`. A trading agent that breaks even scores `0`. A trading agent that loses scores `negative`. Holding forever is the local optimum, so evolution drifts toward stricter thresholds because they avoid losses. The `genome.ts` bounds were tightened twice (2026-05-25 notes in the file) because looser variants got pruned out. The system is selecting *against* activity.

### 3.2 No aggressive seeds per generation
`runEvolveOnce` mutates survivors with a 5% Gaussian perturbation. Survivors are mostly cautious, so children are mostly cautious. There is no "explorer" allocation — no agents intentionally seeded at the *low* end of bounds. The single `random_walk_baseline` has `trade_prob ≤ 0.10`, so even the control rarely fires.

### 3.3 Agent IS its strategy
Each agent today has one strategy. There is no concept of a meta-agent that picks among strategies based on regime. The user explicitly wants this — "agents should be deciding what patterns and strategies to use."

### 3.4 AI is currently not in the loop
`research-loop` (LLM proposals via Claude OAuth) exists but feeds the human-curated strategy catalogue (`strategy_versions`), not the arena. Arena `decide()` calls are deterministic rule code, no LLM. There is no place an agent says "given these readings + market state, which signal do I trust right now?"

### 3.5 Data sources are partially wired
| Source | Cadence | History on disk | Used by |
|---|---|---|---|
| `coinbase_snapshots` (REST mid/bid/ask, 5 products) | ~5 min via `worker:snapshot` | 66 rows × 4h | mean-reversion, breakout, cross-venue |
| `coinbase_candles` (1-min OHLCV, 5 products) | 5 min (last 60 candles per pass) | 467 BTC bars / ~7.7h | momentum-burst |
| `market_snapshots` (Polymarket token mid/yes/no/spread, 40 markets) | 5 min | 43 rows × 2.5h | poly_fade_spike, poly_breakout |
| `cross_venue_arbs` (BS-implied prob enrichment) | At tick time | Empty for most pairs | cross_venue_arb (currently dead) |
| `worker:realtime` WS firehose (Polymarket activity + `subscribeCryptoPrices(["btcusdt","ethusdt"])`) | Live | **Not persisted** — count logged only | none |

**Gap the user identified:** we have minute-level OHLCV. We do *not* have sub-minute data wired into anything the arena reads. The WS feed runs but explicitly skips DB persistence ("way too noisy") — its only persistent output is a heartbeat event every 30 s.

---

## 4. Goals

| # | Goal | How we measure |
|---|---|---|
| G1 | Agents that act outrank agents that do nothing, all else equal | A trading agent at 0 net PnL beats a hold-forever agent in `rankAgents` |
| G2 | Every generation has at least 25% of agents firing entries within 6 ticks | `entries_count > 0` for ≥7 of 28 agents at seal time |
| G3 | An agent can hold a portfolio of strategies and pick which one applies per tick | New `multi_strategy` genome kind that delegates to sub-strategies |
| G4 | `/arena` shows non-zero, meaningful per-agent state even in flat markets | Status column always populated (already shipped) |
| G5 | Crypto price data freshness goes from "≤5 min stale" to "≤1 min stale" | WS ticks land in a table; arena uses freshest-of(WS, snapshot, candle) |
| G6 | An LLM signal is available to multi-strategy agents as one of the sub-strategies | New `llm_oracle` strategy kind callable from `multi_strategy`, gated by env |

---

## 5. Non-goals

- **Live trading from arena agents.** The capsule activation gate stays as-is. Promoted strategies still need human approval at `/capsules`. This PRD is about the *simulation*.
- **A new evolutionary algorithm.** We keep the GA structure (rank, cull, mutate). We're changing fitness terms and the genome surface, not the search procedure.
- **Replacing the deterministic execution.** Even when AI picks a strategy, the buy/sell decision and the target/stop rules are still rule-based and reproducible. AI selects among options; it does not generate orders directly.
- **Sub-second data.** WS gives us second-cadence updates; we'll downsample to 1 second max. We are not building a tick-level book.

---

## 6. Requirements

### 6.1 Layer 1 — Incentive + Seeding fix (foundational)

The goal of this layer is to make the *existing* arena reward activity and always have aggressive agents present. No new strategy kinds.

#### R1.1 Track entries separately from round-trips
- Add `entries_count INTEGER NOT NULL DEFAULT 0` to `paper_agents`.
- `applySignal` increments it on every `entry` (in addition to writing `paper_trades` row).
- `trades_count` continues to count exits / round-trips — it's the denominator for win-rate.
- Migration: `scripts/init-db.ts` and `tests/helpers/db.ts` both add the column with `IF NOT EXISTS` semantics (SQLite: `ALTER TABLE ... ADD COLUMN` guarded by checking `pragma_table_info`).

#### R1.2 Activity bonus in fitness
- `score.ts:scoreAgent` adds: `activity_bonus = min(entries_count, 5) × 0.005` → max `+0.025` (2.5 percentage points).
- New fitness: `fitness = pnl_pct − 2 × max_dd_pct + activity_bonus`.
- Magnitude justification: a 2.5 pp bonus is smaller than typical winning-trade PnL but larger than a `0.0000` tie, so it breaks ties in favor of action without making losing-strategies profitable.
- Cap at 5 entries so a spam-clicking agent doesn't dominate purely on volume — quality still has to show up via `pnl_pct`.

#### R1.3 Zero-activity cull
- In `runEvolveOnce`, *before* `partitionSurvivors`, force any agent with `entries_count = 0` into the cull bucket with retire reason `"no-activity"`.
- Rationale: a no-activity lineage is functionally dead even if its rank tie-breaks high. Removing it stops the gene pool from accumulating cautious genomes that never act.

#### R1.4 Aggressive preset injection
- New helper `aggressivePresets(genNumber: number): Genome[]` in `src/lib/arena/seed-presets.ts` returns 4–5 hand-tuned low-threshold genomes:
  - `cb_momentum_burst` with `vel_entry_pct=0.001` (0.1%) and `accel_min=0.00005`
  - `cb_mean_reversion` with `z_entry=1.0` (mild stretch)
  - `poly_fade_spike` with `threshold_pts=3` (lower bound)
  - `random_walk_baseline` with `trade_prob=0.08` (8% per tick)
- `runEvolveOnce` calls `aggressivePresets` and inserts these into the next gen *in addition to* mutated survivors. They carry `introduced_by="preset-aggressive"` so we can group their fitness in the mutation-stats UI.
- Effect: every gen starts with guaranteed trade-firing baseline data. Cautious lineages now compete *against* known-active reference points.

### 6.2 Layer 2 — Composite meta-strategy genome

This is the "agents pick the strategy" change the user described.

#### R2.1 New genome kind `multi_strategy`
- Genome shape:
  ```ts
  const MultiStrategy = z.object({
    subs: z.array(SubGenomeSchema).min(2).max(4),  // 2-4 sub-strategies
    selection: z.enum(["priority", "first_match"]),
    entry_size_usd: num(5, 100),
  }).strict();
  ```
- `SubGenomeSchema` is a discriminated union over every existing strategy kind *except* `multi_strategy` itself (no recursion).
- A `multi_strategy` agent's decision: walk `subs` in order, ask each sub-genome's `decide()`; return the first non-hold signal. For `selection="first_match"` we take the first hit; for `selection="priority"` we still take the first but evaluate sub-genome's "would-fire intensity" (delta from threshold) and choose the strongest match instead.

#### R2.2 Mutation
- `mutate.ts:mutateProgrammatic` for `multi_strategy`:
  - 50% chance: pick one sub-genome and mutate its params using the existing per-kind mutator.
  - 25% chance: replace one sub-genome with a fresh random of a different kind.
  - 15% chance: reorder the subs (matters when `selection="priority"`).
  - 10% chance: flip `selection` mode.
- LLM mode (`mutate.ts:mutateLlm`) can propose multi-strategy genomes from scratch — the prompt already gets the genome surface; just include the new kind in the schema sent to Claude.

#### R2.3 Diagnostic
- Extend `src/lib/arena/diagnostic.ts:diagnoseAgent` to handle `multi_strategy`:
  - Run each sub-genome's diagnostic.
  - Return a label like `"3-strategy mix → mom (closest to fire)"` showing which sub is most active.

#### R2.4 Seeding
- Add one `multi_strategy` preset to `aggressivePresets()` so every gen has at least one composite agent.

### 6.3 Layer 3 — Sub-minute data plane

The user pointed out we have WS access but aren't using it. The arena ticks every 5 min, so sub-second data wouldn't directly change decision cadence; the win is in *freshness at decision time*.

#### R3.1 New table `realtime_ticks`
```sql
CREATE TABLE realtime_ticks (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,          -- e.g. 'btcusdt', 'ethusdt'
  product_id TEXT NOT NULL,      -- normalized 'BTC-USD', 'ETH-USD'
  price REAL NOT NULL,
  source TEXT NOT NULL,          -- 'poly-ws' for now
  ts_unix INTEGER NOT NULL       -- second-resolution
);
CREATE INDEX idx_realtime_ticks_product_ts ON realtime_ticks(product_id, ts_unix DESC);
```

#### R3.2 Worker writes ticks
- `worker-realtime.ts:onCryptoPrice` debounces per-symbol to **1 second** (drop intermediate ticks) and persists. Symbol → product_id mapping table: `btcusdt → BTC-USD`, `ethusdt → ETH-USD`.
- Add a daily cleanup: keep last 24h of ticks, delete older. Run inside the heartbeat interval.

#### R3.3 Arena context uses freshest price
- `buildLiveTickContext` queries `realtime_ticks` for the latest tick per product within the last 90 seconds. If found, overrides the `latest.price` in the corresponding `SnapshotWindow` (history stays from the snapshot table — we don't pollute history with WS ticks; we only update the "now" price).
- `loadRecentCandles` is unchanged — momentum still uses 1-min candles for velocity/accel math. WS only updates the *current* price for evaluation.
- Net effect: when the arena ticks at 14:30:00, instead of reading the snapshot from 14:25:00, it reads a 14:29:58 WS tick.

#### R3.4 Health visibility
- `/arena` status header shows `WS ✓ btc=Xs ago` next to the existing freshness pills. If WS feed is dead but candles are current, the header surfaces both.

### 6.4 Layer 4 — LLM oracle as a sub-strategy (future)

Out of scope for the initial ship, but designed to plug into Layer 2:

- New strategy kind `llm_oracle` whose `decide()` calls Claude via OAuth with `{recent_candles, current_price, recent_polymarket_questions}` and parses a JSON `{direction: "up"|"down"|"hold", confidence: 0..1}` response.
- The deterministic execution is still rule-based: confidence ≥ threshold + direction picks BUY/SELL, target/stop come from genome params.
- Only callable as a sub-strategy of `multi_strategy` — not a standalone genome. The composite must include at least one non-LLM strategy so the agent always has a fallback when the API quota is exhausted.
- Hard gated by `ARENA_LLM_ORACLE_ENABLED=1` env var because LLM calls are expensive — disabled by default.

---

## 7. Technical design notes

### 7.1 Schema migration order
The migrations are additive (only `ALTER TABLE ADD COLUMN` + `CREATE TABLE IF NOT EXISTS`), safe to run on existing prod DB:
1. `paper_agents.entries_count`
2. `realtime_ticks` table
3. `paper_agents.preset_origin` (optional, for tracking aggressive seeds)

### 7.2 Data flow with all layers
```
WS firehose ──┐
              ▼
       realtime_ticks ───┐
                         ▼
REST snapshots ──► coinbase_snapshots ──┐
                                        ▼
1-min candles ──► coinbase_candles ────► buildLiveTickContext ─► decide() ─► applySignal ─► paper_trades
                                        ▲                            │
                                        │                            ▼
                                        └─── (Layer 4) llm_oracle? ──┘
```

### 7.3 Backward compatibility
- Existing single-kind genomes continue to work unchanged.
- `multi_strategy` is opt-in via the genome union; no agent forced into it.
- Old `paper_agents` rows get `entries_count` defaulted to a backfill: count entries from `paper_trades` for each agent (one-shot SQL update during migration).

### 7.4 Test impact
- `tests/integration/arena-lifecycle.test.ts` — extend to verify activity bonus changes ranking.
- `tests/integration/arena-snapshot-freshness.test.ts` — add WS-fresher-than-REST case.
- New: `tests/integration/arena-multi-strategy.test.ts` — verify a composite agent fires when any of its subs would.
- New: `tests/integration/arena-aggressive-seeds.test.ts` — verify every evolve cycle injects N presets.

---

## 8. Open questions

1. **Activity bonus magnitude.** Is `0.005 per entry, capped at 5` right? Too low and it doesn't break ties; too high and a spam agent that loses every trade still ranks above quality. Open to tuning — proposal: ship with `0.005`, watch over 10 sealed gens, adjust.
2. **Should `multi_strategy` count entries from its sub-strategies separately?** For now: no, the composite agent owns the entry. Sub-genome attribution stays in `signal_rationale`.
3. **WS reconnection backoff.** If WS dies, do we fall back to snapshot prices silently or alarm? Proposal: silent fallback + heartbeat row marks WS dead so the freshness pill in the UI shows it.
4. **LLM oracle cost cap.** A 28-agent population at 5-min ticks = 8,064 LLM calls/day if every agent calls every tick. Need a per-tick global cap (e.g. only the top-ranked agent in `multi_strategy` mode calls the LLM, others use cached output for `LLM_ORACLE_CACHE_TTL_SEC`).

---

## 9. Implementation plan & sequencing

| Layer | Scope | Effort | Ships? |
|---|---|---|---|
| L1a–e | Incentive + seeds (R1.1–R1.4) | 60–90 min | YES, immediately |
| L2 | Multi-strategy genome (R2.1–R2.4) | 2–3 hr | YES, after L1 lands and 1 evolve cycle confirms incentive is working |
| L3 | WS sub-minute data plane (R3.1–R3.4) | 1–2 hr | YES, can ship in parallel with L2 |
| L4 | LLM oracle sub-strategy (R4) | 2–4 hr | Deferred — needs cost-cap design and budget approval |

---

## 10. Success criteria (revisit at first evolve after rollout)

- **G1 verified:** find an evolve cycle log where a trading agent with ≤ 0 PnL outranked a hold-forever agent. ✅ if found.
- **G2 verified:** ≥ 7 agents in a sealed gen have `entries_count > 0`. ✅ if seen.
- **G3 verified:** at least one `multi_strategy` agent fires within first 3 generations of its introduction.
- **G5 verified:** `/arena` header shows `WS ✓ btc=<2s ago`; live tick context price differs from the most recent `coinbase_snapshots` row by < 60 s.
