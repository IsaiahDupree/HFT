/**
 * Complement-sum arbitrage scanner.
 *
 *   npm run scan:complement-sum
 *   npm run scan:complement-sum -- --max-combined 0.96 --min-profit 0.03
 *
 * For every unsettled binary in `poly_binaries`, fetch the Up + Down
 * order books, compute the best-ask + depth on each side, and call
 * `detectComplementSumArb`. Persists opportunities to evolution_log as
 * `complement-sum-opportunity` events.
 *
 * Idempotent — dedup key is (conditionId, day-bucket). Re-running the
 * same day on the same market updates the latest opportunity rather
 * than duplicating.
 *
 * Recommended cadence: every 30-60s (these prices move fast). Heavier
 * than scan-near-resolution because we fetch two order books per binary.
 *
 * No live-trading side effects — pure observability + signal generation.
 * The worker-complement-sum-exec script consumes these signals and
 * places trades when COMPLEMENT_ARB_LIVE=1.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { insertEvolutionEvent } from "../src/lib/db/queries.ts";
import { poly } from "../src/lib/polymarket/client.ts";
import {
  detectComplementSumArb,
  type BinaryBookSnapshot,
} from "../src/lib/strategies/complement-sum-arb.ts";

const args = process.argv.slice(2);
function flagNum(name: string, fallback: number): number {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1]) return Number(args[i + 1]);
  return fallback;
}
const flag = (name: string) => args.includes(`--${name}`);

const MAX_COMBINED = flagNum("max-combined", 0.97);
const MIN_PROFIT = flagNum("min-profit", 0.02);
const MIN_HOLD_MIN = flagNum("min-hold-min", 1);
const FEE_BPS = flagNum("fee-bps", 20);
const LIMIT = flagNum("limit", 50);
const VERBOSE = flag("verbose");

type OrderBookResp = {
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
};

/** Pull best-ask price + USD depth at that price from an orderbook response. */
function topAsk(book: OrderBookResp | null): { price: number; depthUsd: number } | null {
  if (!book || !Array.isArray(book.asks) || book.asks.length === 0) return null;
  // asks are sorted ascending by price (cheapest first); take the top.
  // depth at top-of-book = sum of size at the cheapest price level.
  const cheapestPrice = Number(book.asks[0]!.price);
  if (!Number.isFinite(cheapestPrice)) return null;
  let depthShares = 0;
  for (const a of book.asks) {
    const p = Number(a.price);
    if (p !== cheapestPrice) break;
    const s = Number(a.size);
    if (Number.isFinite(s)) depthShares += s;
  }
  // depth in USD = shares × price
  return { price: cheapestPrice, depthUsd: depthShares * cheapestPrice };
}

(async () => {
  console.log(
    `[scan-complement-sum] max-combined=${MAX_COMBINED} min-profit=$${MIN_PROFIT} min-hold=${MIN_HOLD_MIN}m fee=${FEE_BPS}bps`,
  );

  // Pull unsettled binaries that haven't expired yet AND have a NO token.
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const binaries = db()
    .prepare(
      `SELECT token_id, condition_id, no_token_id, question, asset, expiry_iso
         FROM poly_binaries
        WHERE settled = 0
          AND no_token_id IS NOT NULL
          AND expiry_iso > ?
        ORDER BY expiry_iso ASC
        LIMIT ?`,
    )
    .all(nowIso, LIMIT) as Array<{
      token_id: string;
      condition_id: string;
      no_token_id: string;
      question: string;
      asset: string;
      expiry_iso: string;
    }>;

  if (binaries.length === 0) {
    console.log("[scan-complement-sum] no unsettled binaries with NO tokens to scan.");
    return;
  }
  console.log(`[scan-complement-sum] scanning ${binaries.length} binaries…`);

  let scanned = 0;
  let opportunities = 0;
  let bestProfit = 0;

  for (const b of binaries) {
    scanned++;
    // Fetch both order books. Failures are non-fatal — skip the binary.
    let upBook: OrderBookResp | null = null;
    let downBook: OrderBookResp | null = null;
    try {
      upBook = (await poly.orderbook(b.token_id)) as OrderBookResp;
    } catch (err) {
      if (VERBOSE) console.warn(`  ! ${b.condition_id.slice(0, 10)} up-book error: ${(err as Error).message?.slice(0, 60)}`);
      continue;
    }
    try {
      downBook = (await poly.orderbook(b.no_token_id)) as OrderBookResp;
    } catch (err) {
      if (VERBOSE) console.warn(`  ! ${b.condition_id.slice(0, 10)} down-book error: ${(err as Error).message?.slice(0, 60)}`);
      continue;
    }

    const upAsk = topAsk(upBook);
    const downAsk = topAsk(downBook);
    if (!upAsk || !downAsk) continue;

    const snapshot: BinaryBookSnapshot = {
      conditionId: b.condition_id,
      title: b.question,
      asset: b.asset,
      windowCloseMs: Date.parse(b.expiry_iso),
      nowMs,
      upBestAsk: upAsk.price,
      downBestAsk: downAsk.price,
      upDepthUsd: upAsk.depthUsd,
      downDepthUsd: downAsk.depthUsd,
      feeBps: FEE_BPS,
    };

    const opp = detectComplementSumArb(snapshot, {
      maxCombinedCost: MAX_COMBINED,
      minProfitPerPair: MIN_PROFIT,
      minHoldMinutes: MIN_HOLD_MIN,
      feeBps: FEE_BPS,
    });

    if (!opp) {
      if (VERBOSE) {
        const combined = (upAsk.price + downAsk.price).toFixed(3);
        console.log(`  - ${b.condition_id.slice(0, 10)} ${b.asset.padEnd(5)} combined ${combined} — no arb`);
      }
      continue;
    }

    opportunities++;
    if (opp.total_profit_usd > bestProfit) bestProfit = opp.total_profit_usd;

    console.log(`  ✓ ${b.condition_id.slice(0, 10)} ${b.asset.padEnd(5)} ${opp.reason}`);
    insertEvolutionEvent({
      event_type: "complement-sum-opportunity",
      summary: opp.reason.slice(0, 200),
      payload_json: JSON.stringify({
        conditionId: opp.conditionId,
        title: opp.title,
        asset: opp.asset,
        combined_cost: opp.combined_cost,
        gross_profit_per_pair: opp.gross_profit_per_pair,
        net_profit_per_pair: opp.net_profit_per_pair,
        roi: opp.roi,
        max_pairs: opp.max_pairs,
        capital_required_usd: opp.capital_required_usd,
        total_profit_usd: opp.total_profit_usd,
        time_to_resolve_min: opp.time_to_resolve_min,
        scan_ts: nowIso,
        up_token_id: b.token_id,
        down_token_id: b.no_token_id,
      }),
    });
  }

  console.log("");
  console.log(`[scan-complement-sum] summary: scanned ${scanned}, opportunities ${opportunities}, best $${bestProfit.toFixed(2)}`);
})().catch((err) => {
  console.error(`[scan-complement-sum] fatal: ${(err as Error).message}`);
  process.exit(1);
});
