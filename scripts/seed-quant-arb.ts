/**
 * Seeds the Quant-Arb agent + two strategies, plus a tracked_wallets table
 * for the 15 handles cited in the 0x_Discover article.
 * Idempotent — re-runnable.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";

const handle = db();

// 1. Schema migration: tracked_wallets table.
handle.exec(`
  CREATE TABLE IF NOT EXISTS tracked_wallets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    handle          TEXT UNIQUE NOT NULL,
    proxy_wallet    TEXT,
    note            TEXT,
    claimed_profit_usd REAL,
    strategy_label  TEXT,
    last_resolved   TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// 2. Seed the Quant-Arb agent.
handle.prepare(
  `INSERT INTO agents (slug, name, charter, risk_budget_usd)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(slug) DO UPDATE SET name=excluded.name, charter=excluded.charter, risk_budget_usd=excluded.risk_budget_usd, updated_at=datetime('now')`,
).run(
  "quant-arb",
  "Quant-Arb",
  "Quantitative arbitrage agent inspired by arxiv:2508.03474 (Saguillo et al.) and arxiv:1606.02825 (Kroer et al.). Runs single-market YES+NO arb detection live, scaffolds combinatorial arb detection (Frank-Wolfe + IP solver wiring is the next step), and copy-watches the 15 wallets cited in the 0x_Discover article (replay-only; does NOT auto-copy because copying lags by a block).",
  750,
);

const agentId = (handle.prepare("SELECT id FROM agents WHERE slug = 'quant-arb'").get() as any).id as number;

// 3. Seed two strategies under Quant-Arb.
const seedStrategy = handle.prepare(
  `INSERT INTO strategies (agent_id, slug, name, thesis, market_filter)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(agent_id, slug) DO UPDATE SET name=excluded.name, thesis=excluded.thesis, market_filter=excluded.market_filter`,
);
const findStrategy = handle.prepare("SELECT id FROM strategies WHERE agent_id = ? AND slug = ?");
const countVersions = handle.prepare("SELECT COUNT(*) AS n FROM strategy_versions WHERE strategy_id = ?");
const seedVersion = handle.prepare(
  `INSERT INTO strategy_versions (strategy_id, parent_version_id, version, spec_json, rationale, introduced_by, is_current)
   VALUES (?, NULL, 1, ?, ?, 'human', 1)`,
);

type StratSeed = { slug: string; name: string; thesis: string; market_filter: Record<string, unknown>; spec: Record<string, unknown>; rationale: string };
const strats: StratSeed[] = [
  {
    slug: "single-market-arb-scanner",
    name: "Single-Market Arb Scanner",
    thesis:
      "On any market with YES + NO ≠ $1 (specifically ask_yes + ask_no < $1 - fees), there's a guaranteed lock-in profit by buying both sides. The Probabilistic Forest paper documented 41% of 17,218 examined conditions exhibiting this. Most are captured by faster systems within seconds — we scan continuously and surface candidates that still have executable depth.",
    market_filter: { universe: "sampling-markets", min_executable_shares: 10, min_edge_bps: 50 },
    spec: {
      detector: "src/lib/polymarket/arb.ts:findSingleMarketArbs",
      params: { fee_bps: 50, depth_cap_fraction: 0.5, min_profit_usd: 0.5 },
      execution: { mode: "SHADOW", reason: "We surface arbs in the /arb UI but do NOT auto-execute until a same-block submission path is wired (Polygon block time ~2s, see article's latency hierarchy)." },
      cadence_seconds: 30,
    },
    rationale: "Initial baseline: live shadow-mode scan only. Real execution requires a same-block submission pipeline (websocket detect → signed parallel orders → bundled or back-to-back submit) that doesn't exist yet.",
  },
  {
    slug: "tracked-wallets-copier",
    name: "Tracked Wallets Replay",
    thesis:
      "Per the article: copy-trading fast wallets after the fact loses money (you're 1+ block behind, providing exit liquidity). Instead of copy-trading, *learn from* the trades — record what each tracked wallet does, what their priced edge was, how the price moved, and use that as training data for our own evaluators.",
    market_filter: { tracked_handles: "tracked_wallets table" },
    spec: {
      mode: "OBSERVE_ONLY",
      cadence_seconds: 300,
      datasource: { recent_trades: "GET /trades?user=<proxy_wallet>", positions: "GET /positions?user=<proxy_wallet>" },
      analytics: ["edge_realized_vs_priced", "hold_duration", "side_distribution", "market_categories"],
      do_not_auto_execute: true,
    },
    rationale: "Article makes the case explicit that naive copy-trading is unprofitable. This strategy is observe-only and feeds the rest of the system.",
  },
];

for (const s of strats) {
  seedStrategy.run(agentId, s.slug, s.name, s.thesis, JSON.stringify(s.market_filter));
  const stratId = (findStrategy.get(agentId, s.slug) as any).id as number;
  const existing = (countVersions.get(stratId) as any).n as number;
  if (existing === 0) {
    seedVersion.run(stratId, JSON.stringify(s.spec), s.rationale);
  }
}

// 4. Seed the 15 tracked wallets/handles from the article.
const tracked = [
  ["kch123", "Latency arb · high frequency", 12_000_000],
  ["RN1", "Market making · multi-market", 7_400_000],
  ["Swisstony", "Oracle arbitrage · Chainlink", 5_900_000],
  ["GamblingIsAllYouNeed", "News-driven · AI probability", 4_600_000],
  ["DrPufferfish", "Combinatorial arb · multi-market", 3_400_000],
  ["sovereign2013", "Latency arb · BTC/ETH contracts", 3_400_000],
  ["0x2a2C53bD27", "Market rebalancing · systematic (partial address from article)", 2_500_000],
  ["Countryside", "Election markets · base rate", 2_400_000],
  ["gatorr", "Latency arb · parallel execution", 2_300_000],
  ["weflyhigh", "Multi-strategy · diversified", 1_800_000],
  ["blindStaking", "Market making · liquidity provision", 1_500_000],
  ["CharlieKirkEvans", "Political markets · news arb", 1_200_000],
  ["JPMorgan101", "Institutional-style systematic", 1_100_000],
  ["cigarettes", "High-frequency · short contracts", 850_000],
  ["Sharky6999", "Latency arb · crypto contracts", 813_000],
] as const;

const upsertTracked = handle.prepare(
  `INSERT INTO tracked_wallets (handle, strategy_label, claimed_profit_usd, note)
   VALUES (?, ?, ?, 'From 0x_Discover article 2026-04-17 (arxiv:2508.03474 substrate)')
   ON CONFLICT(handle) DO UPDATE SET strategy_label=excluded.strategy_label, claimed_profit_usd=excluded.claimed_profit_usd`,
);
for (const [h, lbl, pnl] of tracked) upsertTracked.run(h, lbl, pnl);

// 5. Seed a substantive research note linking the article + papers.
const noteExists = handle.prepare("SELECT id FROM research_notes WHERE topic = ?").get(
  "Probabilistic Forest paper: $40M extraction roadmap",
);
if (!noteExists) {
  handle.prepare(
    `INSERT INTO research_notes (agent_id, topic, body, source_urls_json, confidence, tags_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    agentId,
    "Probabilistic Forest paper: $40M extraction roadmap",
    `Saguillo, Ghafouri, Kiffer, and Suarez-Tangil (arxiv:2508.03474, 2025) document **$39.7M of guaranteed arbitrage extracted from Polymarket** between April 2024 and April 2025. Top single trader: $2.0M across 4,049 trades (mean $496/trade). Out of 17,218 conditions examined, **41% exhibited single-market arbitrage** with median mispricing $0.60.

The companion theoretical paper Kroer et al. (arxiv:1606.02825, 2016) defines the **arbitrage-free combinatorial market making** problem and gives the Frank-Wolfe + IP-solver scheme used to make Bregman projection tractable on outcome spaces up to 2^63 (NCAA 2010 tournament, 63 games). Late in the tournament the FW method beat baselines by **38% on median security prices** because feasible-set shrinkage made IP subproblems fast.

For this codebase, the practical implications are:
1. Single-market arb (YES+NO < $1) is implemented in \`src/lib/polymarket/arb.ts:findSingleMarketArbs\` and surfaced live at /arb. **Execution is shadow-only** — capturing requires same-block submission.
2. Combinatorial arb is scaffolded with a brute-force fallback for tiny universes; the production pipeline needs a Frank-Wolfe + IP-solver hookup (Gurobi or HiGHS via WASM for browser, or a Python sidecar) before it produces actionable outputs at scale.
3. Copy-trading the listed wallets is documented in the article as **net-negative** for retail (you're 1+ block late). The Tracked Wallets Replay strategy is observe-only by design — it produces analytics, not orders.

Risk caveat: the article ends with a promotional airdrop section. This codebase **does not engage with that link**; we use only the analytical content.`,
    JSON.stringify([
      "https://arxiv.org/abs/2508.03474",
      "https://arxiv.org/abs/1606.02825",
      "docs/research/articles/0x_discover-polymarket-40m-arb.md",
    ]),
    0.85,
    JSON.stringify(["arbitrage", "frank-wolfe", "bregman", "primary-source", "execution"]),
  );
}

console.log("Quant-Arb seed complete.");
console.log("  agents:           ", (handle.prepare("SELECT COUNT(*) AS n FROM agents").get() as any).n);
console.log("  strategies:       ", (handle.prepare("SELECT COUNT(*) AS n FROM strategies").get() as any).n);
console.log("  strategy_versions:", (handle.prepare("SELECT COUNT(*) AS n FROM strategy_versions").get() as any).n);
console.log("  tracked_wallets:  ", (handle.prepare("SELECT COUNT(*) AS n FROM tracked_wallets").get() as any).n);
