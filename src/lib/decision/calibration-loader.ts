/**
 * DB-side loader: pulls decision_journal rows + joins to trade outcomes.
 *
 * v1 outcome definition:
 *   - For decisions with order_id matching a fill in `trades` (live) or
 *     `paper_trades` (sim): `won = realized_pnl_usd > 0`.
 *   - For decisions with NO matching order (WATCHLIST / REJECTED): excluded
 *     (counterfactual data; we don't know what would have happened).
 *
 * v2 work item: include counterfactual data by replaying the paper trade
 * the strategy would have placed if the pipeline had approved — but that
 * requires the sim engine to record "shadow paper trades" alongside real ones.
 */
import { db } from "@/lib/db/client";
import type { LabeledDecision } from "./calibration";

export type CalibrationLoaderQuery = {
  /** ISO timestamp lower bound. Default: 30 days ago. */
  sinceTs?: string;
  /** Filter by strategy_kind. */
  strategyKind?: string;
  /** Filter by capsule_id. */
  capsuleId?: string;
  /** Hard cap. Default 1000. */
  limit?: number;
};

/**
 * Pulls journal rows with matching trade outcomes. Returns labeled rows
 * that can be fed directly to `buildCalibrationReport()`.
 *
 * Join strategy: LEFT JOIN against paper_trades.client_order_id =
 * decision_journal.order_id. Rows without a matching paper_trade are
 * dropped (no outcome to evaluate).
 *
 * Win definition: realized_pnl_usd > 0 on the EXIT trade (round-trip).
 * Entry trades that haven't exited yet are excluded.
 */
export function loadLabeledDecisions(q: CalibrationLoaderQuery = {}): LabeledDecision[] {
  const since = q.sinceTs ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
  const limit = Math.min(Math.max(10, q.limit ?? 1000), 10_000);

  // Match decision rows to paper_trades by order_id. For Phase 13 v1 we
  // restrict to executed decisions (order_id IS NOT NULL). The realized
  // PnL comes from the EXIT trade (kind = 'exit'); we sum if multiple.
  const params: Record<string, unknown> = { since, limit };
  const filters: string[] = ["d.ts >= @since", "d.order_id IS NOT NULL"];
  if (q.strategyKind) {
    filters.push("d.strategy_kind = @strategy_kind");
    params.strategy_kind = q.strategyKind;
  }
  if (q.capsuleId) {
    filters.push("d.capsule_id = @capsule_id");
    params.capsule_id = q.capsuleId;
  }

  // paper_trades schema check: client_order_id, realized_pnl_usd, kind
  // (kind='exit' rows carry the realized pnl for the round trip).
  const rows = db()
    .prepare(
      `SELECT
         d.id, d.approval_score, d.decision, d.strategy_kind, d.capsule_id,
         COALESCE(SUM(CASE WHEN pt.kind = 'exit' THEN pt.realized_pnl_usd ELSE 0 END), 0) AS realized_pnl
       FROM decision_journal d
       LEFT JOIN paper_trades pt ON pt.client_order_id = d.order_id
       WHERE ${filters.join(" AND ")}
       GROUP BY d.id
       HAVING SUM(CASE WHEN pt.kind = 'exit' THEN 1 ELSE 0 END) > 0
       ORDER BY d.ts DESC
       LIMIT @limit`,
    )
    .all(params) as Array<{
      id: number;
      approval_score: number;
      decision: string;
      strategy_kind: string;
      capsule_id: string | null;
      realized_pnl: number;
    }>;

  return rows.map((r) => ({
    id: r.id,
    approval_score: r.approval_score,
    decision: r.decision,
    strategy_kind: r.strategy_kind,
    capsule_id: r.capsule_id ?? undefined,
    won: r.realized_pnl > 0,
  }));
}
