# Replication blueprint — 6UBGecQTsZE

# Replication Blueprint: OpenAI Codex 5.5 Polymarket BTC 5-Minute Trading Agent

---

## 1. Exact prompts (verbatim)

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

## 2. Agent architecture

### Model(s) used

- **OpenAI Codex (v0.133.0)**
- **gpt-5.5 high** (primary for trading logic and plan)
- **gpt-5.5 medium** (used for "Plan mode" in some steps)

### Agent framework / SDK / harness

- **Codex CLI** (OpenAI Codex command-line interface)
- **Custom agent loop** (Python script: `btc_5m_bot.py`)
- **npm-based runner for live trading** (`npm run trade:live`)
- **Dashboard server** (local web server for UI at `http://localhost:8787`)

### Tools / functions the agent can call

- **Polymarket API client** (likely `py-clob-client-v2` or similar)
    - Fetch order book, place/cancel orders, get balances
- **Chainlink BTC/USD price feed** (for settlement reference)
- **WebSocket feed** (for live price updates)
- **Logging** (to `bot.log`)
- **UI dashboard** (real-time stats, PnL, win rate, countdown)
- **Risk controls** (see below)

### The decision loop (step by step)

1. **Observe**
    - At the start of each 5-minute window, record the Chainlink BTC/USD price (settlement reference).
    - Continuously monitor live Chainlink price and Polymarket order book for the current window.
2. **Reason**
    - Calculate the real-time probability that "Up" or "Down" will win, given current Chainlink price, time left, and volatility.
    - Compare this probability to the current Polymarket market price (ask/bid).
    - Only consider trading if the modeled probability offers a meaningful edge over the market price (after accounting for fees/spread).
3. **Act**
    - If edge is sufficient:
        - Place a **maker order** (non-crossing) early in the window to avoid spread, or
        - Place a **taker order** (crossing the spread) late in the window if the edge is strong.
    - **Position sizing**: Use half-Kelly formula, but cap at $3.25 per order, $5.25 per market, $8.25 total open at once, and never risk more than 20% of account on one window.
    - **Force at least one trade**: If no trades have occurred late in the hour, place a minimum-size taker trade to avoid auto-loss.
4. **Record**
    - Log all trades, outcomes, and PnL to `bot.log` and update the dashboard UI.
    - Track win/loss record, realized PnL, and current balance.
5. **Repeat**
    - Continue for each 5-minute window for 1 hour (~12 windows).

### Memory / state / logging

- **State**: Tracks current balance, open positions, trade history, and session PnL.
- **Logging**: All actions and outcomes are logged to `bot.log` and displayed in the dashboard.
- **UI**: Real-time dashboard at `http://localhost:8787` (or `:8791` in some logs) shows balance, win %, PnL, countdown, and trade log.

---

## 3. Market & data

### Venue(s)

