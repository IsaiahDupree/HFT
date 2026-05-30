/**
 * Opportunity → research_note emitter.
 *
 *   npm run emit:opportunity-notes
 *   npm run emit:opportunity-notes -- --min-annualized 0.5 --min-strength 0.7
 *
 * Scans recent strategy-opportunity events (near-resolution / cross-timeframe /
 * orderbook-imbalance) and emits a research_note for each high-value one. This
 * surfaces signals in the /research feed and gives agents an additional source
 * they can read through the existing research_notes consumer path.
 *
 * Thresholds (defaults):
 *   - near-resolution: annualizedEdge ≥ 0.50 (50% APY)
 *   - cross-timeframe-spread: |zScore| ≥ 4.0 (strong divergence)
 *   - orderbook-imbalance: signalStrength ≥ 0.7
 *
 * Idempotent: dedup by (event_type, marketKey, day-bucket) using the research_notes
 * tags + topic prefix so re-runs don't spam. Notes carry the
 * `auto-strategy-opportunity` tag for downstream filtering.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { insertResearchNote } from "../src/lib/db/queries.ts";

const args = process.argv.slice(2);
function flagNum(name: string, fallback: number): number {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1]) return Number(args[i + 1]);
  return fallback;
}

const MIN_ANNUALIZED = flagNum("min-annualized", 0.5);
const MIN_Z = flagNum("min-z", 4.0);
const MIN_STRENGTH = flagNum("min-strength", 0.7);
const HOURS_BACK = flagNum("hours-back", 24);

type Row = { id: number; event_type: string; payload_json: string; created_at: string };

(async () => {
  console.log(
    `[emit-opportunity-notes] scanning last ${HOURS_BACK}h: nrs≥${(MIN_ANNUALIZED * 100).toFixed(0)}%apy, cts|z|≥${MIN_Z}, obi≥${(MIN_STRENGTH * 100).toFixed(0)}%`,
  );

  const handle = db();
  const rows = handle
    .prepare(
      `SELECT id, event_type, payload_json, created_at FROM evolution_log
        WHERE event_type IN ('near-resolution-opportunity', 'cross-timeframe-spread', 'orderbook-imbalance-signal')
          AND created_at >= datetime('now', '-' || ? || ' hours')
        ORDER BY created_at DESC`,
    )
    .all(HOURS_BACK) as Row[];

  console.log(`[emit-opportunity-notes] ${rows.length} candidate opportunity events`);
  if (rows.length === 0) return;

  // Dedup: read existing research notes from today with the auto-strategy-opportunity tag.
  const existingNotes = handle
    .prepare(
      `SELECT topic, market_condition_id, tags_json FROM research_notes
        WHERE created_at >= datetime('now', '-' || ? || ' hours')
          AND tags_json LIKE '%auto-strategy-opportunity%'`,
    )
    .all(HOURS_BACK) as Array<{ topic: string; market_condition_id: string | null; tags_json: string | null }>;
  const seenKeys = new Set<string>();
  for (const n of existingNotes) {
    if (n.market_condition_id) seenKeys.add(`${n.market_condition_id}|${n.topic.split(" ")[0]}`);
  }

  let emitted = 0;
  let filtered = 0;
  for (const row of rows) {
    let p: any;
    try {
      p = JSON.parse(row.payload_json);
    } catch {
      continue;
    }

    // Filter by event type-specific threshold
    let qualifies = false;
    let qualReason = "";
    if (row.event_type === "near-resolution-opportunity") {
      qualifies = Number(p.annualizedEdge ?? 0) >= MIN_ANNUALIZED;
      qualReason = `annualizedEdge=${((Number(p.annualizedEdge) || 0) * 100).toFixed(0)}%`;
    } else if (row.event_type === "cross-timeframe-spread") {
      qualifies = Math.abs(Number(p.zScore ?? 0)) >= MIN_Z;
      qualReason = `|z|=${Math.abs(Number(p.zScore) || 0).toFixed(2)}`;
    } else if (row.event_type === "orderbook-imbalance-signal") {
      qualifies = Number(p.signalStrength ?? 0) >= MIN_STRENGTH;
      qualReason = `strength=${((Number(p.signalStrength) || 0) * 100).toFixed(0)}%`;
    }
    if (!qualifies) {
      filtered++;
      continue;
    }

    const marketKey = String(p.marketKey ?? p.conditionId ?? "");
    if (!marketKey) continue;
    const dedupKey = `${marketKey}|${typeLabelPrefix(row.event_type)}`;
    if (seenKeys.has(dedupKey)) continue;
    seenKeys.add(dedupKey);

    const tags = ["auto-strategy-opportunity", typeLabelPrefix(row.event_type)];
    const topic = `${typeLabelPrefix(row.event_type)}: ${(p.marketTitle ?? marketKey).slice(0, 80)}`;
    const body = buildNoteBody(row.event_type, p, qualReason);

    insertResearchNote({
      market_condition_id: marketKey,
      topic,
      body,
      source_urls_json: JSON.stringify([]),
      confidence: confidenceFor(row.event_type, p),
      tags_json: JSON.stringify(tags),
    });
    emitted++;
    console.log(`  ↳ [${row.event_type}] ${topic} (${qualReason})`);
  }

  console.log(`[emit-opportunity-notes] emitted=${emitted} filtered=${filtered} (existing in window: ${existingNotes.length})`);
})().catch((err) => {
  console.error("[emit-opportunity-notes] FAILED:", err);
  process.exit(1);
});

function typeLabelPrefix(eventType: string): string {
  if (eventType === "near-resolution-opportunity") return "NRS";
  if (eventType === "cross-timeframe-spread") return "CTS";
  if (eventType === "orderbook-imbalance-signal") return "OBI";
  return "OPP";
}

function confidenceFor(eventType: string, p: any): number {
  if (eventType === "near-resolution-opportunity") {
    const ann = Number(p.annualizedEdge ?? 0);
    return Math.min(0.95, 0.5 + ann * 0.5); // 50% APY → 0.75 confidence; 100% → 1.0 cap
  }
  if (eventType === "cross-timeframe-spread") {
    const z = Math.abs(Number(p.zScore ?? 0));
    return Math.min(0.9, 0.4 + z * 0.08);
  }
  if (eventType === "orderbook-imbalance-signal") {
    return Math.min(0.8, 0.3 + Number(p.signalStrength ?? 0) * 0.5);
  }
  return 0.5;
}

function buildNoteBody(eventType: string, p: any, qualReason: string): string {
  const lines = [
    `**Auto-emitted from strategy scanner.** Threshold met: ${qualReason}.`,
    "",
    `- Market: \`${p.marketKey ?? p.conditionId}\``,
    p.marketTitle ? `- Title: ${p.marketTitle}` : null,
    p.side ? `- Side: ${p.side}` : null,
    p.cheapSide ? `- Cheap side: ${p.cheapSide}` : null,
    p.entryPrice != null ? `- Entry: ${Number(p.entryPrice).toFixed(3)}` : null,
    p.edge != null ? `- Edge: ${(Number(p.edge) * 100).toFixed(2)}pp` : null,
    p.annualizedEdge != null ? `- Annualized: ${(Number(p.annualizedEdge) * 100).toFixed(0)}%` : null,
    p.signalStrength != null ? `- Signal strength: ${(Number(p.signalStrength) * 100).toFixed(0)}%` : null,
    p.daysToResolution != null ? `- Days to resolution: ${Number(p.daysToResolution).toFixed(1)}` : null,
    p.imbalanceRatio != null ? `- Imbalance: ${Number(p.imbalanceRatio).toFixed(2)}:1` : null,
    "",
    `**Reason:** ${p.reason ?? "(no reason in payload)"}`,
    "",
    eventType === "near-resolution-opportunity"
      ? "**To act:** the NRS auto-executor (`npm run worker:nrs-exec`) will pick this up if running. To execute manually, BUY the winning side via the venue router."
      : eventType === "cross-timeframe-spread"
      ? "**To act:** review the spread on `/binaries` for both markets. Cross-timeframe edges decay quickly — execute within minutes or skip."
      : "**To act:** orderbook imbalance decays in seconds. v1 emits signal-only; manual execution must be very fast to capture.",
  ].filter(Boolean) as string[];
  return lines.join("\n");
}
