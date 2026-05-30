/**
 * Seeds a small but realistic cast of AI agents + strategies so the UI is
 * meaningful on first boot. Idempotent — re-run safely.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";

type AgentSeed = {
  slug: string;
  name: string;
  charter: string;
  risk_budget_usd: number;
  strategies: StrategySeed[];
};
type StrategySeed = {
  slug: string;
  name: string;
  thesis: string;
  market_filter: Record<string, unknown>;
  initialSpec: Record<string, unknown>;
  rationale: string;
};

const seeds: AgentSeed[] = [
  {
    slug: "atlas-macro",
    name: "Atlas Macro",
    charter: "Top-down macro/politics agent. Trades long-horizon (>14d) markets where consensus has drifted from priced odds. Bias toward mean-reversion after one-sided news cycles.",
    risk_budget_usd: 500,
    strategies: [
      {
        slug: "fade-headline-spikes",
        name: "Fade Headline Spikes",
        thesis: "Markets often overreact intra-day to single headlines; if the 24h price move > 8 pts without follow-through in the next 6h, fade it.",
        market_filter: { tags: ["Politics", "Geopolitics"], min_volume_24h_usd: 50000, horizon_days_min: 14 },
        initialSpec: {
          // Regime preference (Phase 5 of gated-decision-system PRD). Mean-
          // reversion: best in chop / low-vol; avoid breakouts that often
          // continue rather than revert.
          regimes: ["chop", "low_vol"],
          entry: { type: "price_jump_reversion", threshold_pts: 8, lookback_h: 24, confirm_quiet_h: 6 },
          sizing: { kelly_fraction: 0.15, cap_per_trade_usd: 50 },
          exit: { target_pts: 4, stop_pts: 6, time_stop_h: 72 },
        },
        rationale: "Initial baseline — generic mean-reversion to sanity-check pipeline before tuning.",
      },
    ],
  },
  {
    slug: "scribe-sports",
    name: "Scribe Sports",
    charter: "In-game sports agent. Pulls live odds + sports websocket signals, looks for stale-quote arbs vs. game state.",
    risk_budget_usd: 250,
    strategies: [
      {
        slug: "stale-quote-arb",
        name: "Stale Quote Arb",
        thesis: "When the orderbook lags a scoring event by >3s, the top-of-book is stale; cross the spread if expected EV > 2%.",
        market_filter: { tags: ["Sports"], live_only: true },
        initialSpec: {
          // Latency arb is regime-agnostic — works in any state where the
          // book is slow to update.
          regimes: ["any"],
          entry: { type: "stale_quote", min_lag_s: 3, min_ev_pct: 2 },
          sizing: { fixed_size_usd: 20 },
          exit: { type: "immediate_market_out" },
        },
        rationale: "Latency-arb baseline. Will tighten thresholds once we measure real fill quality.",
      },
    ],
  },
  {
    slug: "oracle-research",
    name: "Oracle Research",
    charter: "Slow-thinker that produces written theses + confidence scores; does not place trades directly but proposes them to other agents.",
    risk_budget_usd: 0,
    strategies: [
      {
        slug: "weekly-deep-dives",
        name: "Weekly Deep Dives",
        thesis: "Each week, pick the 5 highest-volume political/macro markets and write a deep-dive note with confidence + suggested side.",
        market_filter: { tags: ["Politics", "Economy", "Finance"], min_volume_7d_usd: 100000 },
        initialSpec: {
          // Research-only — no live trading, so regime gate doesn't apply
          // but we set ["any"] for completeness.
          regimes: ["any"],
          cadence: "weekly",
          n_targets: 5,
          deliverables: ["thesis_md", "confidence_pct", "suggested_side", "key_catalysts"],
        },
        rationale: "Research-only seed; turns produced notes into trading inputs for Atlas Macro.",
      },
    ],
  },
  {
    slug: "ember-momentum",
    name: "Ember Momentum",
    charter: "Trend-follower on high-volume markets. Rides moves with strict trailing stops; designed to be the opposite of Atlas Macro for diversification.",
    risk_budget_usd: 300,
    strategies: [
      {
        slug: "breakout-rider",
        name: "Breakout Rider",
        thesis: "When midpoint breaks the prior-week's high with >2x average volume, enter with a trailing stop at 60% of move.",
        market_filter: { tags: ["Crypto", "Tech", "Finance"], min_volume_24h_usd: 100000 },
        initialSpec: {
          // Breakout/momentum: best in trending + breakout regimes.
          regimes: ["trending", "breakout"],
          entry: { type: "breakout_high", lookback_days: 7, vol_multiple_min: 2 },
          sizing: { atr_fraction: 0.5, cap_per_trade_usd: 75 },
          exit: { trailing_pct: 0.6, hard_stop_pct: 0.25 },
        },
        rationale: "Pair with Atlas Macro so the portfolio isn't lopsidedly mean-reverting.",
      },
    ],
  },
];

const handle = db();
const tx = handle.transaction(() => {
  const insertAgent = handle.prepare(
    `INSERT INTO agents (slug, name, charter, risk_budget_usd)
     VALUES (@slug, @name, @charter, @risk_budget_usd)
     ON CONFLICT(slug) DO UPDATE SET name=excluded.name, charter=excluded.charter, risk_budget_usd=excluded.risk_budget_usd, updated_at=datetime('now')`,
  );
  const findAgent = handle.prepare("SELECT id FROM agents WHERE slug = ?");
  const insertStrategy = handle.prepare(
    `INSERT INTO strategies (agent_id, slug, name, thesis, market_filter)
     VALUES (@agent_id, @slug, @name, @thesis, @market_filter)
     ON CONFLICT(agent_id, slug) DO UPDATE SET name=excluded.name, thesis=excluded.thesis, market_filter=excluded.market_filter`,
  );
  const findStrategy = handle.prepare("SELECT id FROM strategies WHERE agent_id = ? AND slug = ?");
  const countVersions = handle.prepare("SELECT COUNT(*) AS n FROM strategy_versions WHERE strategy_id = ?");
  const insertVersion = handle.prepare(
    `INSERT INTO strategy_versions
       (strategy_id, parent_version_id, version, spec_json, rationale, introduced_by, is_current)
     VALUES (@strategy_id, NULL, 1, @spec_json, @rationale, 'human', 1)`,
  );

  for (const a of seeds) {
    insertAgent.run({ slug: a.slug, name: a.name, charter: a.charter, risk_budget_usd: a.risk_budget_usd });
    const agentId = (findAgent.get(a.slug) as any).id as number;
    for (const s of a.strategies) {
      insertStrategy.run({
        agent_id: agentId,
        slug: s.slug,
        name: s.name,
        thesis: s.thesis,
        market_filter: JSON.stringify(s.market_filter),
      });
      const stratId = (findStrategy.get(agentId, s.slug) as any).id as number;
      const existing = (countVersions.get(stratId) as any).n as number;
      if (existing === 0) {
        insertVersion.run({
          strategy_id: stratId,
          spec_json: JSON.stringify(s.initialSpec),
          rationale: s.rationale,
        });
      }
    }
  }
});
tx();

const agentCount = (handle.prepare("SELECT COUNT(*) AS n FROM agents").get() as any).n;
const stratCount = (handle.prepare("SELECT COUNT(*) AS n FROM strategies").get() as any).n;
const versionCount = (handle.prepare("SELECT COUNT(*) AS n FROM strategy_versions").get() as any).n;
console.log(`Seed complete: ${agentCount} agents, ${stratCount} strategies, ${versionCount} versions.`);
