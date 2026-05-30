---
source: "@0x_Discover on X (Twitter)"
url: "https://x.com/0x_Discover"
published: 2026-04-17
archived: 2026-05-25
views_at_archive: 2.8M
disclaimer: |
  Saved for reference. The article ends with a "Polymarket airdrop" referral block
  and an external promo link — this codebase does NOT endorse or use that.
  Treat the airdrop section as promotional content; the analytical section
  (the math + cited papers) is the substantive part.
primary_sources_cited:
  - "arxiv:2508.03474 — Unravelling the Probabilistic Forest: Arbitrage in Prediction Markets"
  - "arxiv:1606.02825v2 — theoretical foundation"
key_claims:
  - "$39,688,585 in guaranteed arbitrage extracted from Polymarket April 2024 – April 2025"
  - "Top single trader: $2,009,631.76 across 4,049 trades (~$496/trade)"
  - "17,218 conditions examined; 41% (7,051) showed single-market arbitrage; median mispricing $0.60"
  - "Frank-Wolfe outperformed baseline by 38% on median security prices in NCAA late-tournament"
  - "Polygon 2-second block time is the latency floor; ~30s detection-to-submission window is where edge lives"
tags: [arbitrage, microstructure, frank-wolfe, bregman, polymarket, research]
---

# The Exact Math That Pulled $40,000,000 from Polymarket (Full Roadmap)

> While you were checking if YES + NO = $1.

When you see a Polymarket market where YES is $0.62 and NO is $0.33, you think
that adds up to $0.95, there's arbitrage. You're right. What you never realize is
that while you're manually checking whether YES plus NO equals $1, quantitative
systems are solving integer programs scanning **17,218 conditions across 2^63
possible outcomes in milliseconds**.

By the time you place both orders, the spread is gone. The systems found the
same violation across dozens of correlated markets, calculated optimal position
sizes accounting for order book depth and fees, executed parallel trades, and
rotated capital into the next opportunity.

The difference isn't speed. It's **mathematical infrastructure**.

A research paper published in 2025 — *Unravelling the Probabilistic Forest:
Arbitrage in Prediction Markets* — documented exactly what happened. From April
2024 to April 2025, quantitative traders extracted **$39,688,585** in guaranteed
arbitrage profits from Polymarket. The top single trader made **$2,009,631.76
from 4,049 trades**. That's $496 guaranteed profit per trade, systematically,
for a year.

The key word is **guaranteed**. This wasn't prediction. This wasn't luck. This
was math identifying situations where one outcome pays $1 and you can buy it for
less. No matter what happens, you profit. The only question is whether you can
execute before the market corrects.

---

## Why simple math fails — the marginal polytope problem

Here's what most people get wrong. They think arbitrage detection is about
checking if numbers add up. It's not. It's about solving **constraint
satisfaction problems over exponentially large outcome spaces**.

Single market, single condition: "Will Trump win Pennsylvania?" YES: $0.48,
NO: $0.52. Looks perfect. No arbitrage. Now add: "Will Republicans win
Pennsylvania by 5+ points?" YES: $0.32, NO: $0.68. Both sum to $1. Still looks
fine.

But there's a logical dependency. If Republicans win by 5+ points, Trump must
win Pennsylvania. These markets aren't independent. That creates arbitrage. And
no simple addition check catches it.

### The scale of the problem

For any market with n conditions, there are **2^n** possible price combinations.
For the 2024 US election alone, there were 305 markets — creating 46,360
possible pairs to check. The NCAA 2010 tournament market had 63 games, meaning
2^63 = 9,223,372,036,854,775,808 possible outcomes.

Brute force is impossible. So quantitative systems don't enumerate. They
**constrain**.

### Real example from the Duke vs Cornell basketball market

Each team has 7 possible win-count outcomes. That's 14 conditions; 2^14 = 16,384
combinations. But they can't both win 5+ games because they'd meet in the
semifinals. **Three linear constraints replace 16,384 brute force checks.**

### What the research found

