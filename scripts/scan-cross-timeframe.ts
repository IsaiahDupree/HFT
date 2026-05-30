/**
 * Cross-timeframe spread scanner.
 *
 *   npm run scan:cross-timeframe
 *   npm run scan:cross-timeframe -- --min-z 2.5 --min-samples 30
 *   npm run scan:cross-timeframe -- --pairs tokenA:5,tokenB:15;tokenC:5,tokenD:60
 *
 * Discovers (short, long) market pairs from poly_binaries (grouped by asset),
 * pulls 6h of prices-history for both via CLOB, computes time-aligned rolling
 * spreads, runs detectCrossTimeframeSpread() on current mid vs the rolling
 * stats. Emits `cross-timeframe-spread` events to evolution_log with dedup.
 *
 * Idempotent — dedup window 5 min on (shortConditionId, cheapSide).
 *
 * Run periodically (every 1-5 min). The detector requires ≥ minSamples
 * (default 30) historical aligned spread observations to compute meaningful
 * stdev, so very-new markets won't fire until enough history accumulates.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { insertEvolutionEvent } from "../src/lib/db/queries.ts";
import { poly } from "../src/lib/polymarket/client.ts";
import {
  detectCrossTimeframeSpread,
  type SpreadObservation,
} from "../src/lib/strategies/cross-timeframe-spread.ts";

const args = process.argv.slice(2);
function flagNum(name: string, fallback: number): number {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1]) return Number(args[i + 1]);
  return fallback;
}
function flagStr(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const MIN_Z = flagNum("min-z", 3.0);
const MIN_SAMPLES = flagNum("min-samples", 30);
const MAX_STALE_SEC = flagNum("max-stale-sec", 120);
const PAIRS_RAW = flagStr("pairs");

type Pair = {
  shortTokenId: string;
  shortMin: number;
  shortTitle?: string;
  longTokenId: string;
  longMin: number;
  longTitle?: string;
  asset?: string;
};

function parseDurationKind(kind: string): number {
  const lower = (kind ?? "").toLowerCase();
  if (lower.includes("5m") || lower.includes("five")) return 5;
  if (lower.includes("15m") || lower.includes("fifteen")) return 15;
  if (lower.includes("1h") || lower.includes("hour") || lower.includes("60m")) return 60;
  if (lower.includes("4h") || lower.includes("four")) return 240;
  return 5;
}

function discoverPairsFromDb(): Pair[] {
  let rows: Array<{ token_id: string; asset: string; duration_kind: string; expiry_iso: string; question: string }> = [];
  try {
    rows = db()
      .prepare(
        `SELECT token_id, asset, duration_kind, expiry_iso, question
           FROM poly_binaries
          WHERE settled = 0 AND expiry_iso > datetime('now')
          ORDER BY asset, expiry_iso ASC`,
      )
      .all() as Array<{ token_id: string; asset: string; duration_kind: string; expiry_iso: string; question: string }>;
  } catch (err) {
    // poly_binaries table may not exist in some dev setups — degrade gracefully.
    console.warn(`[scan-cross-timeframe] could not read poly_binaries: ${(err as Error).message}`);
    return [];
  }
  const byAsset = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byAsset.has(r.asset)) byAsset.set(r.asset, []);
    byAsset.get(r.asset)!.push(r);
  }
  const pairs: Pair[] = [];
  for (const [asset, list] of byAsset) {
    const annotated = list.map((r) => ({ ...r, durMin: parseDurationKind(r.duration_kind) }));
    const short = annotated.find((r) => r.durMin <= 15);
    const long = annotated.find((r) => r.durMin > 15 && r.token_id !== short?.token_id);
    if (short && long) {
      pairs.push({
        shortTokenId: short.token_id,
        shortMin: short.durMin,
        shortTitle: short.question,
        longTokenId: long.token_id,
        longMin: long.durMin,
        longTitle: long.question,
        asset,
      });
    }
  }
  return pairs;
}

function parsePairsArg(raw: string): Pair[] {
  return raw.split(";").map((p) => {
    const [s, l] = p.split(",");
    const [sToken, sMin] = s.split(":");
    const [lToken, lMin] = l.split(":");
    return {
      shortTokenId: sToken,
      shortMin: Number(sMin),
      longTokenId: lToken,
      longMin: Number(lMin),
    };
  });
}

const TIME_TOL_SEC = 300; // 5-min tolerance when aligning spread samples

(async () => {
  const pairs = PAIRS_RAW ? parsePairsArg(PAIRS_RAW) : discoverPairsFromDb();
  console.log(`[scan-cross-timeframe] ${pairs.length} pairs to scan, min-z=${MIN_Z} min-samples=${MIN_SAMPLES}`);
  if (pairs.length === 0) {
    insertEvolutionEvent({
      event_type: "cross-timeframe-scan-empty",
      summary: "cross-timeframe: no pairs to scan (poly_binaries empty or no asset with both short+long markets)",
      payload_json: JSON.stringify({}),
    });
    return;
  }

  let emitted = 0;
  for (const pair of pairs) {
    try {
      const [shortHist, longHist, shortMid, longMid] = await Promise.all([
        poly.pricesHistory(pair.shortTokenId, "6h", 60).catch(() => ({ history: [] as Array<{ t: number; p: number }> })),
        poly.pricesHistory(pair.longTokenId, "6h", 60).catch(() => ({ history: [] as Array<{ t: number; p: number }> })),
        poly.midpoint(pair.shortTokenId).catch(() => null),
        poly.midpoint(pair.longTokenId).catch(() => null),
      ]);
      if (!shortHist.history?.length || !longHist.history?.length) continue;
      if (!shortMid || !longMid) continue;

      // Align: for each shortHist sample, find nearest longHist sample within tolerance.
      const rolling: SpreadObservation[] = [];
      for (const sh of shortHist.history) {
        let best: { t: number; p: number } | null = null;
        for (const lh of longHist.history) {
          const dt = Math.abs(lh.t - sh.t);
          if (dt > TIME_TOL_SEC) continue;
          if (!best || dt < Math.abs(best.t - sh.t)) best = lh;
        }
        if (!best) continue;
        rolling.push({ spread: sh.p - best.p, ts: new Date(sh.t * 1000).toISOString() });
      }

      if (rolling.length < MIN_SAMPLES) continue;

      const nowIso = new Date().toISOString();
      const opp = detectCrossTimeframeSpread(
        {
          conditionId: pair.shortTokenId,
          durationMinutes: pair.shortMin,
          midPrice: Number(shortMid.mid),
          ts: nowIso,
          marketTitle: pair.shortTitle,
        },
        {
          conditionId: pair.longTokenId,
          durationMinutes: pair.longMin,
          midPrice: Number(longMid.mid),
          ts: nowIso,
          marketTitle: pair.longTitle,
        },
        rolling,
        { minZScore: MIN_Z, minSamples: MIN_SAMPLES, maxStalenessSec: MAX_STALE_SEC },
      );
      if (!opp) continue;

      const handle = db();
      const dup = handle
        .prepare(
          `SELECT 1 FROM evolution_log
            WHERE event_type = 'cross-timeframe-spread'
              AND created_at >= datetime('now', '-5 minutes')
              AND payload_json LIKE ?`,
        )
        .get(`%"shortConditionId":"${opp.shortConditionId}"%"cheapSide":"${opp.cheapSide}"%`);
      if (dup) continue;

      insertEvolutionEvent({
        event_type: "cross-timeframe-spread",
        summary: `CTS ${pair.asset ?? ""} ${pair.shortMin}m/${pair.longMin}m z=${opp.zScore.toFixed(2)} cheap=${opp.cheapSide} edge=${(opp.edge * 100).toFixed(2)}pp`,
        payload_json: JSON.stringify({
          ...opp,
          marketTitle: opp.cheapSide === "long" ? pair.longTitle : pair.shortTitle,
          side: "BUY",
          asset: pair.asset,
        }),
      });
      emitted++;
      console.log(
        `  ↳ ${pair.asset ?? "?"} ${pair.shortMin}m@${opp.shortPrice.toFixed(3)} vs ${pair.longMin}m@${opp.longPrice.toFixed(3)} z=${opp.zScore.toFixed(2)} cheap=${opp.cheapSide}`,
      );
    } catch (err) {
      console.warn(
        `  pair ${pair.shortTokenId.slice(0, 10)}…/${pair.longTokenId.slice(0, 10)}…: ${(err as Error).message}`,
      );
    }
  }

  console.log(`[scan-cross-timeframe] emitted ${emitted}/${pairs.length} signals`);
  if (emitted === 0) {
    insertEvolutionEvent({
      event_type: "cross-timeframe-scan-empty",
      summary: `cross-timeframe: 0 signals in ${pairs.length} pairs (min-z=${MIN_Z})`,
      payload_json: JSON.stringify({ pairs: pairs.length, minZ: MIN_Z }),
    });
  }
})().catch((err) => {
  console.error("[scan-cross-timeframe] FAILED:", err);
  process.exit(1);
});
