# Replication blueprint — BInXzCGWQmI

```markdown
## 1. Exact prompts (verbatim)

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

## 2. Agent architecture

- **Model(s) used (exact names/versions):**
  - Claude Opus 4.7 (1M context) with high effort (Claude Max)
  - Claude Code v2.1.145

- **Agent framework / SDK / harness:**
  - Claude Code harness (invoked via `claude --dangerously-skip-permissions`)
  - Uses "skills" (modular agent behaviors) loaded via `/skills`
  - Project directory structure with `@CLAUDE.md` persona file, `.env` for API keys, and skills YAML

- **Tools / functions the agent can call:**
  - `find-trades` skill: Generates a shortlist of high-gamma trade ideas for Hyperliquid/trade.xyz, using persona constraints.
  - `research-idea` skill: Deep research on a trade idea, builds kanban, subagents, surfagent (browser), returns structured trade brief with sizing, stops, exit plan, pre-mortem.
  - Bash commands: For time grounding, API calls (e.g., `curl` to Hyperliquid API), and trade execution scripts.
  - Surfagent: Browser-based research (Reddit, Polymarket, X.com, etc.)
  - Subagents: Parallel research tasks (e.g., crowding, options flow, news, catalyst calendar).
  - Trade execution scripts: Python scripts that place orders via Hyperliquid API.

- **The decision loop (step by step):**
  1. **Observe:** Read environment, time, and persona (@CLAUDE.md). Pull live data from Hyperliquid API, Reddit, Polymarket, etc.
  2. **Idea Generation:** Run `find-trades` skill to generate 3-5 trade ideas, each with edge, catalyst, and expression vehicle.
  3. **Score:** Rate ideas 1-10 for persona fit (using @CLAUDE.md stats).
  4. **Filter:** Drop low-scoring/filler ideas; keep top 3-4.
  5. **Research:** Run `research-idea` skill on selected ideas for deep dive (kanban, sizing, stops, pre-mortem, edge citation).
  6. **Structure:** Build multi-leg or single-leg trade plans, with triggers and conditional logic.
  7. **User Confirmation:** Await user pick and confirmation before execution.
  8. **Execute:** Fire trade via Python script using Hyperliquid API key.
  9. **Record:** Log trade to `trade_log.json` with tags (e.g., [9999-W] for ULT mode).
  10. **Monitor/Exit:** Monitor for exit triggers, stops, or time-based exits.
  11. **Enforce risk controls:** E.g., lockout after loss, max position sizing.

- **Memory / state / logging:**
  - Context is maintained in project directory (resumable sessions).
  - Persona and constraints in `@CLAUDE.md`.
  - Trade logs in `trade_log.json`.
  - Kanban and research state in skill outputs.
  - Session context can be cleared and resumed.

---

## 3. Market & data

- **Venue(s):**
  - **Primary:** Hyperliquid (HL native perps/crypto)
  - **Secondary:** trade.xyz (for US equities perps, e.g., NVDA, ADI, MU)
  - **Why:** Hyperliquid offers high-leverage perps on crypto and synthetic equities; trade.xyz for US stock perps.

- **Data sources / feeds / indicators consumed:**
  - Hyperliquid API (`metaAndAssetCtxs`): Funding rates, volume, mark price, etc.
  - trade.xyz API: For US equities perps.
  - Polymarket API: For catalyst odds, event probabilities.
  - Reddit (WSB), X.com: For crowding, meme signals.
  - Options flow/IV term structure (implied volatility front:back ratios).
  - News feeds: Gappers, halts, earnings, unlocks.

- **Order types, position sizing, leverage:**
  - Market and conditional orders via Python scripts.
  - Position sizing: Strictly ≤1% of book for ULT mode; otherwise, per trade brief (e.g., $100, 33% of book, etc.).
  - Leverage: Typically 10x–25x (average 15x+), up to venue max for ULT mode.
  - Multi-leg trades: Basket, pairs, dispersion, conditional triggers.

---

## 4. Risk & capital controls

- **Stop-losses:**  
  - Each leg has explicit stop (e.g., "-3% from entry", "above AH peak", "above prior close").
  - Hard time-stop for ULT mode (4h).
  - Exit triggers: Funding flip, price move, or time.

- **Max position:**  
  - ULT mode: Full stop-out ≤1% of total book.
  - Regular: Per trade brief, e.g., $100, 33% of book, or as specified.

- **Daily loss limits / kill switches:**  
  - ULT mode: Loss triggers 24h trading lockout ("Walk away").
  - No explicit daily loss limit shown for regular mode.

- **Sim-vs-real handling:**  
  - Not explicitly shown, but real trades are fired via API key in `.env`.
  - Narrator mentions firing a test trade and immediately closing it for demo.

---

## 5. Results shown

- **P&L / Win rate:**  
  - Not shown in detail; only live position and P&L display during test trade.
  - Narrator demonstrates opening and closing a 10x NVDA short, confirms execution and P&L updating.

- **Trades / Outcomes:**  
  - Example trades:  
    - NVDA post-print IV crush short (25x, pre-spec'd triggers).
    - Long WLD (funding squeeze, 15x).
    - Long ADI (sympathy, 15x).
    - Short PURR (mean reversion, 10x).
    - Multi-leg "NVDA Iron Triangle" (ADI long, NVDA short, MU short).
    - "Semi Dispersion Residual" (NVDA long, AMD/MU short).
    - "Cross-Catalyst Pincer" (WLD long, BTC short).
  - Trade briefs include entry/exit, stops, leverage, and edge citation.

- **Persona-fit scoring:**  
  - Each idea scored 1–10 for fit to @CLAUDE.md profile.
  - Composite shortlist score: 9.3/10 for final 3-idea list.

---

## 6. How to replicate (concrete steps)

1. **Set up Hyperliquid account:**
   - Create a MetaMask wallet.
   - Fund with USDC and ETH on Arbitrum.
   - Deposit USDC to Hyperliquid account.
   - (Optional) Adjust account settings: Disable HIP 3 DEX abstraction if you want to separate spot/perp balances.

2. **Generate API key:**
   - In Hyperliquid, go to "More" > "API".
   - Create a new wallet (e.g., "ai_agent"), generate and save the wallet address and private key.

3. **Prepare project directory:**
   - Create a new directory (e.g., `hype`).
   - Create a `.env` file with:
     ```
     API_WALLET_NAME=ai_agent
     API_WALLET_ADDRESS=your_wallet_address
     API_WALLET_PRIVATE_KEY=your_private_key
     ```
   - Create a `docs` folder and add `hyperliq.md` with the link to [https://hyperliquid.gitbook.io/hyperliquid-docs](https://hyperliquid.gitbook.io/hyperliquid-docs).

4. **Set up Claude Code agent:**
   - Launch Claude Code with `claude --dangerously-skip-permissions` in your project directory.
   - Ensure you have access to Opus 4.7 (Claude Max) or equivalent.

5. **Define persona and skills:**
   - Create `@CLAUDE.md` with your trader persona (e.g., WSB Moderator, stats, perks, ULT mode spec).
   - Add `find-trades` and `research-idea` skills as shown above (copy verbatim).

6. **Test API connectivity:**
   - Run: `read @.env , do a simple test if api is live and ready to trade`
   - Confirm output shows API is live, wallet is ready, and collateral is available.

7. **Run idea generation:**
   - Run: `read @CLAUDE.md , lets run the /find-trades skill`
   - Wait for the agent to generate a shortlist of 3–5 trade ideas.

8. **Score and filter ideas:**
   - Run: `rate the ideas on 1 – 10 how they reflect our trading profile in @CLAUDE.md`
   - Drop low-scoring ideas (e.g., "trim PURR and run /research-idea on WLD").

9. **Deep research and structuring:**
   - Run: `/research-idea ,research all 3. find the best with most +ev and potential`
   - Let the agent build kanban, subagent research, and structured trade briefs.

10. **Review trade plans:**
    - Inspect the structured trade briefs (multi-leg, stops, triggers, sizing, edge citation).

11. **User confirmation:**
    - Choose which trade(s) to execute.

12. **Execute trade(s):**
    - Fire trade via agent (e.g., `Bash(python3 _fire_nvda.py 2>&1)` or similar script).
    - For conditional trades, use scripts that check triggers before firing (e.g., `_fire_nvda_postprint.py`).

13. **Monitor and manage:**
    - Watch live positions and P&L.
    - Exit per plan (stop, time, or trigger).
    - Log all trades to `trade_log.json`.

14. **Enforce risk controls:**
    - Ensure position sizing and stops match the plan.
    - If ULT mode, enforce 1% book risk and lockout on loss.

15. **Iterate:**
    - Repeat idea generation and research for new sessions.
    - Optionally, experiment with other models (e.g., Codex) or skills.

---

**Note:**  
- All prompts, skills, and persona YAML should be copied verbatim as shown above.
- The agent relies on live API keys and real funds for execution.
- For safety, always test with small size or in a sandbox before trading real money.
```
