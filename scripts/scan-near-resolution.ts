/**
 * Near-resolution scraper scanner.
 *
 *   npm run scan:near-resolution
 *   npm run scan:near-resolution -- --min-price 0.97 --max-days 14
 *
 * Pulls Polymarket Gamma events ending in the next --max-days, evaluates
 * each market through detectNearResolutionScrape, persists opportunities
 * to evolution_log as `near-resolution-opportunity` events.
 *
 * Idempotent — dedup key is (conditionId, side, day-bucket). Re-running
 * the same day on the same market is a no-op.
 *
 * Run periodically (every 15-60min is plenty — these markets move slowly).
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { insertEvolutionEvent } from "../src/lib/db/queries.ts";
import { poly } from "../src/lib/polymarket/client.ts";
import {
  detectNearResolutionScrape,
  type ScrapeMarket,
} from "../src/lib/strategies/near-resolution-scrape.ts";

const args = process.argv.slice(2);
function flagNum(name: string, fallback: number): number {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1]) return Number(args[i + 1]);
  return fallback;
}

const MIN_PRICE = flagNum("min-price", 0.95);
const MAX_DAYS = flagNum("max-days", 30);
const MIN_DAYS = flagNum("min-days", 1);
const FEE_BPS = flagNum("fee-bps", 20);
const LIMIT = flagNum("limit", 200);

(async () => {
  const now = new Date();
  const endMin = now.toISOString();
  const endMax = new Date(now.getTime() + MAX_DAYS * 86_400_000).toISOString();

  console.log(
    `[scan-near-resolution] min-price=${MIN_PRICE} window=${MIN_DAYS}–${MAX_DAYS}d fee=${FEE_BPS}bps`,
  );

  let events: any[];
  try {
    events = (await poly.events({
      limit: LIMIT,
      closed: false,
      end_date_min: endMin,
      end_date_max: endMax,
      order: "endDate",
      ascending: true,
    })) as any[];
  } catch (err) {
    console.error(`[scan-near-resolution] events fetch failed: ${(err as Error).message}`);
    process.exit(1);
  }
  if (!Array.isArray(events)) events = [];
  console.log(`[scan-near-resolution] ${events.length} events in window`);

  const handle = db();
  let scanned = 0;
  let opportunities = 0;
  let logged = 0;
  let deduped = 0;
  const dayBucket = new Date().toISOString().slice(0, 10);

  for (const ev of events) {
    for (const m of (ev.markets ?? []) as any[]) {
      scanned++;
      try {
        const outcomePrices = JSON.parse(String(m.outcomePrices ?? '["0","0"]'));
        const bestAskYes = Number(outcomePrices[0]);
        const bestAskNo = Number(outcomePrices[1]);
        const market: ScrapeMarket = {
          conditionId: m.conditionId,
          title: m.question ?? ev.title,
          endDate: ev.endDate,
          bestAskYes,
          bestAskNo,
          liquidityUsd: Number(m.liquidity ?? 0),
        };
        const opp = detectNearResolutionScrape(market, {
          minPrice: MIN_PRICE,
          minDaysToResolution: MIN_DAYS,
          maxDaysToResolution: MAX_DAYS,
          feeBps: FEE_BPS,
        });
        if (!opp) continue;
        opportunities++;

        // Dedup: same (conditionId, side, day) emitted once.
        const existing = handle
          .prepare(
            `SELECT 1 FROM evolution_log
              WHERE event_type = 'near-resolution-opportunity'
                AND created_at >= date('now')
                AND payload_json LIKE ?`,
          )
          .get(`%"conditionId":"${opp.conditionId}"%"side":"${opp.side}"%`);
        if (existing) {
          deduped++;
          continue;
        }

        insertEvolutionEvent({
          event_type: "near-resolution-opportunity",
          summary: `NRS ${opp.side} ${(opp.title ?? opp.conditionId).slice(0, 50)} @ ${opp.entryPrice.toFixed(3)} (${opp.daysToResolution.toFixed(1)}d, edge ${(opp.edge * 100).toFixed(2)}pp, ${(opp.annualizedEdge * 100).toFixed(0)}%apy)`,
          payload_json: JSON.stringify({
            ...opp,
            marketKey: opp.conditionId,
            marketTitle: opp.title,
            dayBucket,
          }),
        });
        logged++;
        console.log(
          `  ↳ ${opp.side} @ ${opp.entryPrice.toFixed(3)} ${(opp.title ?? opp.conditionId).slice(0, 50)} — ${(opp.annualizedEdge * 100).toFixed(0)}%apy`,
        );
      } catch {
        /* skip malformed market */
      }
    }
  }

  console.log(
    `[scan-near-resolution] scanned=${scanned} opportunities=${opportunities} logged=${logged} deduped=${deduped}`,
  );
  if (opportunities === 0) {
    insertEvolutionEvent({
      event_type: "near-resolution-scan-empty",
      summary: `NRS: 0 opportunities in ${scanned} markets (min-price ${MIN_PRICE}, window ${MIN_DAYS}–${MAX_DAYS}d)`,
      payload_json: JSON.stringify({ scanned, minPrice: MIN_PRICE, maxDays: MAX_DAYS, minDays: MIN_DAYS }),
    });
  }
})().catch((err) => {
  console.error("[scan-near-resolution] FAILED:", err);
  process.exit(1);
});
