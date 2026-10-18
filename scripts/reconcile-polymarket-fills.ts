/**
 * Polymarket fill reconciler — periodically pulls our recent trades from the
 * CLOB and writes the actual filled-share counts onto matching paper-agent
 * positions.
 *
 * Why this exists: when ALLOW_TRADE=1, a sim-poly entry through the live
 * router places a real CLOB order. The router returns a brokerOrderId but
 * the actual fill size isn't known synchronously (FOK either fills all or
 * cancels; partial-fill is also possible). The arena-tick pipeline stamps
 * `live_token_id` + `live_paid_usd` + `live_client_order_id` on the Position
 * at submit time, but `live_filled_shares` stays NULL until this reconciler
 * reads the trade.
 *
 * Matching is tried against EITHER `live_broker_order_id` OR
 * `live_client_order_id` (different CLOB SDK versions surface different id
 * fields on /data/trades; we control client_order_id so it's the most
 * reliable fallback).
 *
 * Resolution path uses `live_filled_shares` when present, falls back to
 * paid_usd / refPrice otherwise.
 *
 * Run from cron every 5 min (or manually):
 *   ALLOW_TRADE=1 npx tsx scripts/reconcile-polymarket-fills.ts
 *
 * Safe to run with ALLOW_TRADE=0 — purely read-only; no orders submitted.
 */
import "./_env.ts";
import { poly } from "../src/lib/polymarket/client.ts";
import { insertEvolutionEvent } from "../src/lib/db/queries.ts";
import { reconcileFills, type ClobTrade } from "../src/lib/arena/reconcile-polymarket.ts";

(async () => {
  // Pull recent trades from the CLOB. The /data/trades endpoint returns the
  // authenticated user's own trades. Requires CLOB L2 creds.
  let trades: ClobTrade[] = [];
  try {
    trades = await poly.myTrades() as ClobTrade[];
  } catch (err) {
    console.error(`reconcile: could not fetch /data/trades: ${(err as Error).message}`);
    console.error("  Ensure POLYMARKET_CLOB_API_KEY/SECRET/PASSPHRASE are set; run `npm run derive:creds` to derive them.");
    process.exit(1);
  }
  console.log(`reconcile: fetched ${trades.length} recent trades from CLOB`);

  const summary = reconcileFills(trades);
  console.log(
    `reconcile: ${summary.unreconciled_count} open live positions; ` +
    `matched=${summary.matched} written=${summary.written} no_match=${summary.no_match}`,
  );

  if (summary.written > 0) {
    insertEvolutionEvent({
      event_type: "polymarket-reconciled-batch",
      summary: `Reconciled ${summary.written} of ${summary.unreconciled_count} live positions`,
      payload_json: JSON.stringify(summary),
    });
  }
})();
