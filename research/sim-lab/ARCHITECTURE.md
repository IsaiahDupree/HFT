# HFT Workspace — Architecture

A clean, scalable workspace for running **many capsule-bounded trading agents** that compete in
**sim**, where an **ensemble allocator** routes capital ("capsules") to whoever proves a
risk-adjusted edge, and only **proven** agents graduate **sim → paper → live**.

It fuses two proven sources:
- **`sources/TradingBot`** ("Star Algorithm") — a real engine with an arena, **capsules**, a
  promotion gate, 25+ strategies, an agent ensemble (regime detector → Thompson-sampling bandit
  selector → performance monitor → generation tracker → LLM explainer), Alpaca broker, and a sim
  engine. ~80% of the target system already exists here.
- **`docs/blueprint/`** — the LLM-as-trader pattern reverse-engineered from 4 YouTube videos
  (capsule of money + challenge prompt + 60s heartbeat + single execution gate + `+$` scoring).

---

## The capital ladder (the spine of the system)

```
        many strategies (→100k via param grids)   +   many LLM agents (→100s)
                                  │
                                  ▼
        ┌───────────────────────────────────────────────────────┐
        │  ARENA (sim)   every agent runs on REAL replayed data  │
        │  risk-adjusted score = pnl_pct − k·max_dd_pct (+Sharpe)│
        └───────────────────────────────────────────────────────┘
                                  │  leaderboard + "why"
                                  ▼
        ┌───────────────────────────────────────────────────────┐
        │  ALLOCATOR (ensemble brain)                            │
        │  decides WHICH agents get a capsule and WHY            │
        │  (regime fit · OOS edge · correlation · diversity)     │
        └───────────────────────────────────────────────────────┘
                                  │  capsule grants
                                  ▼
        ┌───────────────────────────────────────────────────────┐
        │  PROMOTION GATE   proven over time, not one window     │
        │   SIM → PAPER → LIVE_SMALL → LIVE_SCALED               │
        │   M-style risk engine: per-order · daily-loss · halt   │
        └───────────────────────────────────────────────────────┘
                                  │
                                  ▼
                     TREASURY ledger (append-only audit: who, score, why)
```

A **Capsule** is the unit of capital + its risk envelope (max position %, max leverage, daily
loss limit, default stop, stage). Agents never see raw capital — they operate *inside* a capsule,
and the **risk gate** is the only path from an agent's intent to a fill.

---

## Module map (`core/`)

| Module | Role | Status |
|--------|------|--------|
| `marketdata.py` | Real candles (Coinbase 1m/5m/15m) + live perp mids (Hyperliquid). `CandleReplay` streams a real window with **no lookahead**. | ✅ built, runs |
| `sim_broker.py` | `SimPerpBroker` — long/short perps with leverage, fees, intrabar stop/TP, liquidation, equity curve. Fills vs **real** OHLC. | ✅ built, runs |
| `capsule.py` | `Capsule` risk envelope + `Stage` (sim→paper→live_small→live_scaled). | ✅ built |
| `risk.py` | **The single execution gate** — clamps every intent to the capsule, hard-halts on daily-loss breach. (The videos' `agent_execute.py`.) | ✅ built |
| `agents/base.py` | `TraderBrain` protocol, `TradeDecision` (intent), `MarketContext`. Brains are pluggable. | ✅ built |
| `agents/openai_trader.py` | `OpenAITraderAgent` — LLM-as-trader via OpenAI (the chosen first brain). | ✅ built, runs |
| `agents/prompts.py` | Persona + heartbeat decision prompt, adapted from the extracted video prompts. | ✅ built |
| `session.py` | `simulate()` — the one heartbeat loop used by the CLI, the evaluator, and (soon) the arena. | ✅ built, runs |
| `scoring.py` | Risk-adjusted `RunScore` (pnl%, maxDD, win-rate, Sharpe, `score = pnl_pct − 2·maxDD%`). | ✅ built |
| `treasury.py` | Append-only `ledger.jsonl` — every run + its decisions (the "why"). | ✅ built, runs |
| `strategy_factory/` | Generate 100k strategy variants from param grids over the ported families. | ⏳ next phase |
| `ensemble/arena.py` | Run N agents/strategies over many windows; build the leaderboard. | ⏳ next phase |
| `ensemble/allocator.py` | The brain that grants capsules and writes the rationale. | ⏳ next phase |
| `ensemble/promotion.py` | sim→paper→live ladder, gated on OOS performance over time. | ⏳ next phase |
| `execution/` | Real-broker adapters (Alpaca paper → Hyperliquid → Polymarket), same `TraderBrain` interface. | ⏳ when an agent earns it |

## Harness (`harness/`)

| Tool | What it does |
|------|--------------|
| `run_single_agent.py` | One agent, one capsule, one real window — the verbose proof. |
| `run_eval.py` | The same agent across many real markets → aggregate verdict (**prove it over time**). |
| `extract_prompts.py` | The video-intelligence pipeline (OpenAI vision OCR + synthesis). |
| `openai_key.py` | Loads an OpenAI key off the land from local repos (no secrets in code). |

---

## Design principles

1. **Sim before real, proof before promotion.** Nothing touches real money until it clears the
   arena and promotion gate across many out-of-sample windows. Every stage uses the *same* loop.
2. **One execution gate.** Agents emit intents; `risk.py` is the only door to a broker. This is
   what makes hundreds of agents (and eventually real capital) survivable.
3. **Real data, no mocks.** Replays are real exchange candles; LLM calls are real; P&L is computed
   from real OHLC. Honest results — including break-even — are the point.
4. **Pluggable brains, pluggable venues.** `TraderBrain` and the execution adapters are interfaces,
   so an agent proven in sim moves to paper/live without rewrites.
5. **Ensemble > hero.** Scale comes from *many* diverse agents and the allocator, not one genius
   strategy. The capsule/arena/allocator/treasury substrate is already in place.