Out of 17,218 conditions examined, **7,051 (41%) showed single-market
arbitrage**. The median mispricing was **$0.60** — meaning markets were
regularly wrong by 40%. Not close to efficient. Massively exploitable.

---

## Bregman projection — how to calculate the perfect trade

Finding arbitrage is one problem. Calculating the optimal trade is another. You
can't just "fix" prices by averaging. You need to project the current market
state onto the arbitrage-free manifold while preserving the information
structure.

Standard distance metrics fail here. A price move from $0.50 to $0.60 has
different information content than a move from $0.05 to $0.15, even though both
are 10 cents. Market makers use **logarithmic cost functions** where prices
represent probabilities. The math must respect this.

### The formula for guaranteed profit

The maximum guaranteed profit from any arbitrage trade equals the Bregman
divergence between the current market state and its projection onto the
arbitrage-free set:

> max_profit = D_φ(p_current ‖ Π_M(p_current))

This is what the top arbitrageur was doing 4,049 times over a year. Each trade
was solving this optimization problem faster and more accurately than every
other participant. The $2 million wasn't luck. It was the consistent output of
a mathematical system running at scale.

---

## Frank-Wolfe algorithm — making the impossible tractable

Computing the Bregman projection directly is intractable. The arbitrage-free
set M has exponentially many vertices — you'd need to enumerate every valid
outcome, which is impossible at scale.

The **Frank-Wolfe algorithm** solves this by reducing projection to a sequence
of linear programs that build the solution iteratively. Instead of finding the
entire set at once, it grows an active set one vertex at a time.

1. Start with a small set of known valid outcomes.
2. Each iteration: solve a convex optimization over the current set, then find
   one new vertex via integer programming.
3. Convergence gap tells you when to stop — typically 50–150 iterations.
4. Active set grows by one per iteration — after 100 iterations, tracking 100
   vertices instead of 2^63.

The research showed a **crossover point**: once enough outcomes settle, integer
programs solve fast enough for real-time trading. After 45 games were settled in
the NCAA tournament, the first successful 30-minute projection completed. For
the remaining tournament, the Frank-Wolfe method outperformed the baseline by
**38% on median security prices**.

Why does it get faster over time? As outcomes settle, the feasible set shrinks.
Fewer variables, tighter constraints, faster solves. Early in a tournament:
10–30 second solve times. Late in a tournament: under 5 seconds. The system
accelerates as the event unfolds.

---

## Execution where most strategies fail

You've detected arbitrage. You've computed the optimal trade. Now you need to
execute. This is where most people get destroyed.

Polymarket uses a **Central Limit Order Book**. Unlike decentralized exchanges
where arbitrage can be atomic, CLOB execution is sequential. Your arbitrage
plan: buy YES at $0.30, buy NO at $0.30, guaranteed $0.40 profit. Reality: YES
fills at $0.30 ✓. Price updates. NO fills at $0.78 ✗. You just lost $0.08.

### The latency hierarchy

