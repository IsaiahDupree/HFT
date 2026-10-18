/**
 * Capsule circuit breaker — auto-pauses capsules whose live router has been
 * piling up broker errors. Without this, a capsule whose region is geoblocked
 * (or whose CLOB creds expired) will keep hitting the API every tick and pile
 * up `single-error` rows in evolution_log forever, with no automatic recovery
 * mechanism short of the operator noticing.
 *
 * Trip condition: ≥ N consecutive `single-error` / `arb-error` events for the
 * same capsule with NO successful `single-executed` / `arb-executed` events
 * in between, within the lookback window. Default: 5 errors in 15 minutes.
 *
 * On trip: status → 'paused' + an audit row in evolution_log naming the
 * specific error reason from the latest payload. The operator must reactivate
 * manually (flip status to 'live') after fixing the underlying issue.
 *
 * Run from arena-tick after the per-agent decide loop, BEFORE the next
 * gen-seal so paused capsules don't get re-promoted instantly.
 *
 * Bug-fix 2026-05-26 (bug #14 — follow-up to bug #13's Polymarket geoblock
 * surfacing).
 */
import { db } from "@/lib/db/client";
import { insertEvolutionEvent } from "@/lib/db/queries";
import { setStatus } from "./store";

export type CircuitTripResult = {
  paused: Array<{ capsule_id: string; agent_id: number | null; reason: string; error_count: number }>;
  inspected: number;
};

const DEFAULT_THRESHOLD = 5;
const DEFAULT_WINDOW_MIN = 15;

/**
 * Inspect every active (live | paper) capsule for runaway error rates and
 * pause those that trip. Returns a list of pauses for telemetry.
 *
 * @param opts.threshold consecutive errors required to trip (default 5)
 * @param opts.windowMin how far back to look in minutes (default 15)
 */
export function runCircuitBreaker(opts: { threshold?: number; windowMin?: number } = {}): CircuitTripResult {
  const threshold = opts.threshold ?? Number(process.env.CAPSULE_ERROR_THRESHOLD ?? DEFAULT_THRESHOLD);
  const windowMin = opts.windowMin ?? Number(process.env.CAPSULE_ERROR_WINDOW_MIN ?? DEFAULT_WINDOW_MIN);

  const active = db().prepare(
    `SELECT id, agent_id, name FROM capsules WHERE status IN ('live','paper')`,
  ).all() as Array<{ id: string; agent_id: number | null; name: string }>;

  const paused: CircuitTripResult["paused"] = [];

  for (const cap of active) {
    // Count error vs success events for this capsule in the lookback window.
    // We match the capsule by extracting capsule_id from payload_json since
    // evolution_log doesn't have a foreign key — the live router writes both.
    const stats = db().prepare(
      `SELECT
         SUM(CASE WHEN event_type IN ('single-error','arb-error','live-capsule-rejected') THEN 1 ELSE 0 END) AS n_err,
         SUM(CASE WHEN event_type IN ('single-executed','arb-executed','live-capsule-fill') THEN 1 ELSE 0 END) AS n_ok
       FROM evolution_log
       WHERE created_at > datetime('now', ?)
         AND (
           payload_json LIKE '%"capsuleId":"' || ? || '"%'
           OR payload_json LIKE '%"capsule_id":"' || ? || '"%'
         )`,
    ).get(`-${windowMin} minutes`, cap.id, cap.id) as { n_err: number; n_ok: number } | undefined;

    const nErr = stats?.n_err ?? 0;
    const nOk = stats?.n_ok ?? 0;
    if (nErr < threshold) continue;

    // Trip if errors dominate (no successful fills in the same window).
    if (nOk > 0) continue;

    // Extract a representative error reason from the latest error row to
    // include in the audit summary — helps the operator triage quickly.
    const latestErr = db().prepare(
      `SELECT summary FROM evolution_log
        WHERE event_type IN ('single-error','arb-error','live-capsule-rejected')
          AND (payload_json LIKE '%"capsuleId":"' || ? || '"%' OR payload_json LIKE '%"capsule_id":"' || ? || '"%')
          AND created_at > datetime('now', ?)
        ORDER BY id DESC LIMIT 1`,
    ).get(cap.id, cap.id, `-${windowMin} minutes`) as { summary: string } | undefined;

    const reason = `${nErr} errors in ${windowMin}min, 0 successes — last: ${(latestErr?.summary ?? "unknown").slice(0, 120)}`;

    setStatus(cap.id, "paused");
    insertEvolutionEvent({
      event_type: "capsule-circuit-trip",
      summary: `Auto-paused capsule ${cap.id.slice(0, 8)}… (agent ${cap.agent_id ?? "—"}): ${reason}`,
      payload_json: JSON.stringify({
        capsule_id: cap.id,
        agent_id: cap.agent_id,
        n_err: nErr,
        n_ok: nOk,
        window_min: windowMin,
        threshold,
        reason,
      }),
    });
    paused.push({ capsule_id: cap.id, agent_id: cap.agent_id, reason, error_count: nErr });
  }

  return { paused, inspected: active.length };
}
