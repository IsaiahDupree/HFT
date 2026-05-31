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
 * Join: a decision is "labeled" once the ENTRY paper_trade it produced
 * (paper_trades.decision_journal_id = decision_journal.id, stamped by the sim's
 * shadow-gate) has at least one EXIT (paper_trades.linked_entry_id → that entry)
 * carrying realized PnL. `won = net realized PnL > 0`. Decisions whose entry has
 * not exited yet are excluded (no outcome to grade).
 */
export function loadLabeledDecisions(q: CalibrationLoaderQuery = {}): LabeledDecision[] {
  const since = q.sinceTs ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
  const limit = Math.min(Math.max(10, q.limit ?? 1000), 10_000);

  const params: Record<string, unknown> = { since, limit };
  const filters: string[] = ["d.ts >= @since"];
  if (q.strategyKind) {
    filters.push("d.strategy_kind = @strategy_kind");
    params.strategy_kind = q.strategyKind;
  }
  if (q.capsuleId) {
    filters.push("d.capsule_id = @capsule_id");
    params.capsule_id = q.capsuleId;
  }

  // decision → entry trade (decision_journal_id) → exit trade (linked_entry_id,
  // realized_pnl_usd). INNER JOINs ensure only decisions with a realized exit.
  const rows = db()
    .prepare(
      `SELECT
         d.id, d.approval_score, d.decision, d.strategy_kind, d.capsule_id,
         COALESCE(SUM(x.realized_pnl_usd), 0) AS realized_pnl
       FROM decision_journal d
       JOIN paper_trades e ON e.decision_journal_id = d.id AND e.intent = 'entry'
       JOIN paper_trades x ON x.linked_entry_id = e.id AND x.intent = 'exit'
                          AND x.realized_pnl_usd IS NOT NULL
       WHERE ${filters.join(" AND ")}
       GROUP BY d.id
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
