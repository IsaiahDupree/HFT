import { db } from "./client";

export type Agent = {
  id: number;
  slug: string;
  name: string;
  charter: string;
  risk_budget_usd: number;
  status: string;
  created_at: string;
  updated_at: string;
};

export type Strategy = {
  id: number;
  agent_id: number;
  slug: string;
  name: string;
  thesis: string;
  market_filter: string;
  status: string;
  created_at: string;
};

export type StrategyVersion = {
  id: number;
  strategy_id: number;
  parent_version_id: number | null;
  version: number;
  spec_json: string;
  rationale: string;
  introduced_by: string;
  backtest_summary: string | null;
  is_current: 0 | 1;
  created_at: string;
};

export function listAgents(): Agent[] {
  return db().prepare("SELECT * FROM agents ORDER BY id").all() as Agent[];
}

export function getAgentBySlug(slug: string): Agent | undefined {
  return db().prepare("SELECT * FROM agents WHERE slug = ?").get(slug) as Agent | undefined;
}

export function listStrategiesForAgent(agentId: number): Strategy[] {
  return db().prepare("SELECT * FROM strategies WHERE agent_id = ? ORDER BY id").all(agentId) as Strategy[];
}

export function listAllStrategies(): (Strategy & { agent_name: string; agent_slug: string })[] {
  return db()
    .prepare(
      `SELECT s.*, a.name AS agent_name, a.slug AS agent_slug
       FROM strategies s JOIN agents a ON a.id = s.agent_id
       ORDER BY a.id, s.id`,
    )
    .all() as any[];
}

export function currentVersion(strategyId: number): StrategyVersion | undefined {
  return db()
    .prepare("SELECT * FROM strategy_versions WHERE strategy_id = ? AND is_current = 1")
    .get(strategyId) as StrategyVersion | undefined;
}

export function listVersions(strategyId: number): StrategyVersion[] {
  return db()
    .prepare("SELECT * FROM strategy_versions WHERE strategy_id = ? ORDER BY version DESC")
    .all(strategyId) as StrategyVersion[];
}

export function listTradesForStrategy(strategyId: number) {
  return db()
    .prepare(
      `SELECT t.*
       FROM trades t JOIN strategy_versions v ON v.id = t.strategy_version_id
       WHERE v.strategy_id = ?
       ORDER BY t.opened_at DESC`,
    )
    .all(strategyId) as any[];
}

export function listRecentTrades(limit = 50) {
  return db()
    .prepare(
      `SELECT t.*, s.name AS strategy_name, a.name AS agent_name, a.slug AS agent_slug, s.slug AS strategy_slug
       FROM trades t
       JOIN strategy_versions v ON v.id = t.strategy_version_id
       JOIN strategies s ON s.id = v.strategy_id
       JOIN agents a ON a.id = s.agent_id
       ORDER BY t.opened_at DESC LIMIT ?`,
    )
    .all(limit) as any[];
}

export function listResearchNotes(limit = 100) {
  return db()
    .prepare(
      `SELECT n.*, a.name AS agent_name, s.name AS strategy_name
       FROM research_notes n
       LEFT JOIN agents a ON a.id = n.agent_id
       LEFT JOIN strategies s ON s.id = n.strategy_id
       ORDER BY n.created_at DESC LIMIT ?`,
    )
    .all(limit) as any[];
}

export function listEvolutionEvents(limit = 50) {
  return db()
    .prepare(
      `SELECT e.*, a.name AS agent_name, s.name AS strategy_name
       FROM evolution_log e
       LEFT JOIN agents a ON a.id = e.agent_id
       LEFT JOIN strategies s ON s.id = e.strategy_id
       ORDER BY e.created_at DESC LIMIT ?`,
    )
    .all(limit) as any[];
}

export function performanceFor(strategyVersionId: number) {
  return db()
    .prepare("SELECT * FROM performance_metrics WHERE strategy_version_id = ? ORDER BY window")
    .all(strategyVersionId) as any[];
}

export function recordMarketSnapshot(snapshot: {
  condition_id: string;
  token_id: string;
  question: string;
  yes_price?: number | null;
  no_price?: number | null;
  midpoint?: number | null;
  spread?: number | null;
  volume_24h?: number | null;
  open_interest?: number | null;
  liquidity_usd?: number | null;
  /** Category tag from `classifyMarket`. Optional — caller passes when known
   *  (snapshot worker has the question, so always passes). */
  category?: string | null;
}) {
  return db()
    .prepare(
      `INSERT INTO market_snapshots
         (condition_id, token_id, question, yes_price, no_price, midpoint, spread, volume_24h, open_interest, liquidity_usd, category)
       VALUES (@condition_id, @token_id, @question, @yes_price, @no_price, @midpoint, @spread, @volume_24h, @open_interest, @liquidity_usd, @category)`,
    )
    .run({ category: null, ...snapshot });
}

export function latestSnapshotFor(tokenId: string) {
  return db()
    .prepare("SELECT * FROM market_snapshots WHERE token_id = ? ORDER BY captured_at DESC LIMIT 1")
    .get(tokenId) as any;
}

export function insertEvolutionEvent(event: {
  agent_id?: number;
  strategy_id?: number;
  from_version_id?: number;
  to_version_id?: number;
  event_type: string;
  summary: string;
  payload_json?: string;
}) {
  return db()
    .prepare(
      `INSERT INTO evolution_log (agent_id, strategy_id, from_version_id, to_version_id, event_type, summary, payload_json)
       VALUES (@agent_id, @strategy_id, @from_version_id, @to_version_id, @event_type, @summary, @payload_json)`,
    )
    .run({
      agent_id: event.agent_id ?? null,
      strategy_id: event.strategy_id ?? null,
      from_version_id: event.from_version_id ?? null,
      to_version_id: event.to_version_id ?? null,
      event_type: event.event_type,
      summary: event.summary,
      payload_json: event.payload_json ?? "{}",
    });
}

export function insertResearchNote(note: {
  agent_id?: number;
  strategy_id?: number;
  market_condition_id?: string;
  topic: string;
  body: string;
  source_urls_json?: string;
  confidence?: number;
  tags_json?: string;
}) {
  return db()
    .prepare(
      `INSERT INTO research_notes
        (agent_id, strategy_id, market_condition_id, topic, body, source_urls_json, confidence, tags_json)
       VALUES (@agent_id, @strategy_id, @market_condition_id, @topic, @body, @source_urls_json, @confidence, @tags_json)`,
    )
    .run({
      agent_id: note.agent_id ?? null,
      strategy_id: note.strategy_id ?? null,
      market_condition_id: note.market_condition_id ?? null,
      topic: note.topic,
      body: note.body,
      source_urls_json: note.source_urls_json ?? "[]",
      confidence: note.confidence ?? 0.5,
      tags_json: note.tags_json ?? "[]",
    });
}
