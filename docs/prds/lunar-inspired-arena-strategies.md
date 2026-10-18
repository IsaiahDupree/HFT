# PRD: Lunar-Inspired Arena Strategies

**Status:** Draft
**Author:** Isaiah Dupree
**Created:** 2026-05-25
**Owner:** PolymarketAutomation / Arena subsystem
**Companion to:** `docs/prds/arena-agent-decision-framework.md` (the meta-arch PRD)
**Source article:** `docs/research/lunar-2026-03-30-mass-analysis.md` (already archived with verification annotations)

---

## 1. Why this PRD exists

The Lunar article ("I Mass-Analyzed 14,000 Polymarket Wallets With Claude") catalogues the playbook the top-0.1% of Polymarket wallets demonstrably use, plus four concrete wallet archetypes, three quant formulas, twelve open-source tools, and five behavioral bugs. The article itself is a paid promo with unverified PnL claims (see provenance notes in `lunar-2026-03-30-mass-analysis.md`), but the *patterns* — EV-filter, Quarter Kelly, Bayesian update, wallet archetypes, market making, LLM-as-probability-oracle — are real and adoptable.

This PRD turns those patterns into concrete arena genome kinds and decision-layer wiring, so our paper agents stop trading in isolation against rule-thresholds and start trading like the wallet archetypes the article identifies.

**Companion PRD** (`arena-agent-decision-framework.md`) covers the structural fixes — incentive alignment, multi-strategy meta-agent, WS sub-minute data, LLM oracle scaffolding. This PRD adds the *strategy library* that runs inside that framework.

---

## 2. What we already have (don't re-implement)

| Capability | Location | Status |
|---|---|---|
| Expected Value formula | `src/lib/quant/formulas.ts:expectedValue` | ✅ Implemented, tested |
| Quarter Kelly sizing | `src/lib/quant/formulas.ts:kellyFraction` (defaults to `fraction=0.25`, `maxFraction=0.20`) | ✅ Implemented, tested |
| Bayesian update | `src/lib/quant/formulas.ts:bayesianUpdate` + numerically-stable variant | ✅ Implemented, tested |
| Tracked wallet seeding | `scripts/seed-tracked-wallets.ts` (7 wallets including HorizonSplendidView, beachboy4, majorexploiter, CemeterySun) | ✅ Implemented |
| Wallet fingerprinting | `project_wallet_scanner.md` memory describes — fingerprint any wallet's strategy, leaderboard discovery, firehose observer | ✅ Implemented |
| Consensus detection | `resolve:tracked` → `scan:consensus` → `/consensus` UI | ✅ Implemented |

The arena agents do NOT currently use any of these. They run their own rule-based `decide()` functions and never call `expectedValue`, `kellyFraction`, or read `tracked_wallets`. That's the gap this PRD fills.

---

## 3. The wallet archetypes (from the article, distilled)

| Archetype | Wallet | Pattern | Genome equivalent |
|---|---|---|---|
| **High-freq small-edge** | HorizonSplendidView (+$4M, crypto+macro) | Many small EV-positive trades, high volume | `ev_filtered_scalper` |
| **Single-category specialist** | majorexploiter (+$2.4M, geopolitics only) | Laser focus on one Polymarket category, ignores others | `category_specialist` |
| **Market maker** | CemeterySun ($36.6M volume) | Both sides of the book, collects spread, doesn't predict | `polymarket_market_maker` |
| **Concentrated big-bet** | beachboy4 ($6.12M in one day, sports) | Few large bets in a specific event window | Don't replicate — survivorship bias signal, not edge |
| **Copy-with-filter** | implied by article | Mirror smart wallets, *filtered by category dominance* | `wallet_copy_filtered` |
| **LLM oracle** | implied by 20-line Claude brain | LLM estimates P_true → EV-filter → Kelly-size → execute | `llm_probability_oracle` |

