/**
 * Arena DB layer — typed reads/writes that hide raw SQL from callers.
 *
 * All functions take the singleton `db()` handle so tests can swap to an
 * in-memory DB via the standard vi.mock pattern in tests/integration/.
 */
import { db } from "@/lib/db/client";
import { parseGenome, serializeGenome, type Genome } from "./genome";
import type { GenerationRow, LiveAgent, PaperAgentRow, PaperTradeRow, Position } from "./types";

export type CreatePaperAgentInput = {
  name: string;
  generation: number;
  parent_paper_agent_id?: number | null;
  genome: Genome;
  introduced_by?: string;
  cash_usd_start?: number;
};

export function insertPaperAgent(input: CreatePaperAgentInput): number {
  const stmt = db().prepare(
    `INSERT INTO paper_agents
       (name, generation, parent_paper_agent_id, genome_json, introduced_by, cash_usd_start, cash_usd_current, peak_equity_usd)
     VALUES (@name, @generation, @parent_paper_agent_id, @genome_json, @introduced_by, @cash, @cash, @cash)`,
  );
  const result = stmt.run({
    name: input.name,
    generation: input.generation,
    parent_paper_agent_id: input.parent_paper_agent_id ?? null,
    genome_json: serializeGenome(input.genome),
    introduced_by: input.introduced_by ?? "init",
    cash: input.cash_usd_start ?? 1000,
  });
  return Number(result.lastInsertRowid);
}

export function listAliveAgentsForGen(gen: number): PaperAgentRow[] {
  return db().prepare(`SELECT * FROM paper_agents WHERE generation = ? AND alive = 1 ORDER BY id`).all(gen) as PaperAgentRow[];
}

export function listAllAgentsForGen(gen: number): PaperAgentRow[] {
  return db().prepare(`SELECT * FROM paper_agents WHERE generation = ? ORDER BY id`).all(gen) as PaperAgentRow[];
}

export function listAliveAgentsAcrossGens(): PaperAgentRow[] {
  return db().prepare(`SELECT * FROM paper_agents WHERE alive = 1 ORDER BY generation, id`).all() as PaperAgentRow[];
}

export function getPaperAgent(id: number): PaperAgentRow | undefined {
  return db().prepare(`SELECT * FROM paper_agents WHERE id = ?`).get(id) as PaperAgentRow | undefined;
}

export function toLiveAgent(row: PaperAgentRow): LiveAgent {
  return {
    ...row,
    genome: parseGenome(row.genome_json),
    positions: JSON.parse(row.position_basket_json) as Position[],
  };
}

export function persistAgentTick(agent: LiveAgent): void {
  const stmt = db().prepare(
    `UPDATE paper_agents SET
       cash_usd_current = @cash, position_basket_json = @positions,
       realized_pnl_usd = @realized, unrealized_pnl_usd = @unr,
       peak_equity_usd = @peak, max_drawdown_usd = @dd,
       trades_count = @trades, entries_count = @entries, wins_count = @wins, updated_at = datetime('now')
     WHERE id = @id`,
  );
  stmt.run({
    id: agent.id, cash: agent.cash_usd_current, positions: JSON.stringify(agent.positions),
    realized: agent.realized_pnl_usd, unr: agent.unrealized_pnl_usd,
    peak: agent.peak_equity_usd, dd: agent.max_drawdown_usd,
    trades: agent.trades_count, entries: agent.entries_count, wins: agent.wins_count,
  });
}

