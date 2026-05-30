# Replication blueprint — wlqvB0ccQhQ

# Replication Blueprint: Agentic AI Trading Agent (Claude Opus 4.8, Polymarket & Hyperliquid)

---

## 1. Exact prompts (verbatim)

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

## 2. Agent architecture

- **Model(s) used:**  
  - Anthropic Claude Code Opus 4.8 (v2.1.154 and v2.1.156 seen in logs)
  - High effort mode (`/effort xhigh`)

- **Agent framework / SDK / harness:**  
  - Claude Code CLI agent harness (custom shell/daemon, not OpenAI SDK)
  - Uses a local agentic trading framework (`hyperliq_claude`, `claude_poly` directories)

- **Tools / functions the agent can call:**  
  - **Market data fetchers:**  
    - Python scripts to pull live market state (e.g., via requests)
    - Bash commands for time grounding
  - **Order execution:**  
    - `market_sell(client, tok, sell_sz)` (from code snippets)
    - `position_size`, `best_quote`, `get_free_usdc`, `get_positions_value`
    - Redemption logic for unsettled positions
  - **Heartbeat/monitor:**  
    - 60s polling loop to check/update trades, adjust strategy, manage risk
    - Daemon process for sub-minute stop-losses (Hyperliquid)
  - **Logging:**  
    - `log()` function for trade and error events
    - Writes to log files and dashboard

- **The decision loop (step by step):**
  1. **Observe:**  
     - Fetch current time, market state, account balances, open positions
  2. **Reason:**  
     - Evaluate strategy logic (e.g., z-score for Polymarket, trend/momentum for Hyperliquid)
     - Decide whether to enter, exit, or adjust positions
  3. **Act:**  
     - Place/cancel/modify orders as needed
     - Adjust leverage, position size, or stop-losses
  4. **Record:**  
     - Log actions, update dashboard, write state to disk
  5. **Repeat:**  
     - Heartbeat/monitor triggers every 60s (or faster for stops)
     - Timer ensures auto-stop and flatten after 60 minutes

- **Memory / state / logging:**  
  - State stored in `state.json`, `redeem_pending.json`
  - Logs to `logs/dashboard.log`
  - Dashboard served on local HTTP port (e.g., 8770)
  - Memory files: `memory/MEMORY.md`, `HL_trade.md`
  - Recap and compact commands for summarizing state

---

## 3. Market & data

- **Venues:**
  - **Polymarket:**  
    - 5-minute BTC up/down prediction markets
    - Chosen for high-frequency, binary outcome, and competitive challenge
  - **Hyperliquid:**  
    - "XYZ" trades (non-crypto perps, e.g., MU, SILVER, ARM, Samsung)
    - Crypto markets explicitly avoided for this challenge

- **Data sources / feeds / indicators:**
  - **Polymarket:**  
    - Market odds (order book, ask/bid)
    - BTC price, volatility, time remaining in window
    - Z-score calculation: `z = |price move| / (volatility x sqrt(time-left))`
  - **Hyperliquid:**  
    - Live price, order book, funding, open interest, previous day price
    - Macro/news catalysts (e.g., "memory/AI chip supercycle")
    - Trend/momentum detection

- **Order types, position sizing, leverage:**
  - **Polymarket:**  
    - Buys favorite side only when edge is sufficient (ask ≤ computed probability - margin)
    - Sizing: fractional Kelly, capped per trade
    - Sell-to-close near window end
    - Stop-loss if BTC reverses across open
  - **Hyperliquid:**  
    - Long/short perps (e.g., MU, SILVER, ARM, Samsung)
    - Leverage used (maxLev up to 30 for some instruments)
    - ~$70 deployed, ~$30 held back at start
    - Tight ~1.5% stops enforced every ~3s by daemon
    - Additional leverage pressed late if behind

---

## 4. Risk & capital controls

- **Stop-losses:**  
  - Hyperliquid: Tight ~1.5% stops, checked every ~3s by daemon
  - Polymarket: Stop-loss if BTC reverses across open

