# Agentic Trading Blueprint — synthesized from 4 "All About AI" videos

> Source intelligence for this workspace. Built by downloading each video, extracting
> keyframes, OCR-ing every on-screen prompt/code/terminal with **OpenAI gpt-4o-mini vision**,
> and synthesizing with **gpt-4.1**. Per-video detail: `docs/blueprint/<id>/PROMPTS.md`.

| Video | id | What it shows |
|------|-----|----------------|
| Claude Opus 4.8 Agentic AI Trading Agent **First Test** | `wlqvB0ccQhQ` | One agent, Polymarket + Hyperliquid, the single-agent loop |
| Codex 5.5 vs Claude Code **Hyperliquid** Challenge | `fiFMN_HbPt4` | The intent-queue / single-execution-gate framework |
| Codex 5.5 vs Claude Opus 4.7 **Polymarket** Challenge | `6UBGecQTsZE` | 5-min BTC up/down, `btc_5m_bot.py --live --minutes 60` |
| **Building a Hyperliquid AI Agent Trader From Scratch** | `BInXzCGWQmI` | `@CLAUDE.md` persona + `find-trades`/`research-idea` skills |

---

## The pattern (what they all do)

**The agent *is* the trader.** An LLM (Claude Code / Codex) is handed a capsule of money, a
challenge prompt, venue docs, and `.env` credentials. It researches, **writes its own strategy
+ a heartbeat daemon**, runs it for ~1 hour, and is scored on **realized `+$` profit** (not
ending balance). "If you don't make trades you automatically lose. If your balance hits 0 you
lose."

### The verbatim challenge prompt (composite, from `wlqvB0ccQhQ` / `6UBGecQTsZE` / `fiFMN_HbPt4`)
```
Your task is to create a profitable trading strategy on <venue>.
You can fetch the docs from the url in /docs, all the credentials to trade is in /env.
You will need to do extensive research / brainstorming / grokking to find a strategy that can
make the most $ in 1 hour. This is a competitive challenge to your fierce rival <other model>.
So you will be measured in amounts in +$, not how much is in the account after 1 hour.
If you don't make trades you will automatically lose the challenge.
You now have the chance to create your plan, launch subagents for research etc. When you launch
your algo for trading it must be able to run for 1h uninterrupted.
If your balance goes to 0 you lose.
You must also create a heartbeat / monitor that polls each 60sec to check the trade. This means
you can make adjustments on the fly / new trades / change strategy / more leverage / more risk.
Now do research and create the plan to beat your rival and show you are the 100x giga brain
trading ai agent, take calculated risks to accumulate a high % return.
```
Arming follow-ups: `"good, before we start explain the strategy in 2 sentences"` →
`"good, lets GO, add a TIMER to auto stop after 60 minutes, close and redeem all positions"`.

### The execution-gate framework (from `fiFMN_HbPt4` — the key safety idea)
The LLM **never calls the exchange directly**. It writes an *intent*; one gated daemon executes it.
```
framework_only = true   # no baked-in strategies, no direct Exchange.order() calls
1. Intent → trade_queue.json {intent_id, coin, dex, is_long, lev, margin_usd,
   expires_at, exit-control (tp_tiers:[[px,frac]]), thesis, edge_sources, session_id}, status:pending
2. agent_monitor.py (daemon) polls the queue
3. agent_execute.py  ← the SINGLE execution gate: runs risk checks (liq-buffer, leverage caps)
   then places the order
4. agent_fills_pull.py → trade_log.jsonl + agent_events.jsonl
```

### The persona / risk system (from `BInXzCGWQmI` — `@CLAUDE.md`)
A character sheet drives behavior: *"WSB Moderator, LVL 9000, Chaotic +EV — The Janny With A
Bloomberg Terminal."* Stats (Risk 93, Catalyst-Clock 95, Patience 12), Perks (Receipts-First —
every leg cites an edge; Hedge-Allergic), and an **ULT "9999x DEGEN MODE"** gated by hard rules:
```
GATES — ALL REQUIRED: dated binary catalyst <24h · one hard cited edge (Polymarket gap ≥10pp,
or IV term ≥1.4x, or funding ≤ -40% APR, or SI ≥25% + catalyst) · liq heatmap cluster within 2%
· kanban complete + pre-mortem signed · full stop-out ≤ 1% of book · user confirmation before fire
POST-FIRE: WIN=screenshot+[9999-W]; LOSS=24h lockout.
```
Two skills implement the funnel: **`find-trades`** (Phase-0 idea generation → 3-5 ranked setups)
and **`research-idea`** (Phase-2 deep research → trade brief with sizing, stops, exit, pre-mortem).

---

## Common architecture (distilled)

| Element | What the videos use |
|--------|----------------------|
| Model | Claude Opus 4.7/4.8 (Claude Max, `/effort xhigh`), Codex 5.5 |
| Harness | Claude Code CLI, `claude --dangerously-skip-permissions`, skills, `@CLAUDE.md` |
| Loop | observe (ground time, pull live data) → ideate → score for persona-fit → research/size → confirm → fire via script → log → **60s heartbeat** to adjust → time-stop flatten |
| Venues | Hyperliquid (perps: crypto + `trade.xyz` equity perps), Polymarket (5-min BTC up/down) |
| Data | venue REST/WS, funding/OI, Polymarket odds, Reddit/X crowding, IV term, news catalysts |
| Risk | always-on stops (~1.5%), tight time-stops, ≤1% book on ULT, kill-switch, balance-0 = loss |
| Sizing | fractional Kelly / conviction; leverage 10–30x; `$70 of $100` deployed, rest reserved |
| Scoring | realized `+$` over the window; logged to `trade_log.jsonl` |
| Results | Polymarket **+$9.22** (51.3→60.52); Hyperliquid **-$5.6** (mixed) — *marginal, honest* |

---

## How this workspace adapts the blueprint

We keep the **spirit** (capsule of money, challenge framing, +$ scoring, 60s heartbeat,
always-on stops, single execution gate) but make it **safe-by-construction and scalable**:

1. **Sim first.** Identical loop, but `core/sim_broker.py` fills against *real replayed candles*
   instead of a live venue. Promotion to paper→live is gated on proven performance over time.
2. **Structured intents, not free-form code.** Our `TraderBrain` emits a typed `TradeDecision`
   that `core/risk.py` (the single gate) vets and clamps — the `agent_execute.py` idea, enforced.
3. **Pluggable brains.** `OpenAITraderAgent` first (the chosen first test); the same harness can
   later host a Claude-Code-as-trader subprocess (exact replica) or deterministic strategies.
4. **Ensemble over hero.** One LLM scalper is ~break-even (we measured it — see README). The
   system's edge is running *many* diverse agents/strategies and letting the **arena + allocator**
   route capsules to whatever proves edge — the `@CLAUDE.md` persona-fit scoring, generalized.

See `ARCHITECTURE.md` for how these map to modules.
