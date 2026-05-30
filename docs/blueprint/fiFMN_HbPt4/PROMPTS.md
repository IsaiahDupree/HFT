# Replication blueprint — fiFMN_HbPt4

```markdown
## 1. Exact prompts (verbatim)

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

## 2. Agent architecture

- **Model(s) used:**  
  - OpenAI Codex (v0.134.0), model: `gpt-5.5 high`  
  - (For comparison: Claude Code Opus 4.7, but blueprint is for Codex run.)

- **Agent framework / SDK / harness:**  
  - Custom Python agent harness using the Hyperliquid SDK and a "trade.xyz" builder abstraction.
  - All trades must flow through a strict intent/queue/execution pipeline (see below).

- **Tools / functions the agent can call:**  
  - **Exchange(...)**: Market interface for both Hyperliquid native and xyz perps.
  - **trade_queue.json**: File where trade "intents" are queued.
  - **agent_monitor.py**: Daemon that polls the queue for pending trades.
  - **agent_execute.py**: The only process allowed to actually place orders; runs risk checks, enforces leverage/liquidation buffer, and places orders via SDK.
  - **agent_fills_pull.py**: Tracks fills and positions, logs to trade_log.jsonl and agent_events.jsonl.
  - **/tmp/duel_monitor.sh**: Bash script for lightweight position monitoring.
  - **REST/WS telemetry**: For monitoring, not for direct trading.
  - **Manual kill/close scripts**: For force-closing positions (see OCR code in f_0245/f_0246).

- **The decision loop (step by step):**
  1. **Observe**: Gather market data (funding rates, price moves, volume, etc.) via SDK and web sources.
  2. **Reason**: Formulate trade ideas/edges (e.g., fade crowded longs, react to macro prints).
  3. **Draft intent**: Write explicit trade intent JSONs (with all required fields) to a staging file.
  4. **Queue intent**: At the right time, move intent(s) to `trade_queue.json` with status "pending".
  5. **Monitor**: agent_monitor.py picks up pending intents, agent_execute.py runs risk/cap checks and places orders.
  6. **Track**: agent_fills_pull.py logs fills/positions; background monitor scripts can be run for live status.
  7. **React**: Agent can update/cancel/close positions on the fly by writing new intents or using close scripts.
  8. **Record**: All actions and fills are logged for review.

- **Memory / state / logging:**
  - **trade_queue.json**: Pending trade intents.
  - **trade_log.jsonl**: All fills/trades.
  - **agent_events.jsonl**: Agent actions/events.
  - **/tmp/duel_monitor.log**: Live status log from monitor script.
  - **State variables**: Mode (STAND_DOWN/HUNT), daily_target_usd, account_value_sod, etc.

## 3. Market & data

- **Venue(s):**
  - **Hyperliquid**: Main platform, but only the "xyz" synthetic perps are used for this challenge (no crypto perps).
  - **Why**: Challenge rules specify xyz market only, to avoid crypto and focus on synthetic indices, commodities, and stocks.

- **Data sources / feeds / indicators consumed:**
  - **Hyperliquid SDK**: For live prices, funding APR, mark prices, position info.
  - **External web sources**: For macro research (e.g., Morningstar, Rockstar Markets, Trading Economics).
  - **WS/REST**: For real-time monitoring (telemetry only, not for direct trading).
  - **Indicators used**: Funding APR (to detect crowded trades), price momentum, macro event reactions (e.g., PCE print), volume, volatility.

- **Order types, position sizing, leverage:**
  - **Order types**: Limit orders (with IOC for force-close), reduce-only for closing.
  - **Position sizing**: Max $100 margin per challenge rules; per-trade sizing set in intent (e.g., $55 for Trade B).
  - **Leverage**: Up to 30x allowed by venue, but agent uses 25x for safety (to maintain a 4% liq buffer); weekend crypto capped ≤5x (not relevant here).
  - **Exit controls**: Stop-loss, take-profit tiers, time-based stops.

## 4. Risk & capital controls

- **Stop-losses**: Explicit stop prices set per trade (e.g., $7 adverse for Brent, $20 for XYZ100).
- **Take-profits**: TP tiers (e.g., $20 favorable for Brent, $40-60 for XYZ100).
- **Max position**: $100 margin per challenge rules; enforced by intent schema and risk checks in agent_execute.py.
- **Leverage caps**: 25x for xyz perps (to maintain ≥4% liq buffer); enforced by agent_execute.py.
- **Daily loss limits**: daily_target_usd and account_value_sod variables used to auto-stand-down if profit/loss thresholds are hit.
- **Kill switches**: Mode can be flipped to STAND_DOWN to halt all new trades; manual force-close scripts available.
- **Sim-vs-real handling**: Not shown; all trades are real (on Hyperliquid test/mainnet).

## 5. Results shown

- **Codex (gpt-5.5 high) results:**
  ```
  Autostop completed.
  Final state:
  - Open positions: 0
  - Pending queue: 0
  - Open xyz orders: []
  - Mode: STAND_DOWN
  - Final realized PnL: +$9.23

  Return:
  - Start total balance: $971.07
  - Final balance: $980.30
  - Return on total balance: +0.95%
  - Return on $100 challenge margin budget: +9.23%
  ```

- **Claude Code Opus 4.7 results:**
  ```
  FINAL DUEL SCORE: -3.93%

  Metric                Value
  Pre-duel master total 973.03
  Post-duel master total 971.07
  Net P&L              -1.96
  % on $50 deployed bankroll -3.93

  Where the money went:
  - v1 40x false-fire (liq-buffer gate) -> -$0.30
  - v2 25x false-fire (gate, at threshold) -> -$0.30
  - v3 -> v4 close-and-reopen for higher lev -> -$0.50
  - v4 60x SHORT SP500 close at 7514.1: 
    +$0.88 gross, -$1.50 taker close fee -> -$0.62
  - v5b XYZ100 SHORT, auto-closed flat with fees -> -$0.50
  ```

- **Trade log example (Codex):**
  - Trade A: SHORT xyz:BRENTOIL, entry 94.652, stop 96.50, TP1 93.00, TP2 91.50, 25x lev, $100 margin.
  - Trade B: xyz:XYZ100, fired after macro print, 25x lev, $55 margin.
  - All positions closed by end of challenge, no open orders.

## 6. How to replicate (concrete steps)

1. **Set up the environment:**
   - Clone the agent codebase as shown (`~/Documents/agents/hyperliq2`).
   - Install Python dependencies and Hyperliquid SDK.
   - Ensure you have API keys/wallet for Hyperliquid (testnet or mainnet).

2. **Configure the agent:**
   - Set `framework_only = true` in config (prevents auto strategies, only explicit intents allowed).
   - Ensure agent is in `STAND_DOWN` mode initially.
   - Set up `trade_queue.json`, `trade_log.jsonl`, and `agent_events.jsonl` files.

3. **Prepare the challenge:**
   - Limit margin/risk to $100 per the challenge.
   - Only allow trades on "xyz" perps (no crypto).
   - Set up a Bash script or agent monitor for live status (`/tmp/duel_monitor.sh`).

4. **Draft trade intents:**
   - Research macro events (e.g., PCE print) and funding rates for xyz perps.
   - Draft intent JSONs for each planned trade (see schema: intent_id, coin, dex, is_long, lev, margin_usd, status, expires_at, thesis, edge_sources, exit controls, tp_tiers).
   - Save as `intents_staged.json` with status "draft".

5. **Operational flip (T-5 min):**
   - Flip agent mode from `STAND_DOWN` to `HUNT`.
   - Set `account_value_sod` to actual perp balance.
   - Bump `daily_target_usd` to $500 (to avoid auto-stand-down on small profit).
   - Drop monitor loop interval to 10s for the challenge hour.
   - Stage kill-switch/force-close script.

6. **Start the challenge (T+0):**
   - Move first trade intent(s) from staged file to `trade_queue.json` with status "pending".
   - Agent monitor/execute pipeline will pick up and place trades.

7. **Monitor and react:**
   - Use Bash monitor script to watch positions and PnL in real time.
   - After macro event (e.g., PCE print), observe market for 60-90s, then queue next trade intent(s) as per plan.
   - Adjust/cancel/close trades as needed by writing new intents or using force-close scripts.

8. **End of challenge:**
   - At 60 minutes, ensure all positions are closed (use force-close script if needed).
   - Set agent mode back to `STAND_DOWN`.
   - Record final PnL from logs and dashboard.

9. **Review results:**
   - Compare realized PnL, win rate, and trade log to the results shown above.

**Note:**  
- Do not call `Exchange.order()` directly; all trades must go through the intent/queue/execute pipeline.
- All trade ideas must be explicit intents; no autonomous scanning or baked-in strategies.
- Use only xyz perps (e.g., xyz:BRENTOIL, xyz:XYZ100, xyz:MRVL, xyz:HOOD).
- Enforce all risk controls as described.

---
```
