/**
 * Continuous wallet stream observer.
 *
 *   npm run scan:wallets
 *
 * Subscribes to Polymarket's `activity` WS channel and maintains an
 * in-memory rolling per-wallet metrics map. Flags:
 *   - whale trades (size ≥ WHALE_USD)
 *   - bot-cadence wallets (>= N trades in T seconds)
 *   - new wallets that suddenly appear with high volume
 *
 * Writes flagged events to `evolution_log` with event_type `wallet-*`.
 * Heartbeats every 60s with throughput stats.
 *
 * Long-running; the docker-compose `realtime` sidecar is the natural host.
 * Standalone invocation is fine for development too.
 *
 * NOT a copy-trader. The observer's value is *cross-sectional vision* —
 * seeing all wallets at once. Consumers downstream (cross-wallet
 * consensus detector, fingerprint summarizer) layer on top.
 */
import "./_env.ts";
import { ConnectionStatus, PolymarketRealtime } from "../src/lib/polymarket/realtime.ts";
import { insertEvolutionEvent } from "../src/lib/db/queries.ts";

const WHALE_USD = Number(process.env.SCAN_WHALE_USD ?? "1000");
const BOT_CADENCE_WINDOW_SEC = Number(process.env.SCAN_BOT_WINDOW_SEC ?? "60");
const BOT_CADENCE_MIN_TRADES = Number(process.env.SCAN_BOT_MIN_TRADES ?? "10");
const HEARTBEAT_MS = Number(process.env.SCAN_HEARTBEAT_MS ?? "60000");
const FLAG_DEDUP_MS = Number(process.env.SCAN_FLAG_DEDUP_MS ?? "5 * 60 * 1000");

type WalletMetrics = {
  proxyWallet: string;
  firstSeenMs: number;
  lastTradeMs: number;
  tradeCount: number;
  totalUsd: number;
  cryptoCount: number;
  recentTradeMs: number[];   // ring of the last N timestamps
  lastFlaggedWhaleMs: number;
  lastFlaggedBotMs: number;
};

const wallets = new Map<string, WalletMetrics>();
let activityTotal = 0;
let whaleFlagsTotal = 0;
let botFlagsTotal = 0;
let lastHeartbeatAt = Date.now();
let lastHeartbeatActivity = 0;

function looksCrypto(slug: string | undefined, title: string | undefined): boolean {
  const blob = `${slug ?? ""} ${title ?? ""}`.toLowerCase();
  return ["btc", "bitcoin", "eth", "ethereum", "sol", "solana", "xrp", "doge"].some((k) => blob.includes(k));
}