The article also explicitly warns *against* copying without filtering (Mental Bug #4) — a wallet with 91% win rate on crypto and 15% on politics nets negative if you mirror everything. So `wallet_copy_filtered` is the right copy archetype, not naïve mirror.

---

## 4. Goals

| # | Goal | Measure |
|---|---|---|
| G1 | Arena has at least one genome of each Lunar archetype (except `beachboy4` — survivorship) | 5 new genome kinds shipped |
| G2 | Every Polymarket entry goes through an EV pre-filter (skip if `EV < 5%`) | No `paper_trades` row with `intent='entry'` and `expectedValue < 0.05` |
| G3 | Position sizing uses Quarter Kelly when `P_true` is computable | Entry `size_usd` ≤ `kellyFraction(...).betUsd` for new genomes |
| G4 | Tracked-wallet activity surfaces as signals to copy-trade genomes | `wallet_copy_filtered` agents have non-zero `entries_count` within 24h of a tracked wallet trade |
| G5 | Five mental bugs from the article are encoded as explicit guardrails | Each guardrail has a unit test asserting it triggers in the bug scenario |
| G6 | A demo `llm_probability_oracle` agent can run a paper-trading session end-to-end without manual intervention | Sealed gen log shows ≥ 1 entry from this kind |

---

## 5. Non-goals

- Replicating beachboy4's concentrated-bet pattern (survivorship bias — the article shows one winning session, not edge).
- Building a `poly-maker` clone — the article cites it, but our existing `cb_breakout`/`cb_mean_reversion` already cover spread-collection on Coinbase. The polymarket market-maker genome is a sim-only educational variant; real market-making needs the CLOB order-book primitives we don't expose yet.
- Hosting LLM agents that auto-trade. Every LLM signal goes through EV-filter + Kelly-size + capsule activation gate. AI does not place orders.
- Adopting the article's affiliate CTAs (kreo.app, Telegram bots, copytrade prompts). Already established norm in `project_research_ingestion.md`.

---

## 6. Requirements

### 6.1 R1 — Universal EV+Kelly safety wrapper

Every existing genome's `decide()` produces a `Signal` with a `size_usd`. We wrap the entry path so that, when a probability estimate is computable, EV-filter and Quarter-Kelly-size are applied *before* `applySignal`.

**Spec:**
- New module `src/lib/arena/risk-wrapper.ts` exports `applyRiskRails(signal, ctx, agent): Signal | null`.
- For Polymarket entries:
  - `P_market` = current token midpoint
  - `P_true` = whatever the genome (or a sub-genome) provides; if the genome can't produce `P_true`, the wrapper falls through and accepts the signal as-is (rule-based mode).
  - Compute `expectedValue({ pTrue, pMarket })`. If `recommendation === "SKIP"`, return `null` (genome held).
  - Compute `kellyFraction({ pTrue, pMarket, bankrollUsd: agent.cash_usd_current, fraction: 0.25 })`. Override `signal.size_usd` to `betUsd`.
- For Coinbase entries: rails are no-ops in v1 (no probability semantics on continuous-price markets). Coinbase risk shaping happens via existing target/stop params.

**Backward compatibility:** the wrapper is opt-in per genome via a `risk_rails: "off" | "ev_kelly"` flag in the genome params. Default `"off"` for existing genomes (no behavior change); new genomes default `"ev_kelly"`.

### 6.2 R2 — `category_specialist` genome (majorexploiter pattern)

A Polymarket agent that only trades inside one event category (geopolitics, elections, crypto, sports, macro). Filters market candidates by category tag before applying any sub-strategy logic.

**Spec:**
```ts
const CategorySpecialist = z.object({
  category: z.enum(["geopolitics", "elections", "crypto", "sports", "macro", "weather", "other"]),
  inner_strategy: z.enum(["fade_spike", "breakout"]),  // reuse existing per-kind logic
  threshold_pts: num(3, 15),
  entry_size_usd: num(5, 100),
  // … existing fade-spike / breakout params follow
}).strict();
```
**Dependencies:**
- `market_snapshots` needs a `category` column (currently doesn't have one). Add via:
  - Schema migration: `ALTER TABLE market_snapshots ADD COLUMN category TEXT`.
  - Snapshot worker: classify markets via slug/title keyword match (geopolitics: `["putin", "trump", "ukraine", "war", ...]`, sports: `["nfl", "nba", "soccer", ...]`, etc.). Initial rule table in `src/lib/polymarket/category.ts`.
  - Backfill: one-shot `npm run market:categorize` to label existing rows.
- `decide()` only iterates `ctx.snapshots` whose `latest.category === genome.category`.

### 6.3 R3 — `wallet_copy_filtered` genome

Mirrors a tracked wallet's trades, *filtered by the category where that wallet dominates* (article Mental Bug #4 explicitly forbids unfiltered copying).

**Spec:**
```ts
const WalletCopyFiltered = z.object({
  wallet_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  copy_category: z.enum([... same as above]),
  // Genome only fires when wallet trades a market in copy_category.
  size_pct_of_source: pct(0.001, 0.10),  // 0.1% .. 10% of the source's size
  max_size_usd: num(1, 100),
  delay_min: num(0, 30),                 // copy with delay to avoid front-running
}).strict();
```
**Dependencies:**
- `tracked_wallets` + `wallet_fills` already exist.
- `decide()` reads `wallet_fills` for `genome.wallet_address` with `tick_at > now − delay_min`.
- Filter joined `market_snapshots.category === genome.copy_category`.
- Source's win-rate by category is auditable; if win-rate < 0.55 in that category over last 30 days, the genome refuses to copy (refused signal logged as `rationale="wallet underperforming in chosen category"`).

### 6.4 R4 — `polymarket_market_maker` genome (CemeterySun pattern, sim-only)

Quotes both sides of a Polymarket token at midpoint ± spread/2, collects the spread when both fill. Sim-only because we lack live CLOB order-book primitives for real quoting.

**Spec:**
```ts
const PolyMarketMaker = z.object({
  token_id: z.string(),                  // single market, fixed
  spread_pts: num(0.5, 5),               // quote spread in points
  inventory_target: num(0, 50),          // target USD inventory
  max_inventory_usd: num(10, 500),       // hard cap; flatten if exceeded
  rebalance_z: num(1.0, 3.0),            // mean-revert toward midpoint when |skew| > z·σ
}).strict();
```
**Sim behavior:**
- Each tick: open two synthetic orders at `mid - spread/2` (buy) and `mid + spread/2` (sell).
- "Fill" probabilistically based on observed trade volume in the market_snapshot — if `volume_24h_pct_change > 0.5`, count one fill per side; else hold.
- Inventory tracked; when `|inventory_usd| > max_inventory_usd`, force-flatten via market order.
**Why sim-only:** real MM needs live CLOB order placement + cancellation, which our adapter doesn't yet support. Listed as future work in §10.

### 6.5 R5 — `llm_probability_oracle` genome (the 20-line Claude brain)

The article's centerpiece: LLM estimates `P_true` for a binary market; deterministic code computes EV, applies Quarter Kelly, executes. AI never decides direction in isolation — it provides a calibrated probability that flows through the rails.

**Spec:**
```ts
const LlmProbabilityOracle = z.object({
  model: z.enum(["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]),
  category_filter: z.enum([... same as R2]).optional(),
  min_ev_pct: pct(0.05, 0.20),           // override default 5% gate
  max_calls_per_tick: num(1, 5),         // cost cap
  prompt_version: z.string(),            // versioned prompt, hash-pinned
  cache_ttl_min: num(5, 120),
}).strict();
```
**Decision flow:**
1. Pick top-K candidate markets in `ctx.snapshots` (filtered by category if set), sorted by liquidity × |mid − 0.5| (find markets where consensus is questionable).
2. For each candidate (capped at `max_calls_per_tick`), check cache; if miss, call Claude API with the prompt template `prompts/llm-probability-oracle.<prompt_version>.md`. Parse `{probability, confidence}` JSON.
3. For each result with `confidence !== "low"`:
   - `EV = expectedValue({pTrue: probability, pMarket: midpoint})`
   - If `EV.evPerDollar < min_ev_pct`, skip.
   - Else: `size = kellyFraction({pTrue: probability, pMarket: midpoint, bankrollUsd: cash, fraction: 0.25}).betUsd`
   - Signal: entry, side = `EV.recommendation === "FADE" ? opposite : same`, size.

**Cost cap (CRITICAL):**
- `ARENA_LLM_ORACLE_ENABLED` env defaults to `0`. Genome is inert when disabled.
- Global per-day budget: `ARENA_LLM_ORACLE_DAILY_USD` (default `$5`). Tracked in a new `llm_call_log` table; if exceeded, all oracle genomes hold for the rest of the day.
- Per-tick: only the highest-fitness `llm_probability_oracle` agent makes API calls; others read from the shared cache.

**Why per-archetype prompts are pinned:** prompt drift = silent behavior change. Versioned files in `prompts/` ensure reproducibility.

### 6.6 R6 — Mental-bug guardrails

The article identifies 5 cognitive bugs. Each gets an explicit code-level guardrail with a unit test:

| Bug | Guardrail | Where |
|---|---|---|
| **Base Rate Neglect** | When LLM oracle gives `P_true > 0.95` or `< 0.05`, log it but require confirmation from a *second* signal source (another sub-strategy, or a recent tracked-wallet trade) before sizing > $10 | `risk-wrapper.ts` |
| **Sunk Cost Fallacy** | Exits ignore `entry_price`. Genomes can't reference "loss-recovery" logic. Test: a position at -50% gets exited on the same criteria as a position at +50%. | `sim.ts:decide` (already true, write the test to lock it in) |
| **Survivorship Bias** | When seeding `wallet_copy_filtered`, refuse wallets whose `claimed_profit_usd` is from a single-session event (sports-style 1-day windfalls). Filter by trade count > 100 over 30 days. | `scripts/seed-tracked-wallets.ts` validation |
| **Copying Without Filtering** | Already enforced by `wallet_copy_filtered.copy_category` requirement | R3 above |
| **Overfitting** | Replay-fitness backtest requires N ≥ 30 trades to pass gate; <30 trades = "unproven" not "good" | `replay-fitness.ts` (extend existing) |

### 6.7 R7 — Seeded archetype population

Every fresh arena init seeds 1 of each new archetype so the gene pool starts diverse:
- 1× `category_specialist` (random category)
- 1× `wallet_copy_filtered` (pointing at HorizonSplendidView with `copy_category="crypto"`)
- 1× `polymarket_market_maker` (pointing at top-liquidity poly token)
- 1× `llm_probability_oracle` (inert unless env flag enabled)

These join the existing 8 strategy kinds for an initial population of ~12 archetypes.

---

## 7. Technical design notes

### 7.1 Genome surface impact
Adding 4 new kinds expands `GENOME_KINDS` from 7 → 11. The mutation operator needs per-kind bounds for each. Genome JSON storage stays as-is (zod discriminated union just gets new variants).

### 7.2 Schema changes summary
```sql
ALTER TABLE market_snapshots ADD COLUMN category TEXT;
CREATE TABLE llm_call_log (
  id INTEGER PRIMARY KEY,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  market_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  called_at TEXT NOT NULL DEFAULT (datetime('now')),
  caller_agent_id INTEGER,
  cache_hit INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_llm_call_log_called_at ON llm_call_log(called_at DESC);
```
(Plus everything in the companion PRD.)

### 7.3 Cost model for LLM oracle
- Claude Sonnet 4.6 input: ~$3 / Mtok, output: ~$15 / Mtok.
- Per call: ~500 input tokens (prompt + market snapshot), 100 output tokens (JSON answer). ≈ $0.003 per call.
- Budget $5/day = ~1,600 calls/day. At 5-min ticks, 288 ticks/day; with 5 calls/tick max = 1,440 calls/day. Fits in budget.
- Cache hit ratio target: >70%. Cache key: `(market_id, prompt_version, hour_bucket)`.

### 7.4 Tracked-wallet ingestion latency
`wallet_fills` is updated by `scripts/backfill-wallet.ts` + `scripts/worker-realtime.ts`. Currently event-driven; copy genome `delay_min` parameter naturally accommodates a 0–30 min lag.

### 7.5 Category classifier accuracy
First-pass keyword classifier will misclassify ~5–10% of markets (e.g. "Will SpaceX launch Starship?" → "other" instead of "tech"). Acceptable for v1; iterate from real misses.

---

## 8. Open questions

1. **Where does `P_true` come from for non-LLM genomes that want to use the EV+Kelly rail?** Options: (a) genome-provided constant, (b) a calibration table per-category, (c) only LLM genomes use the rail. Lean: (c) — keep rule-based genomes rule-sized; LLM-genome gets the formula treatment.
2. **How do we know a copied wallet is "dominating" in a category?** Lookback window? 30 days seems short for low-volume traders. Need a `min_trades_in_window` threshold.
3. **Should market maker genomes get a fee discount in sim?** Real Polymarket maker rebates are 0; this is realistic. CB has maker rebates. Leave as-is.
4. **Versioned prompt rollout:** if we change `prompt-v2.md`, do old cached entries get invalidated? Yes — cache key includes `prompt_version`.

---

## 9. Implementation plan (integrated with companion PRD)

This PRD's work plugs *on top of* the companion PRD's L1–L3 layers. Recommended order:

| Phase | Source PRD | Scope | Effort |
|---|---|---|---|
| **P1** | Companion §6.1 (L1) | Incentive + seeding fix — activity bonus, zero-activity cull, aggressive presets | ~90 min |
| **P2** | This PRD §6.1 (R1) | Universal EV+Kelly risk wrapper | ~45 min |
| **P3** | This PRD §6.2 (R2) | Category schema + classifier + `category_specialist` genome | ~90 min |
| **P4** | This PRD §6.3 (R3) | `wallet_copy_filtered` genome | ~60 min |
| **P5** | Companion §6.2 (L2) | `multi_strategy` composite genome | ~2 hr |
| **P6** | This PRD §6.5 (R5) | `llm_probability_oracle` genome | ~3 hr |
| **P7** | Companion §6.3 (L3) | WS sub-minute data plane | ~2 hr |
| **P8** | This PRD §6.4 (R4) | `polymarket_market_maker` genome (sim-only) | ~90 min |
| **P9** | This PRD §6.6 (R6) | Mental-bug guardrails + tests | ~60 min |

**Total estimate: ~12–13 hours of focused work.** Best executed across 3–4 sessions so each phase ships, runs for at least one evolve cycle, and informs the next.

**Sequencing rationale:**
- P1 first because everything downstream needs an arena that rewards activity.
- P2 before any new genome that needs sizing (R1, R3, R5) — the rail must exist when the genomes that use it ship.
- P5 (`multi_strategy`) lands mid-sequence so new strategies can be composed immediately.
- P6 (LLM oracle) is last in the costed-out work because it's the most expensive to test and benefits from category metadata (P3) being live.

---

## 10. Success criteria (revisit after P5 ships)

- **G1 verified:** `paper_agents` query shows ≥ 1 row of each new kind. ✅ on insertion.
- **G2 verified:** No paper_trades row in last 24h with EV < 5% from genomes opted into rails. SQL probe ships with the migration.
- **G3 verified:** Distinct `size_usd` values for `wallet_copy_filtered` agents reflect Quarter Kelly math, not flat sizing.
- **G4 verified:** Within 24h of a tracked wallet trade in a category, ≥ 1 `wallet_copy_filtered` agent on that category has a corresponding entry.
- **G5 verified:** Unit tests for each guardrail pass; manual review confirms each guardrail blocks the bug scenario.
- **G6 verified:** With `ARENA_LLM_ORACLE_ENABLED=1` and budget unspent, a `llm_probability_oracle` agent fires at least one entry within one tick cycle.

---

## 11. Out of scope (deferred)

- **Live Polymarket market making.** Requires CLOB order-placement primitives we don't expose to the arena. Future PRD when CLOB adapter learns single-side limit orders + cancellation.
- **Live LLM agents.** This PRD is sim-only. Promotion to capsule still requires human approval per existing `/capsules` gate.
- **Tier-2 wallets** (xuanxuan008, googoogaga23) — paid promo wallets per provenance analysis; not seeded as copy targets.
- **Polysights / Insider Finder / pmxt Archive integrations.** Listed in the article but third-party services with their own auth/rate-limit considerations. Phase 2 work.

---

## 12. Provenance & ethics

This PRD's source material was paid promotional content (per `lunar-2026-03-30-mass-analysis.md` provenance notes). The wallet PnL claims in the article are **not independently verified**. We use the article for:
- ✅ Strategy archetypes (the math is real even if the wallet specifics are marketing)
- ✅ Tool catalog (verified separately in `docs/inspiration/`)
- ✅ Mental-bug enumeration (well-established trading psychology, not novel to this article)
- ❌ Performance projections (zero claims about "expected returns" — those would be reproducing the marketing)
- ❌ Affiliate flows (no integration with kreo.app, Telegram bots, etc.)

When a wallet's claimed PnL informs a seed (e.g. HorizonSplendidView in R3), it carries the `claimed_profit_usd` marker in `tracked_wallets` so the system never treats marketing as measured performance.
