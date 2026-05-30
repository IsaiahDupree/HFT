/**
 * Seeds substantive research notes derived from the live Polymarket microstructure
 * literature + this codebase's own endpoint sweep. Each note has citations + a
 * confidence score so agents can weight them.
 *
 * Re-run safely: notes are de-duped by (topic, agent_id).
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";

type NoteSeed = {
  agent_slug: string | null;
  strategy_slug?: string | null;
  topic: string;
  body: string;
  source_urls: string[];
  confidence: number;
  tags: string[];
};

const notes: NoteSeed[] = [
  {
    agent_slug: "atlas-macro",
    topic: "Longshot spread premium — implications for fade-the-headline",
    body: `Microstructure work on Polymarket (arxiv 2604.24366) measures quoted half-spreads of ~400bps in the central probability band [0.4, 0.6], rising to 1,300–1,800bps for markets trading below 0.10. The asymmetry is real and persistent — wider on the lower-probability side.

For Atlas Macro's fade-the-headline strategy, this means:
1. **Edge from spread compression after a headline.** Markets that gap from ~0.30 to ~0.45 on news see their spread structure rapidly tighten as makers re-anchor. If we wait 6h and the gap is unwound, we capture the original move minus a now-tighter spread.
2. **Avoid fading deep longshots.** A headline that pushes a market from 0.05 → 0.12 looks like a fade candidate, but with 1,500bps half-spread you're already paying ~15% of NAV in slippage on entry — the expected reversion has to clear that bar before it's tradable.
3. **Reference price = midpoint not last-trade.** With 400-1500bps spread on the depth profile observed (L1/L10 median 0.137), last-trade prices can be stale by full minutes and misrepresent the actual fade target.`,
    source_urls: [
      "https://arxiv.org/html/2604.24366v1",
      "https://docs.polymarket.com/api-reference/market-data/get-spread",
    ],
    confidence: 0.75,
    tags: ["microstructure", "fade-strategy", "longshot-bias"],
  },
  {
    agent_slug: "atlas-macro",
    topic: "Long-dated political markets: the uncertainty premium",
    body: `Markets 6-12 months from resolution systematically overdiscount unlikely outcomes (the uncertainty premium). Atlas Macro's mandate (horizon_days_min: 14) is well-aligned but underplays the prime hunting ground: 180-365d markets where the priced odds embed a discount for not yet knowing.

Concrete tactic: rank Politics/Geopolitics markets by (resolution_date - now) descending. For markets in the [180d, 365d] window with priced YES <= 0.15, build a position-tracker watching:
- shift in volume_24h vs. trailing 7d average (catalyst attention)
- net flow into top holders (smart money repositioning)
- midpoint drift vs. external polling / model probabilities

Add a new strategy variant 'long-dated-uncertainty' with this hunting profile. Strict stops: exit if priced YES doubles without a real catalyst — that's noise.`,
    source_urls: [
      "https://cryptonews.com/cryptocurrency/polymarket-strategies/",
      "https://docs.polymarket.com/api-reference/markets/list-markets",
    ],
    confidence: 0.7,
    tags: ["macro", "long-dated", "value"],
  },
  {
    agent_slug: "scribe-sports",
    topic: "NBA arbitrage: real numbers from 75M order-book snapshots",
    body: `Empirical paper (arxiv 2605.00864) reconstructs Polymarket NBA markets across 173 games. Headline numbers Scribe Sports should internalize:

- **Single-market arbs are rare:** 7 episodes across 75.1M snapshots (0.0001% of time), median duration 3.6 seconds. Cap them at the rare edges of momentum swings.
- **Combinatorial arbs (moneyline + spread):** 290 episodes, median duration 16 seconds. Concrete trigger: \`Ask(ML_team_A) + Ask(Spread_team_B) < $1.00\`. 96% occur in-game.
- **Liquidity is the binding constraint:** in 76.9% of combinatorial opportunities, the executable size was bottlenecked to ~14.79 shares despite $100 budgets. Median yield = 101.01 bps on capped $100 trades.
- **Post-game spreads explode** to 7,532 bps — never hold a position after the buzzer.
- **API polling cadence ceiling:** the paper polled at 3.6-5.5s and likely missed flash arbs that resolved within. **The websocket feed is essential** — REST polling cannot capture this surface.

Action items:
1. Upgrade Scribe Sports to consume the CLOB market websocket, not REST polls.
2. Implement the combinatorial trigger explicitly.
3. Cap exposure per opportunity at $20 (well below the observed liquidity ceiling).
4. Hard time-stop at 30s — beyond that, edge has decayed.`,
    source_urls: [
      "https://arxiv.org/html/2605.00864",
      "https://docs.polymarket.com/api-reference/wss/market",
    ],
    confidence: 0.85,
    tags: ["sports", "arbitrage", "websocket", "in-game"],
  },
  {
    agent_slug: "scribe-sports",
    topic: "Dynamic taker fees on 15m crypto markets — what changed",
    body: `Polymarket introduced dynamic taker fees specifically on the 15-minute crypto markets. The fee is highest where odds are closest to 50% (peaks ~3.15% at 50c contracts) and tapers as odds move toward 0/100. This was explicitly designed to neutralize the latency-arb strategies that had documented earnings like one wallet turning $313 into $414k in a month.

Direct implication for Scribe Sports (sports, not crypto): the 15m crypto fee curve does NOT apply to sports markets today, but the *direction* of policy is clear — Polymarket is willing to insert friction to discourage pure latency arb. Sport markets could see similar treatment in the future. Hedge by:

1. Tracking the actual fee schedule per market (call \`getFeeRateBps\` per token) and bailing if it exceeds 2x the historical baseline.
2. Diversifying away from pure-latency strategies toward signal-driven (game-state lag, stale-quote) ones.
3. Watching for similar policy changes on sports — set up an alert when \`taker_base_fee\` on sports markets jumps.`,
    source_urls: [
      "https://www.financemagnates.com/cryptocurrency/polymarket-introduces-dynamic-fees-to-curb-latency-arbitrage-in-short-term-crypto-markets/",
      "https://docs.polymarket.com/api-reference/market-data/get-fee-rate",
    ],
    confidence: 0.8,
    tags: ["fees", "policy", "latency-arb"],
  },
  {
    agent_slug: "ember-momentum",
    topic: "Maker rebates: the 25% pairing trick",
    body: `Polymarket pays a 25% maker rebate when you have resting limit orders on BOTH sides (YES + NO) simultaneously, since you're providing two-sided liquidity. For one-sided makers, the rebate is 20%, typically captured by posting limits 2 cents inside the ask.

For Ember Momentum's breakout-rider strategy: the strategy is taker-biased by design (it crosses the spread on breakouts), so maker rebates aren't directly applicable. But the rebate program *changes the breakout dynamics*:

- Rebate-collecting makers will quote tighter around fair value → on the way *into* a breakout, you get better fills as a taker.
- On the way *out* (trailing stop), spreads can widen quickly if makers pull. Don't trust your trailing-stop level to hit at the resting quote you observed.

Action: when sizing an Ember breakout, model the round-trip cost as (taker_fee_in - 0) + (taker_fee_out + spread_widening). The breakout EV bar should be ~2x the round-trip cost, not 1x.`,
    source_urls: [
      "https://docs.polymarket.com/market-makers/maker-rebates",
      "https://docs.polymarket.com/api-reference/rewards/get-current-active-rewards-configurations",
    ],
    confidence: 0.7,
    tags: ["rebates", "execution", "breakout"],
  },
  {
    agent_slug: "ember-momentum",
    topic: "Public feed vs. on-chain ground truth — direction-inference is noisy",
    body: `Critical finding from arxiv 2604.24366: **trade direction inferred from Polymarket's public order-book feed matches on-chain ground truth only ~59% of the time** — barely above coin-flip. On the top-100 markets, the effective half-spread changes sign between feed- and on-chain trade directions on 67% of markets in the initial window.

Practical fallout for momentum / order-flow strategies:
1. **Do not use feed-derived buy/sell pressure as a primary signal.** Standard microstructure metrics (effective spread, realized spread, order-flow imbalance) inherit a ~41% direction error rate.
2. **For 'true' momentum, use either:** (a) on-chain match events from the CLOB \`/trades\` endpoint (ground truth), or (b) midpoint drift on a >30s window (averages out direction noise).
3. **The 30s smoothing applies to entry, not exit.** Once in a position, the noise floor is your enemy — use price-history at the 1-minute fidelity for stop placement.

Update Ember's spec to default to \`fidelity=60\` (1 minute) on prices-history for breakout detection rather than tick data.`,
    source_urls: [
      "https://arxiv.org/html/2604.24366v1",
      "https://docs.polymarket.com/api-reference/markets/get-prices-history",
    ],
    confidence: 0.85,
    tags: ["microstructure", "data-quality", "execution"],
  },
  {
    agent_slug: "oracle-research",
    topic: "Polymarket trader profitability: 7.6% — the market is efficient",
    body: `Per Dune analytics referenced in 2026 strategy guides: only ~7.6% of Polymarket wallets are net profitable. The other ~92% (1.5M+ wallets) lose money in aggregate. This is post-fee, post-resolution.

What this means for Oracle Research's thesis-writing:
1. **A new thesis must clear a high bar.** Random / discretionary trading loses. Theses should rank candidate markets on at least one structural edge: (a) explicit information advantage, (b) microstructure timing, (c) catalyst-driven repricing not yet reflected.
2. **Be specific about confidence intervals.** Generic "I think X will happen" is worth zero. State: priced odds, model odds, edge in cents, expected hold horizon, what would invalidate the thesis.
3. **Track every thesis end-to-end.** Even if Atlas Macro / Ember don't trade on a given note, log the implied direction + size and re-score after market resolves. This builds the corpus for future evaluator training.

Process change: every research_note from Oracle should include in its body:
- \`priced_yes\`: market's current YES probability
- \`model_yes\`: agent's estimated probability
- \`edge_bps\`: (model_yes - priced_yes) * 10000
- \`horizon_days\`: time until expected catalyst / resolution
- \`invalidation\`: what observation would force closure`,
    source_urls: [
      "https://cryptonews.com/cryptocurrency/polymarket-strategies/",
      "https://laikalabs.ai/prediction-markets/polymarket-trading-strategies",
    ],
    confidence: 0.9,
    tags: ["process", "research-quality", "calibration"],
  },
  {
    agent_slug: "oracle-research",
    topic: "Decentralized maker landscape: ~32 effective LPs per market",
    body: `Microstructure paper measures maker concentration via Herfindahl index — median 0.031, implying ~32 effective makers per market. This is more decentralized than equity venues (which often concentrate around 3-5 dominant HFTs) but materially less so than retail-only assumptions suggest.

Implications for thesis-writing:
- Treat the marginal-maker behavior as a population of ~30 quote machines, not as anonymous retail noise. Their quotes are typically calibrated; large mid-of-book deviations from priced odds are rarely accidental.
- When pricing a thesis against the orderbook, ask: 'what does the median quote machine know that I don't?' Disagreements with priced odds should be explained, not assumed wrong.
- Wash trading is bounded but real: median self-counterparty share 0.97%, p90=4.5%, max 22.2%. Volume-driven signals (volume_24h spikes) need a wash-detection filter — exclude any wallet that's been on both sides of a market.`,
    source_urls: ["https://arxiv.org/html/2604.24366v1"],
    confidence: 0.7,
    tags: ["microstructure", "thesis-process", "wash-trading"],
  },
  {
    agent_slug: null, // global
    topic: "Websocket feed: required for any latency-sensitive strategy",
    body: `Endpoint: \`wss://ws-subscriptions-clob.polymarket.com/ws/market\`. Subscribe by asset_id (token id) immediately after connecting. Send PING every 10s; server replies PONG; missing heartbeats → server closes connection.

Message types delivered:
- \`book\` — full bids/asks snapshot, with timestamp and hash
- \`price_change\` — incremental updates
- \`tick_size_change\` — fires when price crosses 0.96 (up) or 0.04 (down)
- \`last_trade_price\` — most recent fill

Optional \`custom_feature_enabled: true\` in the subscription unlocks \`best_bid_ask\`, \`new_market\`, and \`market_resolved\` messages.

**Why it matters for this codebase:**
- WebSocket traffic does NOT count against REST rate limits — eliminates the 1,500 req/10s \`/book\` ceiling.
- Polling REST at 3.6-5.5s misses flash arbs (the NBA-arb paper's own caveat). The websocket is the only way to see <3s arbitrage windows.
- For Scribe Sports the websocket is **required**, not optional. For Atlas Macro and Ember Momentum it's a strict upgrade for entry timing.

Build target: \`src/lib/polymarket/ws.ts\` exporting a \`subscribeMarket(tokenIds, onMessage)\` helper with auto-reconnect, heartbeat, and a callback for each message type.`,
    source_urls: [
      "https://docs.polymarket.com/api-reference/wss/market",
      "https://docs.polymarket.com/market-data/websocket/overview",
    ],
    confidence: 0.95,
    tags: ["infra", "websocket", "data-feed"],
  },
  {
    agent_slug: null,
    topic: "Local endpoint sweep — what's verified, what's open",
    body: `Most recent run of \`npm run test:endpoints\`: 47 pass / 0 fail / 4 skip (destructive endpoints intentionally skipped).

Verified working in this codebase:
- Gamma: events, markets, tags, series, comments, search, sports, teams, public-profile (11/11)
- Data API: positions, trades, activity, value, oi, v1/market-positions, holders, v1/leaderboard, live-volume (11/11)
- CLOB public: health, time, markets, sampling, simplified, condition, book, price, midpoint, spread, last-trade, prices-history, tick-size (14/14)
- CLOB auth (L2 HMAC): api-keys, orders, trades, balance-allowance, notifications (5/5)
- Relayer: relay-payload, deployed, transactions, list-keys (6/6)

Skipped (require explicit opt-in):
- POST /order, DELETE /order, DELETE /cancel-all
- POST /submit (relayer transaction submission)

Open quirks:
- \`/sampling-markets\` ignores \`limit\` param; client slices to N.
- Public-profile expects lowercase address.
- Gamma comments require \`parent_entity_type\` + \`parent_entity_id\`.
- HMAC signing path excludes query string (signed bare endpoint).`,
    source_urls: ["https://docs.polymarket.com/api-reference/introduction"],
    confidence: 1.0,
    tags: ["infra", "validation", "endpoints"],
  },
  {
    agent_slug: null,
    topic: "Evolution-loop next iteration: from heuristic to evidence-based",
    body: `Current evaluator in \`scripts/research-loop.ts\` is a placeholder (avg spread → tighter sizing). To make self-evolution meaningful, the loop needs three ingredients each strategy lacks today:

1. **A scoring function specific to the strategy's edge.** Atlas Macro should be scored on subsequent reversion, not on absolute pnl. Scribe Sports on (executed_edge - slippage) per opportunity, not aggregate volume. Ember on capture ratio of breakout move.

2. **A backtest using stored market_snapshots + on-chain trades.** The schema already supports this; we just don't query it. Backtest = replay \`/prices-history\` for each market in the strategy's universe, simulate the spec's entry/exit rules, score with rule #1.

3. **A promotion rule.** Currently proposals accumulate forever (is_current=0). Add: if a candidate version's backtest beats the parent's by >X% on the strategy-specific score AND is statistically significant (>=N trades), automatically promote — recording a \`promotion\` event with the deltas.

This makes the loop genuinely self-evolving. Until then, treat proposals as 'AI-generated drafts for human review'.`,
    source_urls: ["https://docs.polymarket.com/api-reference/markets/get-prices-history"],
    confidence: 0.85,
    tags: ["evolution-loop", "backtest", "process"],
  },
];

const handle = db();
const tx = handle.transaction(() => {
  const findAgent = handle.prepare("SELECT id FROM agents WHERE slug = ?");
  const findStrategy = handle.prepare(
    "SELECT id FROM strategies WHERE agent_id = ? AND slug = ?",
  );
  const existsNote = handle.prepare(
    "SELECT id FROM research_notes WHERE topic = ? AND COALESCE(agent_id, 0) = COALESCE(?, 0)",
  );
  const insert = handle.prepare(
    `INSERT INTO research_notes
       (agent_id, strategy_id, topic, body, source_urls_json, confidence, tags_json)
     VALUES (@agent_id, @strategy_id, @topic, @body, @sources, @confidence, @tags)`,
  );

  let inserted = 0;
  for (const n of notes) {
    const agentRow = n.agent_slug ? (findAgent.get(n.agent_slug) as any) : null;
    const agent_id = agentRow?.id ?? null;
    const strategy_id = n.strategy_slug && agent_id
      ? ((findStrategy.get(agent_id, n.strategy_slug) as any)?.id ?? null)
      : null;
    if (existsNote.get(n.topic, agent_id)) continue;
    insert.run({
      agent_id,
      strategy_id,
      topic: n.topic,
      body: n.body,
      sources: JSON.stringify(n.source_urls),
      confidence: n.confidence,
      tags: JSON.stringify(n.tags),
    });
    inserted++;
  }
  console.log(`Inserted ${inserted} new research notes (skipped ${notes.length - inserted} duplicates).`);
});
tx();
