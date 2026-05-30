# Blueprint → this control plane: integration map + scale plan

How the video-derived blueprint (`BLUEPRINT.md`) maps onto what this repo already has, and the
concrete next moves to reach "hundreds of thousands of strategies, hundreds of agents, and an
ensemble that decides which agents get a capsule and why."

## The good news: the substrate already exists

| Blueprint concept (from the videos) | Already in this repo |
|---|---|
| Capsule of money per agent | `src/lib/capsules/` — envelope (`max_position_pct`, `max_daily_loss_usd`, `max_open_positions`, `max_trades_per_day`, `min_seconds_between_trades`) + pure `checkOrder()` gate + REST |
| Single execution gate (`agent_execute.py`) | `src/lib/venue/ExecutionRouter` — idempotent submit + halt gate + capsule gate + risk gate; hash-chained `order_events` |
| Always-on risk / kill switch | `src/lib/risk/` — `RiskEngine.check()` (notional, daily-loss, order-rate, concentration) + `KillSwitch.haltAll()` |
| Sim → real after proven | `src/lib/stages/` — `sim → paper → live_eligible → live` ladder; `setVersionStage()` enforces it |
| Arena: who earns capital & why | `scripts/arena-{init,tick,evolve}.ts` + `src/lib/backtest/` arena-formula scoring |
| Agent that reasons with an LLM | `src/lib/agents/oracle-llm.ts` (Evaluator → research-note) + versioned `prompts/*.v1.md` |
| Agent generations / evolution | `evolution_log` + `arena:evolve` |

The blueprint is therefore **not a rebuild** — it's three additions on top of this substrate.

## What the blueprint adds (the gap)

1. **A trading agent that emits orders, not just research notes.** Today `oracle-llm` is
   research-only. The videos' core loop is an agent that takes a capsule + a heartbeat market view
   and emits a **trade intent**. That's a new `Evaluator` returning a `submit-order` verdict, driven
   by `prompts/llm-trader-persona.v1.md`. The router/risk/capsule gates already make this safe.

2. **A strategy factory → 100k.** The repo has ~6 hand-written strategies. The blueprint's edge is
   *breadth*: generate strategy_version `spec_json` rows by sweeping parameter grids over the
   existing strategy families × venues × timeframes × regimes, seed them into the arena at `stage:sim`,
   and let `arena:tick` score them. 6 families × a modest grid already crosses 10^5 variants.

3. **An allocator (the ensemble brain) — "which agents get a capsule and why."** A pass that reads
   the arena leaderboard + each version's risk-adjusted score + capsule state + cross-correlation,
   then grants/sizes/repurposes capsules with a **written rationale** logged to `evolution_log`.
   This generalizes the videos' persona-fit 1–10 scoring into capital routing.

## Concrete moves — BUILT ✅ (this is now shipped, not just planned)

```
src/lib/agents/trader-llm.ts        # ✅ Evaluator: capsule + signals -> submit-order verdict
                                    #    @anthropic-ai/sdk (OAuth-first, like oracle-llm),
                                    #    JSON-schema output, prompts/llm-trader-persona.v1.md
scripts/strategy-factory.ts         # ✅ param-grid -> 106,656 specs; --seed inserts strategy_versions
                                    #    at stage:sim (npm run strategy:factory)
src/lib/arena/allocator.ts          # ✅ leaderboard + budget -> capsule grants + rationale (pure, tested)
scripts/arena-allocate.ts           # ✅ allocator pass; dry-run, --commit logs to evolution_log
                                    #    (npm run arena:allocate)
```

Wiring still open (next): register `traderLlmEvaluator` in the research-loop dispatch so its
`submit-order` intents actually flow to the router under a sim capsule; have `strategy-factory --seed`
feed the arena tick; and let `arena-allocate --commit` optionally create/size capsules (today it audits
to `evolution_log` and leaves capsule activation as an operator action).

Promotion stays gated: a new agent/strategy only leaves `sim` after consistent risk-adjusted green
across many `arena:tick` passes — exactly the multi-window verdict the Python sim-lab already
demonstrates (`research/sim-lab/harness/run_eval.py`).

## Reference implementation (already runs)

`research/sim-lab/` is a self-contained Python proof of this whole loop on **real** market data:
one OpenAI LLM-trader → capsule → single risk gate → sim perp broker → risk-adjusted score →
multi-window promotion verdict → append-only treasury ledger. It exists to de-risk the TS port:
`core/session.py` (heartbeat loop), `core/risk.py` (the gate), `core/scoring.py` (arena formula),
`core/sim_broker.py` (fills/stops/liquidation, unit-tested). Honest measured result: a single
LLM-on-candles scalper is ~break-even (BTC +1.0%, ETH +0.82% on 5m) — which is precisely why the
**allocator across many agents** is where the edge is, not any single hero agent.

## Note on model providers
This repo's trading/research agents use **Claude** via `@anthropic-ai/sdk` (OAuth from
`~/.claude/.credentials.json`) — keep that convention for `trader-llm.ts`. The Python sim-lab uses
**OpenAI** (per the video-intelligence task that built this blueprint); that's intentional and
isolated to `research/sim-lab/`.