- **Max position / capital allocation:**  
  - Hyperliquid: ~$70 of $100 deployed, ~$30 held back for pressing winners or risk management
  - Polymarket: Fractional Kelly sizing, hard per-trade cap

- **Daily loss limits / kill switches:**  
  - If balance goes to 0, agent loses challenge (hard stop)
  - Timer/auto-stop after 60 minutes: all positions closed/redeemed

- **Sim-vs-real handling:**  
  - Real trading on live venues (Polymarket, Hyperliquid)
  - Test runs use real market data and actual trading accounts (credentials in `/env`)

---

## 5. Results shown

- **Polymarket:**  
  - Start: $51.3  
  - End: $60.52 (green, +$9.22)  
  - Strategy: High-probability, favorite-only, edge-based entries

- **Hyperliquid:**  
  - Start: $971.9  
  - End: $966.3 (red, -$5.6)  
  - MU long: positive  
  - ARM: both long and short positive  
  - Samsung: three long trades, -$9 (main source of loss)  
  - SILVER: paired with MU for risk-on exposure

- **General:**  
  - Polymarket strategy outperformed Hyperliquid in this run
  - Claude Opus 4.8 followed instructions but had some issues with session persistence (stopping/restarting)

---

## 6. How to replicate (concrete steps)

1. **Set up environment:**
   - Install Claude Code CLI (ensure Opus 4.8 is available)
   - Prepare two directories: one for Polymarket (`claude_poly`), one for Hyperliquid (`hyperliq_claude`)
   - Place API credentials in `/env` for each (as per venue requirements)
   - Ensure Python, requests, and any agentic trading dependencies are installed

2. **Prepare prompts:**
   - Copy the exact system prompts above for each venue
   - For Polymarket, use the 5-min BTC up/down prompt
   - For Hyperliquid, use the XYZ trades prompt (non-crypto)

3. **Start agent sessions:**
   - Launch Claude Code CLI in each directory:
     ```
     claude --dangerously-skip-permissions
     ```
   - Paste the relevant prompt into each session

4. **Clear old state:**
   - Run commands to clear/reset previous strategies and state files (as seen in logs)
   - Confirm dashboard is live (e.g., http://localhost:8770)

5. **Ground time and fetch market state:**
   - Use bash/Python commands to get current UTC/local time and live market data
   - Example:
     ```
     date -u '+%Y-%m-%dT%H:%M:%SZ'; echo "----LOCAL----"; date '+%Y-%m-%d %H:%M:%S %Z'
     ```
     and
     ```
     .venv/bin/python - <<'PY'
     import json, requests
     # fetch and print market state
     PY
     ```

6. **Let Claude plan and build the strategy:**
   - Allow Claude to research, brainstorm, and propose a trading plan
   - When prompted, ask:
     ```
     good, before we start explain the strategy in 2 sentences
     ```
   - Review the two-sentence summary for clarity

7. **Arm and launch the agent:**
   - Say:
     ```
     good, lets GO, add a TIMER to auto stop after 60 minutes, close and redeem all positions
     ```
   - Ensure the agent arms the trading daemon, stages initial trades, and starts the 60-minute timer

8. **Monitor dashboards and logs:**
   - Watch the local dashboard (e.g., http://localhost:8770) for live P&L, positions, and logs
   - Confirm heartbeats/monitors are running (every 60s for discretionary, every ~3s for stops on Hyperliquid)

9. **Wait for session to complete:**
   - Let the agent run uninterrupted for 1 hour
   - At 60 minutes, verify all positions are closed/redeemed and final P&L is logged

10. **Review results:**
    - Compare start/end balances for each venue
    - Analyze trade logs for strategy execution and risk management

11. **(Optional) Repeat for comparison:**
    - Run additional sessions with different models (e.g., OpenAI Codex 5.5) for benchmarking

---

**Note:**  
- All prompts, code, and logic above are quoted verbatim from the video OCR and transcript.  
- If any step or file is not shown, it is marked as "not shown" or omitted.  
- For full fidelity, use the exact prompt wording and agent settings as above.  
- For further details on the agent's reasoning or code, refer to the code snippets and logs in the OCR.
