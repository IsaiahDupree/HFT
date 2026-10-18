/**
 * Seeds the cross-venue agent (Aurora Cross) plus example Polymarket↔Coinbase
 * pairings into `cross_venue_arbs`. Idempotent — re-run safely.
 *
 * The pairings here use placeholder Polymarket condition_ids ("seed-...") — once
 * a real Polymarket BTC-price market is identified you should overwrite those
 * rows with the actual conditionId so the cross-venue research loop can target it.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";

const AGENT = {
  slug: "aurora-cross",
  name: "Aurora Cross",
  charter: "Cross-venue agent. Pairs Polymarket binary/scalar markets with Coinbase spot to score implied-vs-realized probability spreads. Trades both sides when EV > 1% net of fees.",
  risk_budget_usd: 400,
};

const STRATS = [
  {
    slug: "btc-price-threshold-fade",
    name: "BTC price-threshold fade",
    thesis: "When Polymarket implied prob for 'BTC > $X by date' diverges from a Black-Scholes-implied prob computed off Coinbase spot + 30d realized vol by > 8 pts, fade the Polymarket side.",
    market_filter: {
      poly_tags: ["Crypto"],
      poly_question_pattern: "BTC.*(>|>=|over|above)\\s*\\$?[0-9]",
      cb_product: "BTC-USD",
    },
    initialSpec: {
      entry: {
        type: "implied_vs_bs_spread",
        min_spread_pts: 8,
        bs_inputs: { vol_window_days: 30, rate: 0.045 },
      },
      sizing: { kelly_fraction: 0.12, cap_per_trade_usd: 50 },
      exit: { spread_collapse_pts: 3, time_stop_h: 96 },
      coinbase_hedge: { enabled: true, side: "opposite", size_ratio: 0.5, product: "BTC-USD" },
    },
    rationale: "Initial baseline. Fees: PM ≈ 0bps, Coinbase ≈ 25bps taker; min net spread accounts for both.",
  },
  {
    slug: "eth-merge-narrative",
    name: "ETH narrative-vs-spot drift",
    thesis: "When ETH-USD spot lags a positive Polymarket ETH narrative market (>5 pts implied prob jump in 6h without a >2% spot move), buy ETH-USD spot for 24h.",
    market_filter: {
      poly_tags: ["Crypto", "Tech"],
      poly_question_pattern: "ETH|Ethereum",
      cb_product: "ETH-USD",
    },
    initialSpec: {
      entry: {
        type: "narrative_lag_spot",
        prob_jump_pts: 5,
        spot_move_max_pct: 2,
        window_h: 6,
      },
      sizing: { fixed_size_usd: 25 },
      exit: { time_stop_h: 24, target_pct: 1.5, stop_pct: 1.5 },
    },
    rationale: "Mirror of headline-spike fade but on the spot side; tests whether PM information leads Coinbase price.",
  },
];

// Example pairings — placeholder condition_ids. Replace with live ones via
// `cross_venue_arbs` upsert once you know which Polymarket markets you want to track.
const SAMPLE_PAIRINGS = [
  {
    poly_condition_id: "seed-btc-over-150k-eoy-2026",
    poly_question: "Will BTC close above $150,000 by Dec 31, 2026?",
    coinbase_product_id: "BTC-USD",
    pairing_kind: "price_threshold",
    threshold_value: 150_000,
    threshold_direction: "gt",
    expiry_iso: "2026-12-31T23:59:59Z",
    rationale: "Seeded by aurora-cross to demonstrate price-threshold pairing.",
  },
  {
    poly_condition_id: "seed-eth-flippening-2027",
    poly_question: "Will ETH market cap exceed BTC by end of 2027?",
    coinbase_product_id: "ETH-USD",
    pairing_kind: "event_outcome",
    threshold_value: null,
    threshold_direction: null,
    expiry_iso: "2027-12-31T23:59:59Z",
    rationale: "Seeded by aurora-cross. ETH-USD spot is the proxy hedge instrument; no direct threshold.",
  },
];

const handle = db();
const tx = handle.transaction(() => {
  // Agent.
  handle.prepare(
    `INSERT INTO agents (slug, name, charter, risk_budget_usd)
     VALUES (@slug, @name, @charter, @risk_budget_usd)
     ON CONFLICT(slug) DO UPDATE SET name=excluded.name, charter=excluded.charter, risk_budget_usd=excluded.risk_budget_usd, updated_at=datetime('now')`,
  ).run(AGENT);
  const agentId = (handle.prepare("SELECT id FROM agents WHERE slug = ?").get(AGENT.slug) as { id: number }).id;

  // Strategies + initial versions.
  const insertStrategy = handle.prepare(
    `INSERT INTO strategies (agent_id, slug, name, thesis, market_filter)
     VALUES (@agent_id, @slug, @name, @thesis, @market_filter)
     ON CONFLICT(agent_id, slug) DO UPDATE SET name=excluded.name, thesis=excluded.thesis, market_filter=excluded.market_filter`,
  );
  const insertVersion = handle.prepare(
    `INSERT INTO strategy_versions (strategy_id, parent_version_id, version, spec_json, rationale, introduced_by, is_current)
     VALUES (@strategy_id, NULL, 1, @spec_json, @rationale, 'human', 1)`,
  );
  const countVersions = handle.prepare("SELECT COUNT(*) AS n FROM strategy_versions WHERE strategy_id = ?");

  for (const s of STRATS) {
    insertStrategy.run({
      agent_id: agentId,
      slug: s.slug,
      name: s.name,
      thesis: s.thesis,
      market_filter: JSON.stringify(s.market_filter),
    });
    const stratId = (handle.prepare("SELECT id FROM strategies WHERE agent_id = ? AND slug = ?").get(agentId, s.slug) as { id: number }).id;
    const existing = (countVersions.get(stratId) as { n: number }).n;
    if (existing === 0) {
      insertVersion.run({
        strategy_id: stratId,
        spec_json: JSON.stringify(s.initialSpec),
        rationale: s.rationale,
      });
    }

    // Link sample pairings to the first strategy only (btc) so it's clearly attributable.
    if (s.slug === "btc-price-threshold-fade") {
      const insertPairing = handle.prepare(
        `INSERT INTO cross_venue_arbs (poly_condition_id, poly_question, coinbase_product_id, pairing_kind, threshold_value, threshold_direction, expiry_iso, agent_id, strategy_id, rationale)
         VALUES (@poly_condition_id, @poly_question, @coinbase_product_id, @pairing_kind, @threshold_value, @threshold_direction, @expiry_iso, @agent_id, @strategy_id, @rationale)
         ON CONFLICT(poly_condition_id, coinbase_product_id, pairing_kind) DO UPDATE SET
           poly_question=excluded.poly_question,
           threshold_value=excluded.threshold_value,
           threshold_direction=excluded.threshold_direction,
           expiry_iso=excluded.expiry_iso,
           agent_id=excluded.agent_id,
           strategy_id=excluded.strategy_id,
           rationale=excluded.rationale`,
      );
      for (const p of SAMPLE_PAIRINGS) {
        insertPairing.run({ ...p, agent_id: agentId, strategy_id: stratId });
      }
    }
  }
});
tx();

const agentCount = (handle.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n;
const stratCount = (handle.prepare("SELECT COUNT(*) AS n FROM strategies").get() as { n: number }).n;
const pairCount = (handle.prepare("SELECT COUNT(*) AS n FROM cross_venue_arbs").get() as { n: number }).n;
console.log(`Cross-venue seed complete: ${agentCount} total agents, ${stratCount} total strategies, ${pairCount} cross-venue pairings.`);
