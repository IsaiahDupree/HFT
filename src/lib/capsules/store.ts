import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import type { Capsule, CapsuleStatus } from "./types";

/**
 * CapsuleStore — thin DB layer over the `capsules` table.
 * Stores allowed_venues / allowed_symbols as JSON columns; rehydrates them
 * on read so callers always see typed arrays.
 */

type Row = {
  id: string;
  agent_id: number | null;
  strategy_id: number | null;
  name: string;
  status: CapsuleStatus;
  capital_allocated_usd: number;
  capital_deployed_usd: number;
  capital_available_usd: number;
  max_daily_loss_usd: number;
  max_total_drawdown_usd: number;
  max_position_pct: number;
  max_open_positions: number;
  max_trades_per_day: number;
  allowed_venues_json: string;
  allowed_symbols_json: string | null;
  min_seconds_between_trades: number;
  current_pnl_usd: number;
  daily_pnl_usd: number;
  open_positions: number;
  trades_today: number;
  open_position_qty: number;
  open_position_cost_usd: number;
  daily_pnl_reset_date: string | null;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
};

function rowToCapsule(r: Row): Capsule {
  return {
    id: r.id,
    agent_id: r.agent_id,
    strategy_id: r.strategy_id,
    name: r.name,
    status: r.status,
    capital_allocated_usd: r.capital_allocated_usd,
    capital_deployed_usd: r.capital_deployed_usd,
    capital_available_usd: r.capital_available_usd,
    max_daily_loss_usd: r.max_daily_loss_usd,
    max_total_drawdown_usd: r.max_total_drawdown_usd,
    max_position_pct: r.max_position_pct,
    max_open_positions: r.max_open_positions,
    max_trades_per_day: r.max_trades_per_day,
    allowed_venues: safeJsonArray(r.allowed_venues_json),
    allowed_symbols: r.allowed_symbols_json == null ? null : safeJsonArray(r.allowed_symbols_json),
    min_seconds_between_trades: r.min_seconds_between_trades,
    current_pnl_usd: r.current_pnl_usd,
    daily_pnl_usd: r.daily_pnl_usd,
    open_positions: r.open_positions,
    trades_today: r.trades_today,
    open_position_qty: r.open_position_qty ?? 0,
    open_position_cost_usd: r.open_position_cost_usd ?? 0,
    daily_pnl_reset_date: r.daily_pnl_reset_date ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    activated_at: r.activated_at,
  };
}

function safeJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function listCapsules(opts: { status?: CapsuleStatus; agentId?: number } = {}): Capsule[] {
  let sql = "SELECT * FROM capsules";
  const wh: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.status) {
    wh.push("status = @status");
    params.status = opts.status;
  }
  if (opts.agentId != null) {
    wh.push("agent_id = @agentId");
    params.agentId = opts.agentId;
  }
  if (wh.length) sql += " WHERE " + wh.join(" AND ");
  sql += " ORDER BY created_at DESC";
  return (db().prepare(sql).all(params) as Row[]).map(rowToCapsule);
}

export function getCapsule(id: string): Capsule | null {
  const row = db().prepare("SELECT * FROM capsules WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToCapsule(row) : null;
}

export type CreateCapsuleInput = {
  name: string;
  agentId?: number;
  strategyId?: number;
  capitalUsd: number;
  allowedVenues: string[];
  allowedSymbols?: string[];
  maxDailyLossUsd?: number;
  maxTotalDrawdownUsd?: number;
  maxPositionPct?: number;
  maxOpenPositions?: number;
  maxTradesPerDay?: number;
  minSecondsBetweenTrades?: number;
};

export function createCapsule(input: CreateCapsuleInput): Capsule {
  const id = randomUUID();
  db()
    .prepare(
      `INSERT INTO capsules
         (id, agent_id, strategy_id, name, status,
          capital_allocated_usd, capital_deployed_usd, capital_available_usd,
          max_daily_loss_usd, max_total_drawdown_usd, max_position_pct,
          max_open_positions, max_trades_per_day,
          allowed_venues_json, allowed_symbols_json, min_seconds_between_trades)
       VALUES
         (@id, @agent_id, @strategy_id, @name, 'draft',
          @cap, 0.0, @cap,
          @mdl, @mtd, @mpp,
          @mop, @mtpd,
          @venues, @symbols, @cooldown)`,
    )
    .run({
      id,
      agent_id: input.agentId ?? null,
      strategy_id: input.strategyId ?? null,
      name: input.name,
      cap: input.capitalUsd,
      mdl: input.maxDailyLossUsd ?? 0,
      mtd: input.maxTotalDrawdownUsd ?? 0,
      mpp: input.maxPositionPct ?? 0,
      mop: input.maxOpenPositions ?? 0,
      mtpd: input.maxTradesPerDay ?? 0,
      venues: JSON.stringify(input.allowedVenues),
      symbols: input.allowedSymbols ? JSON.stringify(input.allowedSymbols) : null,
      cooldown: input.minSecondsBetweenTrades ?? 0,
    });
  return getCapsule(id)!;
}

export function setStatus(id: string, status: CapsuleStatus): void {
  const activatedClause = status === "paper" || status === "live"
    ? ", activated_at = COALESCE(activated_at, datetime('now'))"
    : "";
  db()
    .prepare(`UPDATE capsules SET status = ?, updated_at = datetime('now')${activatedClause} WHERE id = ?`)
    .run(status, id);
}

/**
 * Defense-in-depth: hardcoded set of column names this function is allowed to
 * write. The TS type also constrains keys, but a non-API caller could
 * theoretically pass anything at runtime. Filter against this set before
 * building the SQL assignments. Audit fix F5.
 */
const REALTIME_ALLOWED_FIELDS = new Set([
  "current_pnl_usd", "daily_pnl_usd",
  "capital_deployed_usd", "capital_available_usd",
  "open_positions", "trades_today",
  "open_position_qty", "open_position_cost_usd",
  "daily_pnl_reset_date",
]);

export function updateRealtime(
  id: string,
  patch: Partial<Pick<Capsule,
    "current_pnl_usd" | "daily_pnl_usd" | "capital_deployed_usd" | "capital_available_usd" |
    "open_positions" | "trades_today" | "open_position_qty" | "open_position_cost_usd" | "daily_pnl_reset_date"
  >>,
): void {
  const fields = Object.keys(patch).filter((f) => REALTIME_ALLOWED_FIELDS.has(f));
  if (fields.length === 0) return;
  // Per-key SQL identifier safety check (belt + suspenders): every name must
  // already be in the allow-list. The filter above guarantees this, but the
  // explicit identifier-shape assertion makes the SQL boundary explicit.
  if (fields.some((f) => !/^[a-z_][a-z0-9_]*$/i.test(f))) {
    throw new Error(`updateRealtime: rejected non-identifier field name`);
  }
  const assignments = fields.map((f) => `${f} = @${f}`).join(", ");
  db()
    .prepare(`UPDATE capsules SET ${assignments}, updated_at = datetime('now') WHERE id = @id`)
    .run({ id, ...patch });
}

export function deleteCapsule(id: string): void {
  db().prepare("DELETE FROM capsules WHERE id = ?").run(id);
}
