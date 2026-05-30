/**
 * Decision journal — persists every per-trade decision (approved, reduced,
 * watchlist, rejected, kill-switched) to the `decision_journal` table.
 *
 * The orchestrator calls `recordDecision()` at the end of every pipeline
 * run, regardless of outcome. This is the audit log that powers the
 * `/decisions` UI and feeds post-trade decision-quality analysis.
 *
 * Pure persistence layer — no decision logic lives here. The pipeline
 * decides; the journal records.
 */
import { db } from "@/lib/db/client";
import type { DecisionContext, DecisionResult } from "./types";

/**
 * Write one row to `decision_journal`. Idempotency: caller is responsible
 * for not double-recording the same decision; the table has no UNIQUE
 * constraint on (ts, capsule_id) to avoid blocking legitimate retries.
 */
export function recordDecision(
  ctx: DecisionContext,
  result: DecisionResult,
  opts: { orderId?: string } = {},
): number {
  const approvedSizeUsd = ctx.proposal.sizeUsd * result.size_multiplier;
  const row = db()
    .prepare(
      `INSERT INTO decision_journal
         (ts, agent_id, capsule_id, strategy_version_id, strategy_kind,
          venue, symbol, side, condition_id,
          proposed_size_usd, approved_size_usd, proposed_price,
          decision, approval_score, size_multiplier,
          proposal_json, snapshot_json, gate_results_json, order_id)
       VALUES
         (@ts, @agent_id, @capsule_id, @strategy_version_id, @strategy_kind,
          @venue, @symbol, @side, @condition_id,
          @proposed_size_usd, @approved_size_usd, @proposed_price,
          @decision, @approval_score, @size_multiplier,
          @proposal_json, @snapshot_json, @gate_results_json, @order_id)`,
    )
    .run({
      ts: result.decision_ts,
      agent_id: ctx.agentId,
      capsule_id: ctx.capsuleId,
      strategy_version_id: ctx.strategyVersionId ?? null,
      strategy_kind: ctx.strategyKind,
      venue: ctx.proposal.venue,
      symbol: ctx.proposal.symbol,
      side: ctx.proposal.side,
      condition_id: ctx.proposal.conditionId ?? null,
      proposed_size_usd: ctx.proposal.sizeUsd,
      approved_size_usd: approvedSizeUsd,
      proposed_price: ctx.proposal.price,
      decision: result.decision,
      approval_score: result.approval_score,
      size_multiplier: result.size_multiplier,
      proposal_json: JSON.stringify(ctx.proposal),
      snapshot_json: ctx.snapshot ? JSON.stringify(ctx.snapshot) : null,
      gate_results_json: JSON.stringify(result.gate_results),
      order_id: opts.orderId ?? null,
    });
  return Number(row.lastInsertRowid);
}

/**
 * After an order submits successfully, patch the order_id onto the
 * already-written journal row. Used by `live-capsule.ts` post-submit so
 * the journal links to the actual placed order.
 */
export function attachOrderId(journalId: number, orderId: string): void {
  db().prepare("UPDATE decision_journal SET order_id = ? WHERE id = ?").run(orderId, journalId);
}

/**
 * Read journal rows (for the /decisions UI, tests, and post-trade analysis).
 * Returns rows ordered by ts DESC.
 */
export type DecisionJournalRow = {
  id: number;
  ts: string;
  agent_id: number | null;
  capsule_id: string | null;
  strategy_version_id: number | null;
  strategy_kind: string;
  venue: string;
  symbol: string;
  side: "BUY" | "SELL";
  condition_id: string | null;
  proposed_size_usd: number;
  approved_size_usd: number;
  proposed_price: number;
  decision: string;
  approval_score: number;
  size_multiplier: number;
  proposal_json: string;
  snapshot_json: string | null;
  gate_results_json: string;
  order_id: string | null;
  created_at: string;
};

export type JournalQuery = {
  limit?: number;
  capsuleId?: string;
  decision?: string;
  strategyKind?: string;
  /** ISO timestamp lower bound (inclusive). */
  sinceTs?: string;
};

export function readRecentDecisions(q: JournalQuery = {}): DecisionJournalRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (q.capsuleId) {
    where.push("capsule_id = @capsule_id");
    params.capsule_id = q.capsuleId;
  }
  if (q.decision) {
    where.push("decision = @decision");
    params.decision = q.decision;
  }
  if (q.strategyKind) {
    where.push("strategy_kind = @strategy_kind");
    params.strategy_kind = q.strategyKind;
  }
  if (q.sinceTs) {
    where.push("ts >= @since_ts");
    params.since_ts = q.sinceTs;
  }
  const whereClause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  const limit = Math.min(Math.max(1, q.limit ?? 50), 500);
  return db()
    .prepare(
      `SELECT * FROM decision_journal
        ${whereClause}
        ORDER BY ts DESC
        LIMIT ${limit}`,
    )
    .all(params) as DecisionJournalRow[];
}