- **Polymarket** (https://polymarket.com)
    - Chosen for its 5-minute BTC up/down markets, easy API, and clear settlement rules.

### Data sources / feeds / indicators consumed

- **Chainlink BTC/USD price feed** (official settlement source for Polymarket BTC 5m markets)
- **Polymarket order book** (for current market prices, liquidity, and order placement)
- **Account balances** (pUSD, MATIC for gas)

### Order types, position sizing, leverage

- **Order types**:
    - **Maker orders**: Non-crossing, placed early to avoid spread.
    - **Taker orders**: Crossing the spread, used when edge is strong or late in window.
- **Position sizing**:
    - **Half-Kelly formula** (edge-based sizing)
    - **Caps**:
        - $3.25 per order
        - $5.25 per market
        - $8.25 total open at once
        - Never risk more than 20% of account per window
- **Leverage**: None (spot only, no leverage)

---

## 4. Risk & capital controls

- **Ruin floor**: If balance drops below $8, halt trading to avoid $0 auto-loss.
- **Per-window try/except**: Errors or disconnects in one window do not halt the bot; it skips that window and continues.
- **WebSocket auto-reconnect**: Maintains live data feed; recovers from disconnects.
- **Stale-data gate**: If Chainlink price is >2.5s old, refuse to trade.
- **Last-8-seconds lockout**: No new positions opened in the final 8 seconds of a window.
- **Force trade**: At least one trade must be made per session (to avoid auto-loss).
- **No leverage**: Only spot positions, no margin.
- **Session drawdown stop**: (Removed in final version) Previously, would halt after a set loss.
- **Paper run**: Initial dry-run to verify logic before live trading.
- **Preflight checks**: Ensure sufficient gas (MATIC), pUSD balance, API access, and market discovery before live launch.

---

## 5. Results shown

**(from f_0281.jpg, f_0283.jpg, narrator transcript):**

- **Session record (example run, 6 trades):**

    | Window      | Side | Entry | Result      |
    |-------------|------|-------|------------|
    | 1779717900  | UP   | 0.77  | WIN $4.90  |
    | 1779718500  | UP   | 0.83  | WIN $5.38  |
    | 1779718800  | DOWN | 0.73  | LOSS -$28.04|
    | 1779719100  | UP   | 0.79  | WIN $3.02  |
    | 1779720000  | DOWN | 0.90  | LOSS -$9.35 |
    | 1779720600  | DOWN | 0.76  | WIN $11.95 |

    - **4 wins, 2 losses** (but large losses outweighed wins)
    - **Final standing**: $50.13 - $26.34 = **-$23.79**
    - **Another run**: 1 win / 8 loss on "Up" bets, net -$30.06

- **Dashboard UI**: Shows live balance, win %, PnL, countdown, and trade log.

- **Narrator summary**: In the main experiment, the OpenAI Codex 5.5 bot ended up **+$14** after 1 hour, beating the rival. The strategy of value-betting against Polymarket's mispricings worked well.

---

## 6. How to replicate (concrete steps)

1. **Set up Polymarket account and funding**
    - Create a Polymarket account.
    - Fund with ~$50 pUSD and sufficient MATIC for gas (e.g., 20 MATIC).
    - Ensure API credentials are available in `/env`.

2. **Prepare environment**
    - Clone or set up the agent codebase (directory: `~/Documents/agents/codex_poly`).
    - Ensure `py-clob-client-v2` (or equivalent Polymarket API client) is installed.
    - Ensure Chainlink BTC/USD price feed access (via API or WebSocket).
    - Install all dependencies (Python, npm, etc.).

3. **Configure agent**
    - Set model to **gpt-5.5 high** (or as available).
    - Use the provided system prompt (see section 1).
    - Ensure the agent has access to `/docs` (Polymarket docs) and `/env` (credentials).

4. **Paper test**
    - Run a dry-run for ~2 windows to verify:
        - Correct capture of open price.
        - Correct mapping of Up/Down tokens.
        - Sanity of order book reads.
    - Confirm `get_balance_allowance/balance` returns expected pUSD.

5. **Live validation trade**
    - Place a single small live trade (e.g., 5-share lot) to confirm end-to-end signing, funding, and settlement.

6. **Launch live trading session**
    - Start the bot for a 1-hour session:
        - **Command**: `npm run trade:live -- --duration-minutes 60 --force-one-trade`
        - Alternatively: `./venv/bin/python btc_5m_bot.py --live --minutes 60`
    - Ensure the dashboard is running at `http://localhost:8787` (or `:8791`).
    - The dashboard should auto-detect the bot, switch to LIVE, and start the 1-hour countdown.

7. **Monitor and log**
    - Watch live trading via the dashboard (balance, win %, PnL, trade log).
    - Tail `bot.log` for detailed logs.
    - The bot will report final W/L record and PnL automatically at session end.

8. **Risk controls**
    - Confirm ruin floor is active (halt if balance < $8).
    - Confirm per-window error handling and WebSocket auto-reconnect are working.
    - Confirm stale-data and last-8-seconds lockouts are enforced.

9. **Review results**
    - At session end, review final balance, win rate, and PnL.
    - Compare to rival agent if running a head-to-head test.

10. **(Optional) UI customization**
    - For branding, use `@openaipng` logo in the dashboard.
    - Ensure dark mode, 1H countdown, and real-time stats are visible.

---

**Note:**  
- All prompts, logic, and risk controls are as shown in the video and OCR.  
- Do not invent or alter prompts or logic beyond what is visible above.  
- For full fidelity, use the exact system prompt and risk parameters as shown.  
- If any step is unclear or not shown, mark as "not shown" or refer to the OCR above.
