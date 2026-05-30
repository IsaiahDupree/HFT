import { db } from "@/lib/db/client";
import { insertEvolutionEvent } from "@/lib/db/queries";
import {
  canPromoteTo,
  STAGES_ALLOW_LIVE,
  STAGES_ALLOW_PAPER,
  type ReleaseStage,
} from "./types";

/**
 * Stage gate — checks whether a given strategy_version may submit live or
 * paper trades. Used by the router (when wired through strategyVersionId)
 * AND by the UI when surfacing "promote to live" buttons.
 */

export type VersionStageRow = {
  id: number;
  strategy_id: number;
  version: number;
  stage: ReleaseStage;
  is_current: 0 | 1;
};

export function getVersionStage(versionId: number): VersionStageRow | null {
  const row = db()
    .prepare("SELECT id, strategy_id, version, stage, is_current FROM strategy_versions WHERE id = ?")
    .get(versionId) as VersionStageRow | undefined;
  return row ?? null;
}

export function canTradeLive(versionId: number): boolean {
  const row = getVersionStage(versionId);
  if (!row) return false;
  return STAGES_ALLOW_LIVE.has(row.stage);
}

export function canTradePaper(versionId: number): boolean {
  const row = getVersionStage(versionId);
  if (!row) return false;
  return STAGES_ALLOW_PAPER.has(row.stage);
}

/**
 * Score-gated transitions are the ones that put real capital at risk:
 *   paper          → live
 *   live_eligible  → live
 * These refuse if `backtest_summary.score < RISK_MIN_PROMOTION_SCORE`.
 * Other transitions (sim → paper, anywhere → restricted, anywhere → sim) are
 * unaffected. force=true bypasses the gate and stamps `forced: true`.
 */
function isScoreGatedTransition(from: ReleaseStage, to: ReleaseStage): boolean {
  if (to !== "live") return false;
  return from === "paper" || from === "live_eligible";
}

function readMinPromotionScore(): number {
  const raw = process.env.RISK_MIN_PROMOTION_SCORE;
  if (raw == null || raw === "") return -10;
  const n = Number(raw);
  return Number.isFinite(n) ? n : -10;
}

export type ScoreGateResult = {
  passed: boolean;
  score: number | null;
  threshold: number;
  reason?: string;
};

/** Pure check — reads backtest_summary.score on the version, compares to the env threshold. */
export function checkPromotionScore(versionId: number): ScoreGateResult {
  const threshold = readMinPromotionScore();
  const row = db()
    .prepare("SELECT backtest_summary FROM strategy_versions WHERE id = ?")
    .get(versionId) as { backtest_summary: string | null } | undefined;
  if (!row) return { passed: false, score: null, threshold, reason: "version not found" };
  if (!row.backtest_summary) {
    return { passed: false, score: null, threshold, reason: "no backtest_summary on version — run a backtest first" };
  }
  let score: number | null = null;
  try {
    const parsed = JSON.parse(row.backtest_summary) as Record<string, unknown>;
    const candidate = (parsed.score ?? (parsed as any).result?.score ?? (parsed as any).sweep?.median_score) as unknown;
    if (typeof candidate === "number" && Number.isFinite(candidate)) score = candidate;
  } catch { /* keep score=null */ }
  if (score == null) {
    return { passed: false, score: null, threshold, reason: "backtest_summary has no numeric score field" };
  }
  if (score < threshold) {
    return { passed: false, score, threshold, reason: `backtest score ${score.toFixed(2)} below RISK_MIN_PROMOTION_SCORE (${threshold})` };
  }
  return { passed: true, score, threshold };
}

/** Update a version's stage, enforcing the promotion ladder. Always logged. */
export function setVersionStage(
  versionId: number,
  newStage: ReleaseStage,
  opts: { force?: boolean; rationale?: string } = {},
): { ok: boolean; reason?: string; previousStage?: ReleaseStage; scoreGate?: ScoreGateResult } {
  const row = getVersionStage(versionId);
  if (!row) return { ok: false, reason: `version ${versionId} not found` };
  if (row.stage === newStage) return { ok: true, previousStage: row.stage };
  if (!opts.force && !canPromoteTo(row.stage, newStage)) {
    return {
      ok: false,
      reason: `${row.stage} → ${newStage} not in promotion ladder (use force=true to override)`,
      previousStage: row.stage,
    };
  }

  // Score gate — paper→live / live_eligible→live require a sufficient backtest score.
  let scoreGate: ScoreGateResult | undefined;
  if (isScoreGatedTransition(row.stage, newStage)) {
    scoreGate = checkPromotionScore(versionId);
    if (!scoreGate.passed && !opts.force) {
      const reason = `score gate refused ${row.stage} → ${newStage}: ${scoreGate.reason}`;
      insertEvolutionEvent({
        strategy_id: row.strategy_id,
        from_version_id: row.id,
        to_version_id: row.id,
        event_type: "stage-refused",
        summary: `${row.stage} → ${newStage} refused (v${row.version}): ${scoreGate.reason}`,
        payload_json: JSON.stringify({
          version_id: row.id,
          from_stage: row.stage,
          to_stage: newStage,
          score_gate: scoreGate,
          rationale: opts.rationale ?? null,
        }),
      });
      return { ok: false, reason, previousStage: row.stage, scoreGate };
    }
  }

  db().prepare("UPDATE strategy_versions SET stage = ? WHERE id = ?").run(newStage, versionId);
  insertEvolutionEvent({
    strategy_id: row.strategy_id,
    from_version_id: row.id,
    to_version_id: row.id,
    event_type: "stage-change",
    summary: `${row.stage} → ${newStage} (v${row.version})${opts.rationale ? `: ${opts.rationale}` : ""}${scoreGate?.score != null ? ` [score ${scoreGate.score.toFixed(2)} >= ${scoreGate.threshold}]` : ""}${opts.force && scoreGate && !scoreGate.passed ? " [FORCED past score gate]" : ""}`,
    payload_json: JSON.stringify({
      version_id: row.id,
      from_stage: row.stage,
      to_stage: newStage,
      forced: !!opts.force,
      rationale: opts.rationale ?? null,
      score_gate: scoreGate ?? null,
    }),
  });
  return { ok: true, previousStage: row.stage, scoreGate };
}
