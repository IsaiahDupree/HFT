# HFT — Agentic Trading Workspace

Run **many capsule-bounded trading agents** that compete in **simulation** on real market data;
let an **ensemble allocator** route capital to whoever proves a risk-adjusted edge; promote only
the proven ones **sim → paper → live**. Built to start with **one agent on sim money**, prove the
loop, and scale to **hundreds of agents** and **hundreds of thousands of strategies**.

> Foundations: the **`sources/TradingBot`** ("Star Algorithm") engine (arena, capsules, promotion
> gate, agent ensemble) + the **LLM-as-trader** pattern reverse-engineered from 4 trading-agent
> videos (`docs/blueprint/`). See `ARCHITECTURE.md` and `docs/blueprint/BLUEPRINT.md`.

---

## Quickstart

```bash
# one-time: isolated env (Python 3.12+)
uv venv harness/.venv && source harness/.venv/bin/activate
uv pip install -r requirements.txt

# 1) THE single-agent proof — one OpenAI agent, $100 sim, a real BTC window, 60s heartbeat
python harness/run_single_agent.py --symbol BTC-USD --capital 100 --bars 120 --granularity 300 --heartbeat 2

# 2) Prove it OVER TIME — same agent across 5 real markets → aggregate verdict
python harness/run_eval.py --symbols BTC-USD,ETH-USD,SOL-USD,DOGE-USD,XRP-USD --granularity 300

# (re)build video intelligence from the source videos
python harness/extract_prompts.py <youtube_id>
```

No API keys to set up: market data (Coinbase candles, Hyperliquid mids) needs none, and the
OpenAI key is loaded *off the land* from local repos by `harness/openai_key.py`.

---

## What's real here (no mocks)

- **Real market data** — Coinbase 1m/5m/15m candles replayed bar-by-bar with no lookahead;
  Hyperliquid live perp mids.
- **Real model calls** — the agent decides each heartbeat via OpenAI `gpt-4o`.
- **Real sim execution** — `SimPerpBroker` computes fills, stops, liquidation, and P&L from the
  actual OHLC of each bar; every run is appended to `data/treasury/ledger.jsonl`.

## Honest first results (measured, not claimed)

The single-agent unit works end to end and is **tuning-responsive**:

| Run | Behavior | Result |
|-----|----------|--------|
| 1m candles, naive prompt | over-traded flat chop (13 round trips) | **-7.40%** — fee drag, as the videos warn |
| 5m candles, anti-churn + selectivity | 0–3 quality trades; sat out directionless tape | BTC **+1.00%** (100% win), ETH **+0.82%**, ≈ **break-even** aggregate |

**Verdict:** a single LLM-on-candles scalper is ~break-even — which is *why* the system is an
**ensemble**: run many diverse agents/strategies and let the arena + allocator fund the ones that
prove edge. The substrate for that (capsule → arena → allocator → promotion → treasury) is the
architecture; the next phase builds the arena/allocator/strategy-factory on top of the proven loop.

---

## Layout

```
core/         engine: marketdata, sim_broker, capsule, risk gate, session loop, scoring, treasury
core/agents/  pluggable brains (OpenAI LLM-trader now; Claude-Code / coded-strategy later)
harness/      runners: run_single_agent, run_eval, extract_prompts (+ openai_key loader)
docs/blueprint/  video intelligence: per-video PROMPTS.md + the unified BLUEPRINT.md
sources/      TradingBot + polymarket-agents (harvest references, gitignored)
data/         treasury ledger + run artifacts
```

## Roadmap

- [x] Clean workspace + real sim engine + risk gate + treasury
- [x] Video intelligence → blueprint (OpenAI vision OCR of 4 videos)
- [x] Single-agent sim proof + multi-window evaluator (the promotion gate)
- [ ] Port TradingBot's 25+ strategies + agent ensemble into `core/`
- [ ] `strategy_factory` → 100k variants via parameter grids
- [ ] `ensemble/arena` + `allocator` → hundreds of agents, capsule routing with rationale
- [ ] `execution/` adapters → graduate a proven agent to Alpaca paper, then live (small → scaled)
```
