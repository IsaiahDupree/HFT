/**
 * Realtime worker — subscribes to Polymarket's official real-time WS, watches
 * for stale-quote signals on tokens that "scribe-sports"-style strategies
 * care about, and writes evolution_log events when relevant patterns fire.
 *
 * This is the operational pair to scribe-sports' `requires_websocket: true`
 * spec flag — the strategy SAID it needed WS to evaluate, this worker is the
 * thing that supplies WS.
 *
 * Long-running; intended for `npm run worker:realtime` (or supervised by
 * docker-compose / pm2). Ctrl-C to stop; SIGTERM also exits cleanly.
 *
 * Today's coverage: subscribes to `activity` (trades + orders_matched) for
 * an opt-in event slug list and writes `realtime-tick` events when activity
 * is observed. Stale-quote-arb detection logic itself is intentionally NOT
 * implemented here — the worker is the data plumbing; the actual algorithm
 * lives next to the scribe-sports evaluator (TODO).
 */
import "./_env.ts";
import { ConnectionStatus, PolymarketRealtime, hasClobCreds } from "../src/lib/polymarket/realtime.ts";
import { insertEvolutionEvent } from "../src/lib/db/queries.ts";
import { db } from "../src/lib/db/client.ts";
import { persistRealtimeTick, pruneOldTicks, wsHealth } from "../src/lib/arena/realtime-ticks.ts";