export function retireAgent(id: number, reason: string): void {
  // Demote elite status if it was set — a retired agent can't be an elite.
  db().prepare(
    `UPDATE paper_agents SET alive = 0, is_elite = 0, retire_reason = ?, retired_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
  ).run(reason, id);
}

/** Promote an agent to elite status. Elites are protected from cull at seal
 *  time and tick across generations. Idempotent — setting an already-elite
 *  agent is a no-op. */
export function markElite(id: number): void {
  db().prepare(
    `UPDATE paper_agents SET is_elite = 1, updated_at = datetime('now') WHERE id = ? AND alive = 1`,
  ).run(id);
}

/** Demote an agent from elite status without retiring it. Used when an elite
 *  exceeds the drawdown threshold but should remain alive and re-enter the
 *  normal cull pool. */
export function demoteElite(id: number): void {
  db().prepare(
    `UPDATE paper_agents SET is_elite = 0, updated_at = datetime('now') WHERE id = ?`,
  ).run(id);
}

/** List all alive elites across every generation. Used by arena-tick so
 *  preserved agents continue to receive ticks even after their birth gen
 *  sealed. */
export function listAliveElites(): PaperAgentRow[] {
  return db().prepare(
    `SELECT * FROM paper_agents WHERE alive = 1 AND is_elite = 1 ORDER BY id`,
  ).all() as PaperAgentRow[];
}

/** Agents with a paper/live capsule binding. These MUST be ticked every
 *  cycle regardless of generation or elite status — otherwise a real-money
 *  capsule is bound to an agent that no longer fires signals. */
export function listAliveAgentsWithLiveCapsule(): PaperAgentRow[] {
  return db().prepare(
    `SELECT pa.* FROM paper_agents pa
       INNER JOIN capsules c ON c.paper_agent_id = pa.id
      WHERE pa.alive = 1 AND c.status IN ('paper','live')
      ORDER BY pa.id`,
  ).all() as PaperAgentRow[];
}

/** Agents holding a position on the given token, regardless of alive status.
 *  Used by the binary resolver so positions on retired agents still settle
 *  correctly (previously these were stranded — a position opened on tick T,
 *  the agent retired on tick T+1's seal, the binary expired on tick T+2,
 *  but the resolver only iterated alive agents → position never paid out). */
export function listAgentsHoldingPosition(marketId: string): PaperAgentRow[] {
  return db().prepare(
    `SELECT * FROM paper_agents
      WHERE position_basket_json LIKE '%' || ? || '%'
        AND (retired_at IS NULL OR retired_at > datetime('now', '-7 days'))
      ORDER BY id`,
  ).all(marketId) as PaperAgentRow[];
}

export function insertPaperTrade(t: Omit<PaperTradeRow, "id">): number {
  const stmt = db().prepare(
    `INSERT INTO paper_trades
       (paper_agent_id, venue, market_id, side, intent, price, size_usd, fee_usd, realized_pnl_usd, linked_entry_id, signal_rationale, tick_at, generation)
     VALUES (@paper_agent_id, @venue, @market_id, @side, @intent, @price, @size_usd, @fee_usd, @realized_pnl_usd, @linked_entry_id, @signal_rationale, @tick_at, @generation)`,
  );
  const r = stmt.run(t);
  return Number(r.lastInsertRowid);
}

export function listTradesForAgent(agentId: number, limit = 500): PaperTradeRow[] {
  return db().prepare(`SELECT * FROM paper_trades WHERE paper_agent_id = ? ORDER BY id DESC LIMIT ?`).all(agentId, limit) as PaperTradeRow[];
}

/** Walks the parent chain of a paper_agent back to its root (no parent). */
export function lineageRoot(id: number): PaperAgentRow | undefined {
  let cur = getPaperAgent(id);
  while (cur && cur.parent_paper_agent_id != null) {
    const next = getPaperAgent(cur.parent_paper_agent_id);
    if (!next) break;
    cur = next;
  }
  return cur;
}

/** Returns every descendant of `rootId` (inclusive), breadth-first by generation. */
export function lineageDescendants(rootId: number): PaperAgentRow[] {
  const out: PaperAgentRow[] = [];
  const queue: number[] = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = getPaperAgent(id);
    if (!node) continue;
    out.push(node);
    const children = db().prepare(
      `SELECT id FROM paper_agents WHERE parent_paper_agent_id = ? ORDER BY id`,
    ).all(id) as Array<{ id: number }>;
    for (const c of children) queue.push(c.id);
  }
  return out;
}

/**
 * Build a (time, equity) series for an agent from paper_trades realized PnL +
 * the starting cash. Used by the equity-curve sparkline. Returns equity
 * AFTER each closed trade, in chronological order.
 */
export function equityCurveForAgent(agentId: number): Array<{ at: string; equity: number }> {
  const agent = getPaperAgent(agentId);
  if (!agent) return [];
  const trades = db().prepare(
    `SELECT tick_at, realized_pnl_usd FROM paper_trades
       WHERE paper_agent_id = ? AND realized_pnl_usd IS NOT NULL
       ORDER BY id ASC`,
  ).all(agentId) as Array<{ tick_at: string; realized_pnl_usd: number }>;
  let equity = agent.cash_usd_start;
  const out: Array<{ at: string; equity: number }> = [{ at: agent.created_at, equity }];
  for (const t of trades) {
    equity += t.realized_pnl_usd ?? 0;
    out.push({ at: t.tick_at, equity });
  }
  // Append the current mark-to-market point so the line ends at "now". Must
  // include locked principal (open-position size) so an entry without exit
  // doesn't appear as a loss equal to its size. Bug-fix 2026-05-25.
  let openPrincipal = 0;
  try {
    const positions = JSON.parse(agent.position_basket_json || "[]") as Array<{ size_usd?: number }>;
    for (const p of positions) openPrincipal += Number(p.size_usd ?? 0);
  } catch { /* keep 0 */ }
  const liveEquity = agent.cash_usd_current + openPrincipal + agent.unrealized_pnl_usd;
  if (out[out.length - 1].equity !== liveEquity) {
    out.push({ at: agent.updated_at, equity: liveEquity });
  }
  return out;
}

/**
 * Batched equity curves for many agents in a single round-trip. Returns a Map
 * keyed by agent id → equity series. Each series starts at the agent's
 * `cash_usd_start` and accumulates `realized_pnl_usd` per trade, then appends
 * the current mark-to-market point. Used by the /arena leaderboard sparkline
 * column so we don't issue N queries for N agents.
 */
export function equityCurvesForAgents(agentIds: number[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  if (agentIds.length === 0) return out;
  const placeholders = agentIds.map(() => "?").join(",");
  // Include open-position principal via json_each so the tail point reflects
  // true equity, not "lost the position size on entry". Bug-fix 2026-05-25.
  const agents = db().prepare(
    `SELECT id, cash_usd_start, cash_usd_current, unrealized_pnl_usd,
            IFNULL((SELECT SUM(json_extract(value, '$.size_usd'))
                      FROM json_each(position_basket_json)), 0) AS open_principal
       FROM paper_agents WHERE id IN (${placeholders})`,
  ).all(...agentIds) as Array<{ id: number; cash_usd_start: number; cash_usd_current: number; unrealized_pnl_usd: number; open_principal: number }>;
  const trades = db().prepare(
    `SELECT paper_agent_id, realized_pnl_usd FROM paper_trades
       WHERE paper_agent_id IN (${placeholders}) AND realized_pnl_usd IS NOT NULL
       ORDER BY paper_agent_id, id ASC`,
  ).all(...agentIds) as Array<{ paper_agent_id: number; realized_pnl_usd: number }>;
  const byAgent = new Map<number, number[]>();
  for (const a of agents) byAgent.set(a.id, [a.cash_usd_start]);
  for (const t of trades) {
    const series = byAgent.get(t.paper_agent_id);
    if (!series) continue;
    series.push(series[series.length - 1] + (t.realized_pnl_usd ?? 0));
  }
  for (const a of agents) {
    const series = byAgent.get(a.id) ?? [a.cash_usd_start];
    const live = a.cash_usd_current + (a.open_principal ?? 0) + a.unrealized_pnl_usd;
    if (series[series.length - 1] !== live) series.push(live);
    out.set(a.id, series);
  }
  return out;
}

// --- generations ---

export function getCurrentGeneration(): GenerationRow | undefined {
  return db().prepare(`SELECT * FROM paper_generations WHERE sealed_at IS NULL ORDER BY gen_number DESC LIMIT 1`).get() as GenerationRow | undefined;
}

export function listGenerations(limit = 25): GenerationRow[] {
  return db().prepare(`SELECT * FROM paper_generations ORDER BY gen_number DESC LIMIT ?`).all(limit) as GenerationRow[];
}

export function startGeneration(gen_number: number, replay?: { start: string; end: string }, notes?: string): number {
  const r = db().prepare(
    `INSERT INTO paper_generations (gen_number, replay_window_start, replay_window_end, notes)
     VALUES (?, ?, ?, ?)`,
  ).run(gen_number, replay?.start ?? null, replay?.end ?? null, notes ?? null);
  return Number(r.lastInsertRowid);
}

export function setGenerationAgentCount(genId: number, n: number): void {
  db().prepare(`UPDATE paper_generations SET n_agents = ? WHERE id = ?`).run(n, genId);
}

/** Bump tick_count on the current open generation. Returns the new value. */
export function incrementGenerationTickCount(genId: number): number {
  db().prepare(`UPDATE paper_generations SET tick_count = COALESCE(tick_count, 0) + 1 WHERE id = ?`).run(genId);
  return ((db().prepare(`SELECT tick_count FROM paper_generations WHERE id = ?`).get(genId) as { tick_count: number | null } | undefined)?.tick_count) ?? 0;
}

export function sealGeneration(genId: number, opts: { n_alive: number; top_agent_id: number | null; top_score: number | null; n_promoted_children: number }): void {
  db().prepare(
    `UPDATE paper_generations SET
       sealed_at = datetime('now'),
       n_alive_at_seal = @n_alive,
       top_paper_agent_id = @top,
       top_score = @score,
       n_promoted_children = @n_promoted
     WHERE id = @id`,
  ).run({ id: genId, n_alive: opts.n_alive, top: opts.top_agent_id, score: opts.top_score, n_promoted: opts.n_promoted_children });
}

// --- championship log ---

export function recordChampionship(paperAgentId: number, consecutiveWins: number, rationale: string): number {
  const r = db().prepare(
    `INSERT INTO championship_log (paper_agent_id, consecutive_gen_wins, rationale) VALUES (?, ?, ?)`,
  ).run(paperAgentId, consecutiveWins, rationale);
  return Number(r.lastInsertRowid);
}

export function listChampionships(limit = 25): Array<{ id: number; paper_agent_id: number; consecutive_gen_wins: number; capsule_id: string | null; status: string; rationale: string | null; created_at: string }> {
  return db().prepare(`SELECT * FROM championship_log ORDER BY id DESC LIMIT ?`).all(limit) as any[];
}

export function attachCapsuleToChampionship(championshipId: number, capsuleId: string, status: "proposed" | "activated" = "proposed"): void {
  db().prepare(`UPDATE championship_log SET capsule_id = ?, status = ? WHERE id = ?`).run(capsuleId, status, championshipId);
}