- Detection / submission: <100 ms (or you're already late)
- Polygon block time: ~2 s (everyone waits)
- Manual trader: many seconds to minutes

The 2-second window is not a bug. It's a structural feature. Everyone waits for
the same blockchain. The edge comes from the 30 seconds **before** that — the
detection-to-submission window where fast systems submit all legs in one block
and slow systems are still reading the market.

### Why copy-trading fast wallets fails

**What you think happens:**

1. You see their profitable trade on-chain
2. You copy the same position
3. You capture the same profit
4. You win alongside them

**What actually happens:**

1. Block N-1: system detects, submits in 30ms
2. Block N: all legs confirm, arbitrage captured
3. Block N+1: you see it and copy
4. You paid $0.344 for what they bought at $0.322
5. You're providing exit liquidity, not arbitraging

So the only way copy-trading works is if your execution fires in the same block
as the original wallet. That's a hard technical requirement — not a preference.

---

## What was actually deployed — the complete system

### 1. Data pipeline (real-time)

WebSocket connection to Polymarket CLOB API for live order book updates and
trade feeds. Alchemy Polygon node for querying the `OrderFilled` contract
events. The research analyzed 86 million transactions — this requires
infrastructure, not scripts.

### 2. Dependency detection (AI-powered)

DeepSeek-R1-Distill-Qwen-32B with prompt engineering to classify market pairs.
Input: two market descriptions. Output: JSON of valid outcome combinations.
**81.45% accuracy** on complex multi-condition election markets. Good enough for
filtering; requires manual verification for execution.

### 3. Optimization engine (3 layers)

- **Layer 1:** Fast linear programming relaxations for obvious mispricings
  (milliseconds).
- **Layer 2:** Frank-Wolfe algorithm with Gurobi IP solver for complex cases
  (1–30 seconds depending on market state).
- **Layer 3:** Execution validation against live order book before any order
  is submitted.

### 4. Position sizing (Kelly criterion)

Modified Kelly criterion accounting for execution risk and order book depth.
Position cap at **50% of available order book depth** to avoid moving the
market against yourself. Every position re-sized in real-time based on current
portfolio value.

---

## The actual numbers, broken down

The research broke down where the $39.7 million came from. Three distinct
strategies, each exploiting a different type of market inefficiency.

- Top 10 extractors took $8,127,849 — 20.5% of the total.
- Top single extractor: $2,009,632 from 4,049 trades.
- Average profit per trade: **$496**.

Not lottery wins. Not lucky timing. Mathematical precision executed
systematically over 365 days.

---

## What separates winners — the honest breakdown

The research makes the gap explicit. Two groups of participants, same markets,
same information, completely different outcomes.

### Retail approach

- Check prices every 30 seconds manually
- Look for obvious YES + NO ≠ $1
- Submit orders sequentially via UI
- No position sizing framework
- No execution risk management
- Providing exit liquidity to fast wallets

### Quantitative approach

- Real-time WebSocket feeds <5 ms
- Integer programming for dependency detection
- Bregman projection for optimal trades
- Frank-Wolfe with Gurobi IP solver
- Parallel order execution, same block
- Kelly-based position sizing, live recalculation

One group extracted $40 million. The other group provided the liquidity that
made it possible.

The research paper is public. The algorithms are known.
**arXiv:2508.03474**. The theory foundation: **arXiv:1606.02825v2**. The math
works. The infrastructure exists. The only question is whether you can build it
before the next $40 million is extracted.

---

## 15 wallets cited in the article

The article lists 15 Polymarket user handles with documented profit. Note:
these are **handle names from the leaderboard**, not raw 0x addresses (except
the one shown as `0x2a2C53bD27…` which is a truncated address). Resolve to
on-chain `proxyWallet` via Gamma `/v1/leaderboard?userName=<handle>`.

| Handle | Strategy | Documented profit (USD) |
|---|---|---|
| kch123 | Latency arb · high frequency | 12,000,000 |
| RN1 | Market making · multi-market | 7,400,000 |
| Swisstony | Oracle arbitrage · Chainlink | 5,900,000 |
| GamblingIsAllYouNeed | News-driven · AI probability | 4,600,000 |
| DrPufferfish | Combinatorial arb · multi-market | 3,400,000 |
| sovereign2013 | Latency arb · BTC/ETH contracts | 3,400,000 |
| 0x2a2C53bD27… | Market rebalancing · systematic | 2,500,000 |
| Countryside | Election markets · base rate | 2,400,000 |
| gatorr | Latency arb · parallel execution | 2,300,000 |
| weflyhigh | Multi-strategy · diversified | 1,800,000 |
| blindStaking | Market making · liquidity provision | 1,500,000 |
| CharlieKirkEvans | Political markets · news arb | 1,200,000 |
| JPMorgan101 | Institutional-style systematic | 1,100,000 |
| cigarettes | High-frequency · short contracts | 850,000 |
| Sharky6999 | Latency arb · crypto contracts | 813,000 |

Sum: ~$51M across these 15.

---

## Promotional section (NOT acted on by this codebase)

The article closes with a "Polymarket airdrop" promo linking to a referral URL.
Saved here for completeness only — this codebase does not interact with
referral links, does not validate the airdrop claim, and treats this section
as unrelated to the analytical content above.
