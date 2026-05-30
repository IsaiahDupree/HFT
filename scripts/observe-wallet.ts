/**
 * Real-time wallet observer + trade classifier.
 *
 *   npm run observe:wallet                                  # all tracked wallets
 *   npm run observe:wallet -- --addresses 0xA,0xB           # specific wallets
 *   npm run observe:wallet -- --interval 30                 # poll every 30s
 *
 * For each tracked wallet (or --addresses override), polls Polymarket
 * userTrades, detects new trades (dedup by transactionHash), classifies
 * each via fingerprint + intent + per-trade features, persists as
 * `wallet-trade-classified` event with full provenance.
 *
 * Runs until SIGINT. Heartbeats every 5 cycles. Cross-wallet context
 * for each new trade is read from previous wallet-trade-classified events
 * within the last 5 minutes so the observer accumulates its own consensus
 * signal over time.
 *
 * Idempotency: each (wallet, txHash) pair classified at most once. The
 * dedup set is rebuilt from the last 7d of wallet-trade-classified events
 * on startup so a restart doesn't re-classify.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { insertEvolutionEvent } from "../src/lib/db/queries.ts";
import { poly } from "../src/lib/polymarket/client.ts";
import { fingerprintWallet } from "../src/lib/wallets/fingerprint.ts";
import { classifyIntent, type IntentTrade } from "../src/lib/wallets/intent.ts";
import {
  extractTradeFeatures,
  type TradeForFeatures,
  type WalletHistorySummary,
} from "../src/lib/wallets/trade-features.ts";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const INTERVAL_SEC = Number(flag("interval") ?? 60);
const ADDRESSES_RAW = flag("addresses");

function toTradeForFeatures(t: any): TradeForFeatures {
  const tsRaw = Number(t.timestamp ?? 0);
  const ms = tsRaw > 1e12 ? tsRaw : tsRaw * 1000;
  return {
    marketKey: String(t.conditionId ?? t.eventSlug ?? "?"),
    direction: String(t.outcome ?? t.side ?? "?").toUpperCase(),
    side: (String(t.side ?? "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL",
    price: Number(t.price ?? 0),
    usd: Number(t.usdcSize ?? Number(t.size ?? 0) * Number(t.price ?? 0)),
    ts: new Date(ms).toISOString(),
  };
}

function readCrossWalletContext(
  marketKey: string,
  direction: string,
  selfWallet: string,
  cutoffIso: string,
): { agreementCount5min: number; clusterCount5min: number } {
  const others = db()
    .prepare(
      `SELECT payload_json FROM evolution_log
        WHERE event_type IN ('wallet-trade-classified', 'consensus-signal')
          AND created_at >= ?
          AND payload_json LIKE ?`,
    )
    .all(cutoffIso, `%${marketKey}%`) as Array<{ payload_json: string }>;
  const distinct = new Set<string>();
  for (const o of others) {
    try {
      const p = JSON.parse(o.payload_json);
      const otherWallet = p.wallet ?? p.trade?.proxyWallet;
      const otherDir = p.trade?.direction ?? p.direction;
      if (!otherWallet || otherWallet === selfWallet) continue;
      if (String(otherDir ?? "").toUpperCase() !== direction.toUpperCase()) continue;
      distinct.add(otherWallet);
    } catch {
      /* ignore */
    }
  }
  // We don't have cluster IDs at observe time without a full clusters pass;
  // approximate clusterCount = distinct wallet count. Refine later by
  // joining against a cached clusterMap.
  return { agreementCount5min: distinct.size, clusterCount5min: distinct.size };
}

