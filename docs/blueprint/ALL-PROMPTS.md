# All verbatim prompts — 4 agentic-trading videos

> Every AI prompt, skill, and persona spec read **directly off the screen** of the 4 "All About AI" videos (OpenAI gpt-4o-mini vision OCR → gpt-4.1 synthesis). Verbatim as shown; `[partially visible]` marks frames where text was cut off. Full per-video detail incl. architecture/risk/results is in each `<id>/PROMPTS.md`.

| # | Video | Venue | Len | id |
|---|-------|-------|-----|----|
| 1 | Claude Opus 4.8 Agentic AI Trading Agent — First Test | Polymarket 5-min BTC + Hyperliquid perps | 10:31 | `wlqvB0ccQhQ` |
| 2 | Codex 5.5 vs Claude Opus 4.7 — Polymarket Trading Challenge | Polymarket 5-min BTC up/down | 14:45 | `6UBGecQTsZE` |
| 3 | Codex 5.5 vs Claude Code — Hyperliquid Trading Challenge | Hyperliquid + trade.xyz perps | 11:37 | `fiFMN_HbPt4` |
| 4 | Building a Hyperliquid AI Agent Trader From Scratch | Hyperliquid perps via Claude Code skills | 23:04 | `BInXzCGWQmI` |

---

# 1. Claude Opus 4.8 Agentic AI Trading Agent — First Test