// Slug allow-list from env (comma-separated). If empty, subscribe with no filter
// (firehose — useful for development; not recommended for prod).
const EVENT_SLUGS = (process.env.REALTIME_EVENT_SLUGS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const MARKET_SLUGS = (process.env.REALTIME_MARKET_SLUGS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const SUBSCRIBE_USER_CHANNEL = process.env.REALTIME_USER_CHANNEL === "1";
const SUBSCRIBE_CRYPTO_PRICES = process.env.REALTIME_CRYPTO_PRICES !== "0"; // default ON
const HEARTBEAT_INTERVAL_MS = Number(process.env.REALTIME_HEARTBEAT_MS ?? "30000");

let activityCount = 0;
let userChannelCount = 0;
let cryptoPriceCount = 0;
let cryptoTicksWritten = 0;
let cryptoTicksDebounced = 0;
let lastHeartbeatActivityCount = 0;
let lastHeartbeatAt = Date.now();

async function main() {
  console.log("[worker-realtime] starting...");
  console.log(`[worker-realtime] event_slugs=[${EVENT_SLUGS.join(",")}] market_slugs=[${MARKET_SLUGS.join(",")}] user_channel=${SUBSCRIBE_USER_CHANNEL} crypto_prices=${SUBSCRIBE_CRYPTO_PRICES}`);

  // Verify the scribe-sports strategy actually wants WS (requires_websocket=true)
  // before we burn an evolution event for it. Surface a warning if no strategy
  // currently asks for WS.
  const scribeRow = db()
    .prepare(
      `SELECT s.id AS strategy_id, s.name, v.id AS version_id, v.spec_json
         FROM strategies s
         JOIN strategy_versions v ON v.strategy_id = s.id AND v.is_current = 1
         WHERE s.slug = 'stale-quote-arb' AND s.status = 'active'`,
    )
    .get() as { strategy_id: number; name: string; version_id: number; spec_json: string } | undefined;

  let scribeNeedsWs = false;
  if (scribeRow) {
    try {
      const spec = JSON.parse(scribeRow.spec_json) as Record<string, unknown>;
      scribeNeedsWs = spec.requires_websocket === true;
      console.log(`[worker-realtime] found stale-quote-arb (v${scribeRow.version_id}) requires_websocket=${scribeNeedsWs}`);
    } catch { /* ignore parse */ }
  } else {
    console.warn("[worker-realtime] stale-quote-arb strategy not found; running with no scribe attribution");
  }

  const rt = new PolymarketRealtime({
    autoReconnect: true,
    onStatusChange: (status) => {
      console.log(`[worker-realtime] status: ${status}`);
      if (status === ConnectionStatus.CONNECTED) {
        try {
          if (EVENT_SLUGS.length === 0 && MARKET_SLUGS.length === 0) {
            rt.subscribeActivity(); // firehose
          } else {
            for (const slug of EVENT_SLUGS) rt.subscribeActivity({ eventSlug: slug });
            for (const slug of MARKET_SLUGS) rt.subscribeActivity({ marketSlug: slug });
          }
          if (SUBSCRIBE_CRYPTO_PRICES) rt.subscribeCryptoPrices(["btcusdt", "ethusdt"]);
          if (SUBSCRIBE_USER_CHANNEL) {
            if (hasClobCreds()) {
              rt.subscribeUserChannel();
              console.log("[worker-realtime] subscribed: clob_user (authenticated)");
            } else {
              console.warn("[worker-realtime] REALTIME_USER_CHANNEL=1 but POLYMARKET_CLOB_* creds missing — skipping");
            }
          }
          console.log("[worker-realtime] subscriptions sent");
        } catch (err) {
          console.error("[worker-realtime] subscribe failed:", (err as Error).message);
        }
      }
    },
    onActivity: (msg) => {
      activityCount++;
      const p = msg.payload;
      // Attribute to scribe-sports when requires_websocket is set on the strategy.
      // Log every Nth activity event to keep evolution_log tidy.
      if (scribeNeedsWs && scribeRow && activityCount % 25 === 0) {
        insertEvolutionEvent({
          strategy_id: scribeRow.strategy_id,
          to_version_id: scribeRow.version_id,
          event_type: "realtime-tick",
          summary: `scribe-sports WS tick #${activityCount} (${msg.type}): ${p.side} ${p.size}@${p.price} ${p.slug.slice(0, 30)}`,
          payload_json: JSON.stringify({ topic: msg.topic, type: msg.type, payload: p }),
        });
      }
    },
    onClobUser: (msg) => {
      userChannelCount++;
      // Authenticated user-channel events are higher value — log every one to
      // evolution_log so the reconciler / audit trail can see broker-side truth
      // arriving in real time.
      insertEvolutionEvent({
        event_type: msg.type === "trade" ? "realtime-user-trade" : "realtime-user-order",
        summary: `clob_user ${msg.type}: ${(msg.payload as Record<string, unknown>).status ?? "(unknown)"}`,
        payload_json: JSON.stringify({ topic: msg.topic, type: msg.type, payload: msg.payload }),
      });
    },
    onCryptoPrice: (msg) => {
      cryptoPriceCount++;
      // Persist with 1-second debounce per symbol (see realtime-ticks.ts).
      // Drops intermediate ticks; keeps the table small while ensuring
      // sub-minute freshness for the arena context override.
      const symbol = msg.payload.symbol;
      const price = Number(msg.payload.value);
      const written = persistRealtimeTick(symbol, price, "poly-ws");
      if (written) cryptoTicksWritten++; else cryptoTicksDebounced++;
      if (cryptoPriceCount % 100 === 0) {
        console.log(`[worker-realtime] crypto_prices ticks: ${cryptoPriceCount} (wrote=${cryptoTicksWritten} debounced=${cryptoTicksDebounced}), latest=${symbol}@${price}`);
      }
    },
  });

  rt.connect();

  // Heartbeat — log throughput every HEARTBEAT_INTERVAL_MS and write a single
  // evolution event so the operator can verify the worker is healthy from
  // /evolution UI without tailing logs.
  // Stale-tick liveness check — if a product hasn't received a tick in
  // STALE_THRESHOLD_SEC, emit a `realtime-stalled` evolution_log event so
  // /evolution shows the silent-failure mode. Audit fix F6.
  const STALE_THRESHOLD_SEC = Number(process.env.REALTIME_STALE_SEC ?? "300");
  // Don't spam: only alert once per product per period. Reset on first fresh tick.
  const stalledProducts = new Set<string>();

  const heartbeat = setInterval(() => {
    const now = Date.now();
    const elapsedSec = (now - lastHeartbeatAt) / 1000;
    const recentActivity = activityCount - lastHeartbeatActivityCount;
    lastHeartbeatAt = now;
    lastHeartbeatActivityCount = activityCount;
    // Daily prune to keep realtime_ticks small. Cheap one-shot delete.
    const pruned = pruneOldTicks(24);

    // F6 stale-tick check: any product silent > STALE_THRESHOLD_SEC?
    const health = wsHealth(STALE_THRESHOLD_SEC);
    const stale = health.filter((h) => !h.fresh);
    const fresh = health.filter((h) => h.fresh);
    // Emit one-shot per product-going-stale.
    for (const h of stale) {
      if (stalledProducts.has(h.product_id)) continue;
      stalledProducts.add(h.product_id);
      insertEvolutionEvent({
        event_type: "realtime-stalled",
        summary: `WS stale: ${h.product_id} last tick ${h.ageSec}s ago (>= ${STALE_THRESHOLD_SEC}s threshold)`,
        payload_json: JSON.stringify({ product_id: h.product_id, ageSec: h.ageSec, threshold_sec: STALE_THRESHOLD_SEC, connected: rt.isConnected() }),
      });
    }
    // Clear the dedup flag when products recover.
    for (const h of fresh) stalledProducts.delete(h.product_id);

    console.log(`[worker-realtime] heartbeat: connected=${rt.isConnected()} activity_total=${activityCount} (+${recentActivity}/${elapsedSec.toFixed(0)}s) user_channel=${userChannelCount} crypto=${cryptoPriceCount} (wrote=${cryptoTicksWritten} debounced=${cryptoTicksDebounced})${pruned > 0 ? ` pruned=${pruned}` : ""}${stale.length > 0 ? ` STALE=[${stale.map((s) => s.product_id).join(",")}]` : ""}`);
    insertEvolutionEvent({
      event_type: "realtime-heartbeat",
      summary: `WS connected=${rt.isConnected()} activity+${recentActivity}/${elapsedSec.toFixed(0)}s crypto+${cryptoTicksWritten}${stale.length > 0 ? ` · ${stale.length} stale` : ""}`,
      payload_json: JSON.stringify({ activityCount, userChannelCount, cryptoPriceCount, cryptoTicksWritten, cryptoTicksDebounced, recentActivity, elapsedSec, pruned, stale_products: stale.map((s) => s.product_id) }),
    });
  }, HEARTBEAT_INTERVAL_MS);

  const stop = (signal: string) => {
    console.log(`[worker-realtime] ${signal} received — disconnecting`);
    clearInterval(heartbeat);
    rt.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((err) => {
  console.error("[worker-realtime] fatal:", err);
  process.exit(1);
});