function ingestTrade(payload: any) {
  activityTotal++;
  const wallet = String(payload.proxyWallet ?? "").toLowerCase();
  if (!wallet) return;
  const size = Number(payload.size ?? 0);
  const price = Number(payload.price ?? 0);
  const usd = size * price;
  const ts = Number(payload.timestamp ?? Date.now() / 1000) * 1000;
  const slug = payload.slug;
  const title = payload.title;

  let m = wallets.get(wallet);
  if (!m) {
    m = {
      proxyWallet: payload.proxyWallet,
      firstSeenMs: ts,
      lastTradeMs: ts,
      tradeCount: 0,
      totalUsd: 0,
      cryptoCount: 0,
      recentTradeMs: [],
      lastFlaggedWhaleMs: 0,
      lastFlaggedBotMs: 0,
    };
    wallets.set(wallet, m);
  }
  m.lastTradeMs = ts;
  m.tradeCount++;
  m.totalUsd += usd;
  if (looksCrypto(slug, title)) m.cryptoCount++;
  m.recentTradeMs.push(ts);
  if (m.recentTradeMs.length > 200) m.recentTradeMs.shift();

  // Whale flag
  if (usd >= WHALE_USD && ts - m.lastFlaggedWhaleMs > FLAG_DEDUP_MS) {
    m.lastFlaggedWhaleMs = ts;
    whaleFlagsTotal++;
    insertEvolutionEvent({
      event_type: "wallet-whale-trade",
      summary: `whale: ${m.proxyWallet.slice(0, 10)}… ${payload.side} $${usd.toFixed(0)} @ ${price.toFixed(3)} on "${(title ?? slug ?? "?").slice(0, 60)}"`,
      payload_json: JSON.stringify({ proxyWallet: m.proxyWallet, usd, price, size, side: payload.side, slug, title, ts }),
    });
  }

  // Bot cadence flag
  const cutoff = ts - BOT_CADENCE_WINDOW_SEC * 1000;
  const recent = m.recentTradeMs.filter((t) => t >= cutoff);
  if (recent.length >= BOT_CADENCE_MIN_TRADES && ts - m.lastFlaggedBotMs > FLAG_DEDUP_MS) {
    m.lastFlaggedBotMs = ts;
    botFlagsTotal++;
    insertEvolutionEvent({
      event_type: "wallet-bot-cadence",
      summary: `bot: ${m.proxyWallet.slice(0, 10)}… fired ${recent.length} trades in ${BOT_CADENCE_WINDOW_SEC}s`,
      payload_json: JSON.stringify({ proxyWallet: m.proxyWallet, tradesInWindow: recent.length, windowSec: BOT_CADENCE_WINDOW_SEC, lifetimeCount: m.tradeCount, lifetimeUsd: m.totalUsd, cryptoPct: m.cryptoCount / m.tradeCount }),
    });
  }
}

function heartbeat() {
  const now = Date.now();
  const elapsedSec = (now - lastHeartbeatAt) / 1000;
  const recent = activityTotal - lastHeartbeatActivity;
  lastHeartbeatAt = now;
  lastHeartbeatActivity = activityTotal;
  console.log(
    `[scan-wallets] heartbeat: total_activity=${activityTotal} (+${recent}/${elapsedSec.toFixed(0)}s) ` +
    `unique_wallets=${wallets.size} whale_flags=${whaleFlagsTotal} bot_flags=${botFlagsTotal}`,
  );
  insertEvolutionEvent({
    event_type: "wallet-scan-heartbeat",
    summary: `scan-wallets: ${wallets.size} wallets observed; +${recent} trades in ${elapsedSec.toFixed(0)}s; whales=${whaleFlagsTotal} bots=${botFlagsTotal}`,
    payload_json: JSON.stringify({
      uniqueWallets: wallets.size, activityTotal, recent, elapsedSec,
      whaleFlagsTotal, botFlagsTotal,
      topVolumeWallets: [...wallets.values()].sort((a, b) => b.totalUsd - a.totalUsd).slice(0, 5).map((w) => ({
        proxyWallet: w.proxyWallet, totalUsd: Math.round(w.totalUsd), tradeCount: w.tradeCount,
      })),
    }),
  });
}

async function main() {
  console.log(`[scan-wallets] starting — whale=$${WHALE_USD} bot=≥${BOT_CADENCE_MIN_TRADES}/${BOT_CADENCE_WINDOW_SEC}s heartbeat=${HEARTBEAT_MS}ms`);
  const rt = new PolymarketRealtime({
    autoReconnect: true,
    onStatusChange: (status) => {
      console.log(`[scan-wallets] status: ${status}`);
      if (status === ConnectionStatus.CONNECTED) {
        try {
          rt.subscribeActivity(); // firehose; no filter
          console.log("[scan-wallets] subscribed to activity firehose");
        } catch (err) {
          console.error("[scan-wallets] subscribe failed:", (err as Error).message);
        }
      }
    },
    onActivity: (msg) => ingestTrade(msg.payload),
  });
  rt.connect();

  const hb = setInterval(heartbeat, HEARTBEAT_MS);
  const stop = (signal: string) => {
    console.log(`[scan-wallets] ${signal} received — disconnecting`);
    clearInterval(hb);
    rt.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((err) => { console.error("[scan-wallets] fatal:", err); process.exit(1); });