async function pollWallet(wallet: string, seenTxs: Set<string>): Promise<number> {
  const raw = await poly.userTrades(wallet, { limit: 200 });
  if (!Array.isArray(raw)) return 0;
  const trades = raw as any[];

  const fp = fingerprintWallet({ proxyWallet: wallet, trades });
  const recentTrades = trades.map(toTradeForFeatures);
  const walletHistory: WalletHistorySummary = {
    medianTradeUsd: fp.medianTradeUsd,
    tradesPerHourMean: fp.tradesPerHourMean,
    peakHourUtc: fp.peakHourUtc,
    recentTrades,
  };
  const intentTrades: IntentTrade[] = recentTrades.map((t) => ({
    marketKey: t.marketKey,
    side: t.side,
    price: t.price,
    usd: t.usd,
    ts: t.ts,
  }));
  const intent = classifyIntent(intentTrades, { windowMinutes: 60 });

  let newClassified = 0;
  for (const t of trades) {
    const txHash = String(t.transactionHash ?? "");
    if (!txHash) continue;
    const key = `${wallet}|${txHash}`;
    if (seenTxs.has(key)) continue;
    seenTxs.add(key);

    const trade = toTradeForFeatures(t);
    const cutoffIso = new Date(Date.parse(trade.ts) - 5 * 60_000).toISOString();
    const crossWallet = readCrossWalletContext(trade.marketKey, trade.direction, wallet, cutoffIso);

    const features = extractTradeFeatures({ trade, walletHistory, crossWallet });

    insertEvolutionEvent({
      event_type: "wallet-trade-classified",
      summary: `${wallet.slice(0, 10)}… ${trade.side} ${trade.direction} ${trade.marketKey.slice(
        0,
        16,
      )}… @ ${trade.price.toFixed(3)} • ${features.likelyDrivers[0]} • intent=${intent.label}`,
      payload_json: JSON.stringify({
        wallet,
        trade: { ...trade, proxyWallet: wallet, txHash, title: t.title ?? t.slug ?? undefined },
        intent: { label: intent.label, confidence: intent.confidence },
        fingerprintFamily: fp.strategyFamily,
        features,
      }),
    });
    newClassified++;
  }
  return newClassified;
}

(async () => {
  let addresses: string[];
  if (ADDRESSES_RAW) {
    addresses = ADDRESSES_RAW.split(",")
      .map((s) => s.trim())
      .filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s));
  } else {
    addresses = (db()
      .prepare("SELECT proxy_wallet FROM tracked_wallets WHERE proxy_wallet IS NOT NULL")
      .all() as Array<{ proxy_wallet: string }>).map((r) => r.proxy_wallet);
  }
  console.log(`[observe-wallet] watching ${addresses.length} wallets every ${INTERVAL_SEC}s`);
  if (addresses.length === 0) {
    console.log(`[observe-wallet] no tracked wallets. seed:tracked-wallets first.`);
    return;
  }

  const seen = new Set<string>();
  const existing = db()
    .prepare(
      `SELECT payload_json FROM evolution_log
        WHERE event_type = 'wallet-trade-classified'
          AND created_at >= datetime('now', '-7 days')`,
    )
    .all() as Array<{ payload_json: string }>;
  for (const e of existing) {
    try {
      const p = JSON.parse(e.payload_json);
      if (p.wallet && p.trade?.txHash) seen.add(`${p.wallet}|${p.trade.txHash}`);
    } catch {
      /* ignore */
    }
  }
  console.log(`[observe-wallet] starting with ${seen.size} previously-classified trades in memory`);

  let cycles = 0;
  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
    console.log(`\n[observe-wallet] stopping`);
    process.exit(0);
  });

  while (!stop) {
    cycles++;
    let totalNew = 0;
    for (const addr of addresses) {
      try {
        const n = await pollWallet(addr, seen);
        if (n > 0) {
          console.log(`  [+] ${addr.slice(0, 10)}…: ${n} new trades classified`);
          totalNew += n;
        }
      } catch (err) {
        console.warn(`  [!] ${addr.slice(0, 10)}…: ${(err as Error).message}`);
      }
    }
    if (cycles % 5 === 0 || totalNew > 0) {
      console.log(
        `[observe-wallet] cycle ${cycles}: ${totalNew} new classified, ${seen.size} tracked total`,
      );
    }
    await new Promise((r) => setTimeout(r, INTERVAL_SEC * 1000));
  }
})().catch((err) => {
  console.error("[observe-wallet] FATAL:", err);
  process.exit(1);
});
