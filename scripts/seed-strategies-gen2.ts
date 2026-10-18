/**
 * Generation-2 agent seed.
 *
 * Adds 4 new top-level agents wired to the strategy scanners shipped in
 * `project_strategies_v1.md` + `project_strategies_v1_runners.md`. Each
 * agent has a clear charter, one strategy, and an initial spec version.
 * Idempotent — re-run safely (ON CONFLICT updates name/charter/spec).
 *
 * After seeding, the operator can:
 *   - View them at /agents
 *   - Create capsules for the actionable ones (Nereid, Lyra, Hydra)
 *   - Run the scanner workers (npm run scan:*, npm run worker:nrs-exec)
 *   - Watch the heuristic evaluators in research-loop tune them over time
 *
 * The 4 new agents:
 *
 *   - Nereid Scrape (near-resolution scrape) — actionable
 *   - Lyra Cross-Timeframe (CTS spread arb) — actionable but small size
 *   - Pulse Microstructure (orderbook imbalance) — research-only by design
 *     (signals decay in seconds; polling-based execution can't capture them)
 *   - Hydra Consensus (cross-wallet consensus tail) — actionable
 *
 * Naming: keeps the existing cosmological-figure theme (Atlas / Scribe /
 * Oracle / Ember / Aurora → Nereid / Lyra / Pulse / Hydra).
 *
 * NOTE: this script does NOT create capsules. Agents without an active
 * capsule cannot trade — the router will reject their orders with
 * CAPSULE_NOT_FOUND. Capsule creation is intentionally separate so the
 * operator decides which gen-2 agents go live, with what budget, when.
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
    slug: "nereid-scrape",
    name: "Nereid Scrape",
    charter:
      "Harvest the time-decay premium on near-resolution binary markets. Buy the winning side at 0.95+ on near-certain markets with weeks to resolution, hold to settlement, collect the 1-5% convergence. Proven viable by wallet 0x6e1d5040 banking $2M doing exactly this.",
    risk_budget_usd: 200,
    strategies: [
      {
        slug: "near-resolution-scrape",
        name: "Near-resolution Scrape",
        thesis:
          "Binary markets with weeks-to-resolution but already pricing one side at 0.95+ leave a measurable 1-5% premium on the table. The edge is purely mechanical convergence — no probability disagreement with the market required. Capital efficiency is low (need $1M to make $50K at 5% margin), but the strategy is repeatable, slow-cadence, and not latency-dependent.",
        market_filter: {
          tags: ["any"],
          min_winning_side_price: 0.95,
          min_days_to_resolution: 1,
          max_days_to_resolution: 30,
        },
        initialSpec: {
          // Near-resolution scrape works in any regime — purely mechanical
          // convergence to $1.00, doesn't care about market trend or chop.
          regimes: ["any"],
          scanner: "scan:near-resolution",
          entry: { min_price: 0.95, max_days_to_resolution: 30, min_days_to_resolution: 1, fee_bps: 20 },
          sizing: { per_signal_usd_cap: 25, target_edge: 0.05, daily_usd_cap: 100 },
          exit: { type: "hold_to_resolution" },
          executor: "worker:nrs-exec",
          env_to_arm_live: "NRS_LIVE=1",
        },
        rationale:
          "v1 — defaults match the worker-near-resolution-exec env defaults. Sim-mode until operator creates the 'near-resolution-scrape' capsule and sets NRS_LIVE=1.",
      },
    ],
  },
  {
    slug: "lyra-cross-timeframe",
    name: "Lyra Cross-Timeframe",
    charter:
      "Exploit the lag between short and long timeframe Polymarket crypto markets. When the 5m and 15m BTC markets diverge by ≥3 standard deviations on the rolling spread, buy the cheap side and exit on reversion. Direct adaptation of the Daniro article z-score formula.",
    risk_budget_usd: 50,
    strategies: [
      {
        slug: "cross-timeframe-spread-trade",
        name: "Cross-timeframe Spread Trade",
        thesis:
          "5m markets reprice faster than 15m on the same underlying. When the spread z-score (vs. 30-sample rolling stats) exceeds 3, the short market has captured information the long hasn't yet — buy the cheap side, exit when the spread mean-reverts. Sized small (per-pair $30 cap) because the edge decays in minutes if not captured.",
        market_filter: {
          tags: ["Crypto"],
          duration_kinds: ["5m", "15m"],
          assets: ["BTC", "ETH", "SOL", "XRP"],
        },
        initialSpec: {
          // Spread-arb is fundamentally regime-agnostic — relies on the
          // shorter timeframe being slower-to-update vs the longer, which
          // happens in trending AND chop conditions alike.
          regimes: ["any"],
          scanner: "scan:cross-timeframe",
          entry: { min_z: 3.0, min_samples: 30, max_stale_sec: 60 },
          sizing: { per_signal_usd: 10, cap_per_pair_usd: 30, daily_usd_cap: 60 },
          exit: { type: "spread_reversion", target_z: 1.0, time_stop_min: 10 },
          executor: "(none — manual; v2 may add worker:cts-exec)",
          notes:
            "No auto-executor in v1 because the strategy needs sub-minute reaction time we don't have via polling. Operator acts on signals from /opportunities feed.",
        },
        rationale:
          "v1 — emits signals only. When we add WS-driven price feeds we can run a worker:cts-exec at <10s latency, at which point this strategy becomes auto-executable.",
      },
    ],
  },
  {
    slug: "pulse-microstructure",
    name: "Pulse Microstructure",
    charter:
      "Research-only orderbook-pressure observer. Surfaces top-3 bid/ask depth imbalances ≥3:1 on active Polymarket binaries for operator review. NOT a trading agent — signals decay in seconds and our polling-based detection can't reliably capture them. Exists to feed the signal layer + agent context, not to place orders.",
    risk_budget_usd: 0,
    strategies: [
      {
        slug: "orderbook-imbalance-watch",
        name: "Orderbook Imbalance Watch",
        thesis:
          "Top-3 bid/ask depth ratios > 3:1 (or < 1:3) often precede price moves within seconds. We surface these as research notes + AgentContext.recentStrategyOpportunities. v1 is observation-only because the operator + other agents need the signal more than we need to race the latency game.",
        market_filter: {
          tags: ["Crypto"],
          min_liquidity_usd: 5000,
        },
        initialSpec: {
          // Observation-only — regime doesn't gate anything since we don't
          // place orders. ["any"] for completeness.
          regimes: ["any"],
          scanner: "scan:orderbook-imbalance",
          mode: "watch",
          entry: { min_ratio: 3.0, min_signal_strength: 0.7, top_levels: 3, min_depth_usd: 1000 },
          sizing: { per_signal_usd: 0 },
          exit: { type: "n/a (observation-only)" },
          executor: "(none — observation only by design)",
          notes:
            "Spoofing risk + latency: WS-driven persistence-check upgrade is the right v2. v1 emits signals to the /opportunities feed and the signal arrays consumed by other agents.",
        },
        rationale:
          "v1 — research-only. Risk budget $0. Other agents (Ember Momentum especially) read this strategy's signals via AgentContext.recentStrategyOpportunities to tune their own gates.",
      },
    ],
  },
  {
    slug: "drift-midwindow",
    name: "Drift Midwindow",
    charter:
      "Trajectory extrapolation on Polymarket 5-min crypto Up/Down binaries. Sample the first 2 min of intra-window price action; if the elapsed move is ≥1σ AND the trajectory-extrapolated final spot implies a probability ≥5pp away from the current Polymarket UP price, place a directional bet on the chosen side. Risk-budget $0 until a real-Polymarket-historicals backtest validates that the trajectory edge survives MM repricing — current crypto-only backtest only proves trajectory is informative, not that it beats the live quote.",
    risk_budget_usd: 0,
    strategies: [
      {
        slug: "midwindow-trajectory",
        name: "Midwindow Trajectory",
        thesis:
          "First 2 min of a 5-min binary window carries directional signal in trajectories that are >1σ relative to the period's variance. Extrapolate linearly to T+5, compute P(UP) via Φ((projected - strike) / σ_remaining), bet on the side where the model probability diverges from the Polymarket UP best-ask by more than fee + threshold. Crypto-only backtest on 12k BTC + ETH 1-min candles shows hit-rate 85–95% at zMove≥1.0; the live edge depends on how much of that signal the MM has already priced in by T+2min — answered only by a real-Polymarket-historicals replay (v2).",
        market_filter: {
          tags: ["Crypto"],
          duration_kinds: ["5m"],
          assets: ["BTC", "ETH", "SOL", "XRP", "DOGE"],
        },
        initialSpec: {
          // Trajectory extrapolation thrives on trending + breakout — that's
          // when the 2-min path has predictive power for the remaining 3 min.
          regimes: ["trending", "breakout"],
          scanner: "backtest:midwindow (no live scanner yet)",
          entry: {
            min_elapsed_ms: 90_000,
            max_elapsed_ms: 150_000,
            min_ticks: 30,
            min_z_move: 1.0,
            edge_threshold: 0.05,
            fee_bps: 20,
          },
          sizing: { per_signal_usd: 5, daily_usd_cap: 0 },
          exit: { type: "hold_to_resolution" },
          executor: "(none v1 — requires real-Polymarket-historicals backtest before going live)",
          env_to_arm_live: "DRIFT_MIDWINDOW_LIVE=1 (not implemented v1)",
          notes:
            "v1 is decision-logic + crypto-only backtest harness. Before paper or live: (a) capture real Polymarket 5m binary historicals for the same window the candles cover, (b) re-run backtest with those prices as the market quote, (c) confirm edge clears fees + MM markup. Then wire scanner + executor.",
        },
        rationale:
          "v1 — pure decision-logic + backtest. Edge validated to be informative on crypto-only replay (hit-rate ≥0.78 at zMove≥1.0); live edge requires v2 Polymarket-historicals integration.",
      },
    ],
  },
  {
    slug: "hydra-consensus",
    name: "Hydra Consensus",
    charter:
      "Act on cross-wallet consensus signals when ≥3 distinct clusters of high-trust tracked wallets agree on a market+direction within 30min. The platform's defensible edge is cross-sectional vision — one wallet can't see what other top wallets are doing in real time; we can.",
    risk_budget_usd: 100,
    strategies: [
      {
        slug: "consensus-tail-follow",
        name: "Consensus Tail Follow",
        thesis:
          "When 3+ DISTINCT CLUSTERS of conviction_trader wallets agree on a market+direction within 30min, that's two independent edges aligning: their own conviction + the cross-sectional pattern. Same-cluster wallets are collapsed via the wallet-clustering pre-pass so we don't double-count one bot operator running 5 wallets.",
        market_filter: {
          tags: ["any"],
          require_consensus: true,
          min_effective_wallets: 3,
        },
        initialSpec: {
          // Consensus tail-follow works in any regime — the signal is "smart
          // money agrees", not "market is trending/chopping". ["any"] is
          // correct here.
          regimes: ["any"],
          executor: "worker:consensus-exec",
          entry: { min_effective_wallets: 3, min_combined_trust: 5, max_lag_min: 15 },
          sizing: { per_signal_usd: 15, daily_usd_cap: 60 },
          exit: { type: "time_stop", hold_hours: 4 },
          env_to_arm_live: "CONSENSUS_AUTO_EXEC_LIVE=1",
          notes:
            "Uses the existing consensus-exec worker. Operator must create the 'consensus-auto' capsule and arm CONSENSUS_AUTO_EXEC_LIVE=1 to go live. Sim by default.",
        },
        rationale:
          "v1 — composes existing consensus-scan + consensus-exec workers. Adds the agent-as-owner pattern so the /agents UI shows this strategy's runtime + risk envelope.",
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
     VALUES (@strategy_id, NULL, 1, @spec_json, @rationale, 'human:gen2-seed', 1)`,
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
console.log(`[seed-gen2] complete: ${agentCount} agents, ${stratCount} strategies, ${versionCount} versions total.`);
console.log(`[seed-gen2] gen-2 agents: nereid-scrape, lyra-cross-timeframe, pulse-microstructure, drift-midwindow, hydra-consensus`);
console.log(`[seed-gen2] next steps:`);
console.log(`  - View at /agents`);
console.log(`  - Run scanners: scan:near-resolution, scan:cross-timeframe, scan:orderbook-imbalance`);
console.log(`  - For Nereid: create capsule 'near-resolution-scrape' + set NRS_LIVE=1 to arm`);
console.log(`  - For Hydra: create capsule 'consensus-auto' + set CONSENSUS_AUTO_EXEC_LIVE=1 to arm`);
console.log(`  - Lyra + Pulse have no auto-executors (CTS too fast, OBI observation-only)`);
