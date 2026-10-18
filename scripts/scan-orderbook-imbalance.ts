/**
 * Orderbook imbalance scanner.
 *
 *   npm run scan:orderbook-imbalance
 *   npm run scan:orderbook-imbalance -- --min-ratio 2.5 --top-levels 5
 *   npm run scan:orderbook-imbalance -- --tokens tokA,tokB,tokC
 *
 * Polls CLOB /book for a set of active binary markets (auto-discovered from
 * poly_binaries or supplied via --tokens). Runs detectOrderbookImbalance()
 * on each. Emits `orderbook-imbalance-signal` events with 1-min dedup.
 *
 * Run very frequently (every 30-60s) since imbalance signals decay in seconds.
 *
 * Note: polling-based detection is best-effort by design. A WS-driven upgrade
 * is the right long-term fix; this script is for the v1 detector validation.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { insertEvolutionEvent } from "../src/lib/db/queries.ts";
import { poly } from "../src/lib/polymarket/client.ts";
import {
  detectOrderbookImbalance,
  type OrderbookSnapshot,
} from "../src/lib/strategies/orderbook-imbalance.ts";

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

const MIN_RATIO = flagNum("min-ratio", 3.0);
const MIN_DEPTH_USD = flagNum("min-depth-usd", 1000);
const TOP_LEVELS = flagNum("top-levels", 3);
const LIMIT = flagNum("limit", 30);
const TOKENS_RAW = flagStr("tokens");

function loadActiveTokens(): Array<{ token_id: string; question?: string; asset?: string }> {
  try {
    return db()
      .prepare(
        `SELECT token_id, question, asset FROM poly_binaries
          WHERE settled = 0 AND expiry_iso > datetime('now')
          ORDER BY expiry_iso ASC LIMIT ?`,
      )
      .all(LIMIT) as Array<{ token_id: string; question: string; asset: string }>;
  } catch (err) {
    console.warn(`[scan-orderbook-imbalance] could not read poly_binaries: ${(err as Error).message}`);
    return [];
  }
}

(async () => {
  let tokens: Array<{ token_id: string; question?: string; asset?: string }>;
  if (TOKENS_RAW) {
    tokens = TOKENS_RAW.split(",").map((t) => ({ token_id: t.trim() })).filter((t) => t.token_id);
  } else {
    tokens = loadActiveTokens();
  }
  console.log(
    `[scan-orderbook-imbalance] ${tokens.length} tokens, min-ratio=${MIN_RATIO} top=${TOP_LEVELS} min-depth=$${MIN_DEPTH_USD}`,
  );
  if (tokens.length === 0) {
    insertEvolutionEvent({
      event_type: "orderbook-scan-empty",
      summary: "orderbook-imbalance: no tokens to scan (poly_binaries empty or no active binaries)",
      payload_json: JSON.stringify({}),
    });
    return;
  }

  let scanned = 0;
  let bookErrors = 0;
  let emitted = 0;
  const handle = db();

  for (const tok of tokens) {
    scanned++;
    try {
      const book = await poly.orderbook(tok.token_id);
      if (!book?.bids?.length || !book?.asks?.length) {
        bookErrors++;
        continue;
      }
      const snapshot: OrderbookSnapshot = {
        conditionId: tok.token_id,
        marketTitle: tok.question,
        bids: (book.bids as any[])
          .map((b: any) => ({ price: Number(b.price), size: Number(b.size) }))
          .filter((b) => b.price > 0 && b.size > 0)
          .sort((a, b) => b.price - a.price),
        asks: (book.asks as any[])
          .map((a: any) => ({ price: Number(a.price), size: Number(a.size) }))
          .filter((a) => a.price > 0 && a.size > 0)
          .sort((a, b) => a.price - b.price),
        ts: new Date().toISOString(),
      };

      const opp = detectOrderbookImbalance(snapshot, {
        topLevels: TOP_LEVELS,
        minRatio: MIN_RATIO,
        minTotalDepthUsd: MIN_DEPTH_USD,
      });
      if (!opp) continue;

      const dup = handle
        .prepare(
          `SELECT 1 FROM evolution_log
            WHERE event_type = 'orderbook-imbalance-signal'
              AND created_at >= datetime('now', '-1 minute')
              AND payload_json LIKE ?`,
        )
        .get(`%"conditionId":"${tok.token_id}"%"side":"${opp.side}"%`);
      if (dup) continue;

      insertEvolutionEvent({
        event_type: "orderbook-imbalance-signal",
        summary: `OBI ${opp.side} ${(tok.question ?? tok.token_id.slice(0, 10) + "…").slice(0, 40)} ratio=${opp.imbalanceRatio.toFixed(2)} str=${(opp.signalStrength * 100).toFixed(0)}%`,
        payload_json: JSON.stringify({
          ...opp,
          marketTitle: tok.question,
          asset: tok.asset,
        }),
      });
      emitted++;
      console.log(
        `  ↳ ${opp.side} ${(tok.question ?? "?").slice(0, 50)} ratio=${opp.imbalanceRatio.toFixed(2)} strength=${(opp.signalStrength * 100).toFixed(0)}%`,
      );
    } catch (err) {
      bookErrors++;
    }
  }

  console.log(`[scan-orderbook-imbalance] scanned=${scanned} bookErrors=${bookErrors} emitted=${emitted}`);
  if (emitted === 0) {
    insertEvolutionEvent({
      event_type: "orderbook-scan-empty",
      summary: `orderbook-imbalance: 0 signals in ${scanned} markets (${bookErrors} book errors)`,
      payload_json: JSON.stringify({ scanned, bookErrors, minRatio: MIN_RATIO, minDepth: MIN_DEPTH_USD }),
    });
  }
})().catch((err) => {
  console.error("[scan-orderbook-imbalance] FAILED:", err);
  process.exit(1);
});