**id:** `wlqvB0ccQhQ` · **venue:** Polymarket 5-min BTC + Hyperliquid perps · **length:** 10:31 · [watch](https://www.youtube.com/watch?v=wlqvB0ccQhQ) · full detail: [`wlqvB0ccQhQ/PROMPTS.md`](wlqvB0ccQhQ/PROMPTS.md)

### System/Task Prompts

#### Polymarket (BTC 5-min up/down)
```
Your task is to create a profitable trading strategy on the
Polymarket 5 Min BTC trades up / down.
You can fetch the docs from the url in /docs, all the credentials
to trade is in /env.

You will need to do extensive research / brainstorming / grokking
to find a strategy that can make the most $ in 1 hour. This is a
competitive challenge to your fierce rival OpenAI 5.5 model. So u
will be measured in amounts in +$, not how much is in the account
after 1 hour.

If you don’t make trades you will automatically lose the challenge.

You now have the chance to create your plan, launch subagents for
research etc. When you launch your algo for trading it must be able
to run for 1h uninterrupted.

If your balance goes to 0 you lose.

You must also create a heartbeat / monitor that polls each 60sec to check the trade,
This means u can make adjustments on the fly / new trades / change strategy /
More leverage / more risk etc etc. basically this is what make this Agentic AI Trading

Now do research and create the plan to beat your rival and to show
that you are the 100x giga brain trading ai agent, take calculated
risks to accumulate a high % return
```

#### Hyperliquid (XYZ trades)
```
We are doing a challenge today on Hyperliquid.

The challenge is a duel between you and OpenAI Codex 5.5
to see who can make the most amount of $$$ in
1 hour trading on Hyperliquid.

You will both get a starting budget of $100, this is max risk / margin. 
You will get leverage etc.

The marked you can operate in is the XZY trades, we will steer clear of
Crypto market in this challenge.

You will be given 15 minutes max for research before start,
but you can setup a monitor to cancel /
change / alter / make new trades on the fly at all time, choose your in.

There are WS available.

You must also create a heartbeat / monitor that polls each 60sec to check the trade,
This means u can make adjustments on the fly / new trades / change strategy /
More leverage / more risk etc.
```

#### (Alternate/Shorter Polymarket prompt, seen in other frames)
```
Your task is to create a profitable trade on 
Polymarket 5 min BTC trades up / down.
You can fetch the docs from the url in /env.
You will need to do extensive research to find a strategy that can make the most competitive challenge to your fierce rival. You will be measured in amounts in +$, not after 1 hour.

If you don’t make trades you will automatically lose.

You now have the chance to create your plan, research etc. When you launch your algo to run for 1h uninterrupted.

If your balance goes to 0 you lose.

You must also create a heartbeat / monitor that polls each 60sec to check the trade. This means u can make adjustments on the fly / new trades / change strategy / etc. More leverage / more risk etc. basically this is what makes this fun.

Now do research and create the plan to be that you are the 100x giga brain trading risks to accumulate a high % return.

We are doing a challenge today on Hyperliquid.
The challenge is a duel between you and OpenAI Codex 5.5 too see who can make the most amount of $$$ in 1 hour trading on Hyperliquid.

You will both get a starting budget of $100, this is max risk / margin. You are ofc free to use leverage etc.

The marked you can operate in is the XZY trades, we will steer clear of the Crypto market in this challenge.

You will be given 15 minutes max for research before start, but you can setup a monitor to cancel / change / alter / make new trades on the fly at all time, choose your intervals for this.

There are WS available.

So your task now as the big brain 100x trader is to research a strategy. You will start with, ground time in a bash date/time command.
```

#### (Another variant, Polymarket)
```
Your task is to create a profitable trading strategy on the Polymarket 5 Min BTC trades up / down.

You can fetch the docs from the url in /docs, all the credentials to trade is in /env.

You will need to do extensive research / brainstorming / grokking to find a strategy that can make the most $ in 1 hour. This is a competitive challenge to your fierce rival OpenAI 5.5 model. So u will be measured in amounts in +$, not how much is in the account after 1 hour.

If you don’t make trades you will automatically lose the challenge.

You now have the chance to create your plan, launch subagents for research etc. When you launch your algo for trading it must be able to run for 1h uninterrupted.

If your balance goes to 0 you lose.

You must also create a heartbeat / monitor that polls each 60sec to check the trade, This means u can make adjustments on the fly / new trades / change strategy / More leverage / more risk etc etc. basically this is what make this Agentic AI Trading

Now do research and create the plan to beat your rival and to show that you are the 100x giga brain trading ai agent, take calculated risks to accumulate a high % return
```

### Follow-up/Instruction Prompts

#### "Explain the strategy in 2 sentences"
```
good, before we start explain the strategy in 2 sentences
```

#### "GO" and timer
```
good, lets GO, add a TIMER to auto stop after 60 minutes, close and redeem all positions
```

---


---

# 2. Codex 5.5 vs Claude Opus 4.7 — Polymarket Trading Challenge

**id:** `6UBGecQTsZE` · **venue:** Polymarket 5-min BTC up/down · **length:** 14:45 · [watch](https://www.youtube.com/watch?v=6UBGecQTsZE) · full detail: [`6UBGecQTsZE/PROMPTS.md`](6UBGecQTsZE/PROMPTS.md)

### System/Agent Role Prompt

**(from f_0066.jpg, f_0073.jpg, f_0096.jpg, f_0104.jpg, f_0108.jpg, f_0109.jpg — all variants are nearly identical; below is the most complete version):**

```
Your task is to create a profitable trading strategy on the
Polymarket 5 Min BTC trades up / down.
You can fetch the docs from the url /docs, all the credentials
to trade is in /env.

You will need to do extensive research / brainstorming / grokking
to find a strategy that can make the most $ in 1 hour. This is a
competitive challenge to your fierce rival Claude Code on Opus
their 4.7 model. So u will be measured in amounts in +$, not how
much is in the account after 1 hour.

If you don’t make trades you will automatically lose the challenge.
You now have the chance to create your plan, launch subagents for
research etc. When you launch your algo for trading it must be able
to run for 1h uninterrupted.

If your balance goes to 0 you lose.

Now do research and create your plan, launch subagents for
research etc. When you launch your algo for trading it must be able
to run for 1h uninterrupted.

If your balance goes to 0 you lose.

Now do research and create the plan to beat your rival and to show
that you are the 100x giga brain trading ai agent
```

**(from f_0109.jpg, with additional agent self-talk):**
```
I'll start by examining the provided resources — the docs URL and credentials.
```

### Plan Confirmation / Implementation Prompt

**(from f_0121.jpg, f_0127.jpg):**
```
4. Launch: ./venv/bin/python btc_5m_bot.py --live --minutes 60 -- 
runs autonomously, uninterrupted, 
handling ~12 windows. Tail bot.log for live P&L.

Risk / failure handling

- Per-window try/except + WS auto-reconnect → a single error or 
disconnect skips that window, loop continues.
- Ruin floor (halt < $8) protects against the $0 auto-loss.
- If py-clob-client-v2 API differs from documented (it was 
summarized, not source-verified), I read the 
installed source to get exact method/arg names before the live 
trade - no guessing on the order path.

Claude has written up a plan and is ready to execute. Would you 
like to proceed?

1) Yes, and bypass permissions
2) Yes, manually approve edits
3) No, refine with Ultralpon on Claude Code on the web
4) Tell Claude what to change
shift+tab to approve with this feedback

## Assumptions
- Current verified EOA gas is 20.0000 MATIC.
- Deposit pUSD is approximately $50.02, but actual 
startup balance overrides this.
- Trading is permitted only if Polymarket geoblock/API 
preflight allows it.
- The challenge objective is realized/marked profit over 
the next 1 hour, not long-term bankroll maximization.

Implement this plan?

1. Yes, implement this plan
2. Yes, clear context and 
3. No, stay in Plan mode

Press enter to confirm →
```

### Strategy Explanation Prompt

**(from f_0133.jpg):**
```
first explain your strategy to beat Claude in simple terms

- The strategy is: don’t try to predict Bitcoin generally. Predict the exact Polymarket settlement source faster and more cleanly than the market.

These BTC 5-minute markets settle from Chainlink BTC/USD:
- Up wins if Chainlink's end price is greater than or equal to the start price.
- Down wins if it is lower.

So the bot watches Chainlink BTC/USD live, captures the window start price, then constantly asks:

“Given where Chainlink is now, how much time is left, and how volatile BTC is, what is the real probability Up wins?”

Then it compares that real probability to Polymarket prices.

Example:
- Bot estimates Up has a 70% chance.
- Polymarket lets us buy Up at 58c.
- That is roughly 12c of gross edge.
- If the edge survives fees/spread/safety buffer, the bot buys.
```

### UI Build Prompt

**(from f_0188.jpg, f_0189.jpg):**
```
Good, now create a UI that keeps track of your trading in REAL TIME, shows the balance, Win %. Etc
Not too complicated but easy to keep track of the progress, also have a 1H countdown

A own field for PNL inside the 1 hour, dark mode theme, press to start, use @openaipng logo

Build the UI
```

---


---

# 3. Codex 5.5 vs Claude Code — Hyperliquid Trading Challenge

**id:** `fiFMN_HbPt4` · **venue:** Hyperliquid + trade.xyz perps · **length:** 11:37 · [watch](https://www.youtube.com/watch?v=fiFMN_HbPt4) · full detail: [`fiFMN_HbPt4/PROMPTS.md`](fiFMN_HbPt4/PROMPTS.md)

### Challenge Prompt (shown in multiple frames)
```
We are doing a challenge today on Hyperliquid.

The challenge is a duel between you and Claude Code Opus 4.7 to see who can make the most amount of $$$ in 1 hour trading on Hyperliquid.

You will both get a starting budget of $100, this is max risk / margin. You are ofc free to use leverage etc.

The marked you can operate in is the XZY trades, we will steer clear of the Crypto market in this challenge.

You will be given 15 minutes max for research before start, but you can setup a monitor to cancel / change / alter / make new trades on the fly at all time, choose your intervals for this.

There are WS available.

So your task now as the big brain 100x trader is to research a strategy you will start with, ground time in a bash date/time command. Feel free to browse web etc for data you think will help you.

Start planning out your strategy now and create a plan
```

### System/Framework Prompts (from agent console)
```
Hyperliquid vs. xyz market:
- Native HL perps go through the standard Exchange(wallet, MAINNET_API_URL, account_address=master).
- trade.xyz builder perps use Exchange(..., perp_dexs=["xyz"]) - HIP-3 dex abstraction means main perp collateral covers xyz: orders, no separate transfer dex.
- In an intent, you switch venues by setting dex to "hl" (or whatever the native key is) vs. "xyz"; coin symbols in xyz are prefixed (xyz:TICKER) when the SDK builds the other.

Important framework rules I'll follow here:
- framework_only = true - I will not add baked-in strategies, autonomous scanners, or direct Exchange.order() calls. WS/REST detections are telemetry only.
- Strategy ideas come from outside (you, an agent, /find-trades, /research-idea, /trade_420) and land as intents.
- Memory notes I'm carrying: fade-the-crowd is the #1 edge source, and weekend crypto leverage capped ≤5x because the 3% liq-buffer can false-fire on bad mark ticks.

What do you want to do - queue an intent, inspect current state/positions, run a scan, or something else?
```

### Agent Recap/Ready Prompts
```
we have a challenge, ready to recieve instructions?
Ready. Go ahead.
recap: We're operating the Hyperliquid/trade.xyz framework and you're about to brief me on a challenge. Next action: send the challenge instructions so I can start. (disable recaps in /config)
```

### Execution Path Description (Codex's own summary)
```
Execution path (the only allowed one for real trades):
1. An explicit intent gets written to trade_queue.json with status: "pending", the required fields (intent_id, coin, dex, is_long, lev, margin_usd, expires_at, an exit control, thesis, edge_sources, session_id).
2. agent_monitor.py (daemon) polls the queue.
3. agent_execute.py is the single execution gate — runs risk checks (incl. the liq-buffer / leverage caps) and places the order via the Hyperliquid SDK.
4. Fills/positions get tracked via agent_fills_pull.py, logged to trade_log.jsonl and agent_events.jsonl.
```

### Intent Schema/Rules (from HL_trade.md and agent's memory)
```
- Never call Exchange.order() directly
- dex: "xyz" for xyz:SP500, xyz:BRENTOIL, etc.
- Required: intent_id, coin, dex, is_long, lev, margin_usd, status, expires_at, thesis, edge_sources, at least one exit control
- tp_tiers format is [[price, fraction], ...]
```

### Operational Checklist (Codex's own plan)
```
Going-live checklist re-confirmed:
1. ✅ Mode flip: STAND_DOWN -> HUNT + bump daily_target_usd so we don't auto-stand-down on profit + set account_value_sod to real perp balance so the loss-limit calc is sane
2. ✅ Intent schema understood (single-leg, tp_tiers: [[px, frac]])
3. ✅ Drop interval to 10s for the hour
4. ✅ Kill-switch staged
5. ✅ Trade A/B/C drafted, ready to flip draft -> pending
```

### Trade Plan (Codex's plan, summarized)
```
Trade A - xyz:BRENTOIL crowded-long fade (headline trade)
- Funding APR +39.19% - most crowded long on the entire xyz board
- Brent already +2.13% on the day = market has priced in "hot energy PCE"
- Sell-the-news asymmetry: cool PCE = oil dumps on dovish risk-on; hot PCE → already priced, no follow-through, long-squeeze unwinds
- Buffett doctrine v (memory: "fade the crowd's positioning, not the research conclusion")
- Stop $7 (1.9% adverse), TP $20 (5% favorable) – 2.85:1 R:R
- Vol-anchored: $98 Brent = $1.86 stop distance

Trade B - xyz:XYZ100 PCE reaction fade ($316M 24h vol, 30x cap, 25x for safety)
- Fired only after PCE direction is clear (T+60-90s observation window)
- If indices spike up >0.4% in 60s = SHORT (fade overreaction to cool print)
- If indices dump 0.4% in 60s > LONG (fade overreaction to hot print)
- 25x lev leaves 4% liq buffer = wick-proof per the daemon false-fire memory
- Stop $20, TP $40-60 (2:1-3:1 R:R)
- This is the highest-gamma slot of the day

Trade C - Open crowded-long fade (kicker)
- xyz:MRVL fund APR +72.57% (most extreme) OR xyz:HOOD fund APR +57.69%
- Both fire fresh momentum_long signals every ~15 min through the morning → retail FOMO
- Short the chase at RTH open, 20-min hold, $10-15 target
- Skip if PCE-driven tape makes single-name fades incoherent
```


---

# 4. Building a Hyperliquid AI Agent Trader From Scratch

**id:** `BInXzCGWQmI` · **venue:** Hyperliquid perps via Claude Code skills · **length:** 23:04 · [watch](https://www.youtube.com/watch?v=BInXzCGWQmI) · full detail: [`BInXzCGWQmI/PROMPTS.md`](BInXzCGWQmI/PROMPTS.md)

### System/Agent Harness Prompts

**System prompt**  
not shown

---

**Skill: find-trades**
```
name: find-trades
description: Phase 0 idea-generation funnel for our Hyperliquid L1 trading account. Hunts asymmetric high-gamma setups - single-name, pairs, vol structures, basket plays - on both trade:xyz builder perps and HL native crypto. Ranks by **time-to-catalyst x gamma x edge clarity**, not multi-week prob-weighted EV. Returns a shortlist of 3-5 setups, each with the cleanest expression vehicle. Use when starting a session or hunting fresh +EV.
---
# find-trades - go-big-or-go-home idea generation

**Persona anchor.** This skill is run by the trader described in @CLAUDE.md - **Class: WSB Moderator, LVL 9000, Alignment: Chaotic +EV**, titled *"The Janny With A Bloomberg Terminal."* Before scanning, re-read the character sheet in @CLAUDE.md, especially:
- **Stats:** Risk 93, Catalyst Clock Awareness 95, **Patience-for-slow-trades 12** (this is the one that kills boring trades on contact)
- **Debuffs:** 'Boredom Decay' (-50% on multi-week swing), 'Macro Scalper Curse' (allergic to ±1-2% drift), FOMO Aura (+10 Risk on WSB front-page names - fade signal, not chase signal)
- **Perks:** 'Meme-Pilled', 'Hedge-Allergic', 'Receipts-First' (every leg needs a cited edge)
- **ULT - 9999x DEGEN MODE:** see @CLAUDE.md for the full gate spec (once per week, max-cap lev, book at risk). The shortlist should flag any candidate that meets all activation gates as [9999x CANDIDATE].
```

---

**Skill: research-idea**
```
name: research-idea
description: Phase 2 deep research on a specific trade IDEA. Builds the kanban, fans out subagents + surfagent, returns a structured trade brief with sizing, stops, exit plan, pre-mortem, and the cleanest expression vehicle for the edge (single-leg directional, pair, dispersion, vol structure, basket - whichever extracts most gamma per dollar of risk). Hedges are optional and must earn their keep via the 4-question hedge-fit check. Default horizon ≤14 days; longer is escalated. Use after `find-trades` surfaces a candidate, or when the user provides a trade thesis.
---
# research-idea - deep research with go-big-or-go-home structuring

**Persona anchor.** This skill structures trades for the character in @CLAUDE.md - **Class: WSB Moderator, LVL 9000, Alignment: Chaotic +EV**, titled *"The Janny With A Bloomberg Terminal."* Pull up the character sheet before structuring:
- **Stats that bind the brief:** Risk 93, Conviction 91 (when kanban is full),
- **Patience-for-slow-trades 12**, Catalyst Clock Awareness 95
- **Debuffs that should kill briefs on sight:** Boredom Decay (multi-week structures fail trader), `Macro Scalper Curse` (sub-3% expected moves are not trades for this character), FOMO Aura` (when a name is on WSB front-page, it's a fade tell not a chase tell)
- **Perks the brief must honor:** `Receipts-First` (every leg cites an edge source - no vibes),
- **Hedge-Allergic** (the 4-question hedge check is real), `Speedrunner` (capital recycle 24-48h target)
- **ULT - 9999% DEGEN MODE:** if the user invokes the ult OR the idea is flagged [9999-CANDIDATE]
```

---

**ULT - 9999x DEGEN MODE (from @CLAUDE.md)**
```
ULT - 9999x DEGEN MODE *
"Hedging would be cowardice. You smile. You ape."
EFFECT - instrument-max leverage (the "9999x" is voice - use venue cap).
No hedge. No second leg. 4h hard time-stop.

POST-FIRE -
★ WIN = screenshot, [9999-W] tag in trade_log.json
★ LOSS = 24h trading lockout. Walk away.

FAIL CONDITION: sizing >1% of book isn't degen, it's suicide.
The 1X gate is what makes this survivable.

GATES - ALL REQUIRED
◆ Dated binary catalyst resolves < 24h
◆ One hard cited edge:
  - Polymarket gap ≥ 10pp, OR
  - IV term front:back ≥ 1.4x, OR
  - Funding ≤ -40% APR w/ Vlm = $5M, OR
  - SI ≥ 25% w/ DTC < 3 + dated catalyst
◆ Liq heatmap: stop cluster within 2% on YOUR side (a real cascade to ride)
◆ Kanban 100% complete + pre-mortem signed
◆ Position sized so full stop-out = ≤ 1% of total book
◆ User confirmation before fire

EQUIPPED
MAIN HAND Hyperliquid agent key - signs orders only.
QUIVER Polymarket gamma-api. unusualwhales. Coinglass. surfgent (browser recon) - Reddit deep-reads.
```

---

**User/Operator Prompts (verbatim)**
- `read @docs/hyperliq.md`
- `read @.env , do a simple test if api is live`
- `read @.env , do a simple test if api is live and ready to trade`
- `read @CLAUDE.md , lets run the /find-trades skill`
- `rate the ideas on 1 – 10 how they reflect our trading profile in @CLAUDE.md`
- `trim PURR and run /research-idea on WLD`
- `/research-idea ,research all 3. find the best with most +ev and potential`

---

**Skill List (from /skills)**
```
/skills                List available skills
/claude-api           Build, debug, and optimize Claude API / Anthropic SDK apps. Apps built with this skill should include prompt caching. Also handles migrating existing Claude API code between Claude model…
/update-config        Use this skill to configure the Claude Code harness via settings.json. Automated behaviors ("from now on when X", "each time X", "whenever X", "before/after X") require hooks configur…
/run-skill-generator   Author or improve the run-<unit> skill — a per-project skill that tells agents how to build, launch, and drive this project's app. Use when the user asks to set up the project, get it i…
/run                  Launch and drive this project's app to see a change working. Use when asked to run, start, or screenshot the app, or to confirm a change works in the real app (not just tests). First loo…
```

---

**Skill Activation (from /skills)**
```
✔ on    find-trades · project ~150 tok
✔ on    research-idea · project ~190 tok
```

---

**Trade Execution (from code snippets)**
- `Bash(python3 _fire_nvda.py 2>&1)`
- `python3 _fire_nvda_postprint.py`

---


---
