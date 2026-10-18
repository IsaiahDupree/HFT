/**
 * Wallet typology classifier — CLI report.
 *
 *   npm run classify:wallet -- --address 0x...                # single wallet
 *   npm run classify:wallet                                    # all tracked
 *   npm run classify:wallet -- --address 0x... --persist       # also write
 *                                                                wallet-typology event
 *
 * Pulls trades + open + closed positions + portfolio value for each
 * address, runs fingerprint + copyability + typology, prints a report.
 *
 * Output buckets:
 *   hft_bot              un_copyable        — speed edge
 *   conviction_trader    potentially_copyable — slow markets, real follow-time
 *   market_mover_whale   un_copyable        — own size moves the price
 *   mid_run_gambler      needs_verification — MTM book >> realized PnL
 *   insider_pattern      flagged_high_risk  — small N + extreme win rate
 *   retail               uninteresting      — tiny size, infrequent
 *   unclear              needs_more_data    — too little to classify
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { insertEvolutionEvent } from "../src/lib/db/queries.ts";
import { poly } from "../src/lib/polymarket/client.ts";
import { fingerprintWallet } from "../src/lib/wallets/fingerprint.ts";
import { scoreCopyability } from "../src/lib/wallets/copyability.ts";
import { classifyWalletTypology } from "../src/lib/wallets/typology.ts";
import { resolveHandleToAddress } from "../src/lib/wallets/resolve-handle.ts";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const ADDR = flag("address");
const HANDLE = flag("handle");
const PERSIST = args.includes("--persist");

function isValidAddr(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

async function classifyOne(address: string): Promise<void> {
  const [trades, openPositions, closedRaw, value] = await Promise.all([
    // Pull more trade history so single-day burst doesn't dominate cadence.
    // Polymarket caps at 500 per request; we'd paginate for full history later.
    poly.userTrades(address, { limit: 500 }).catch(() => []),
    poly.userPositions(address, { limit: 500 }).catch(() => []),
    fetch(`https://data-api.polymarket.com/closed-positions?user=${address}&limit=500`)
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []),
    poly.userValue(address).catch(() => null),
  ]);
  const tradesArr = Array.isArray(trades) ? (trades as any[]) : [];
  const closedArr = Array.isArray(closedRaw) ? (closedRaw as any[]) : [];
  const openArr = Array.isArray(openPositions) ? (openPositions as any[]) : [];

  const fp = fingerprintWallet({
    proxyWallet: address,
    trades: tradesArr,
    openPositions: openArr,
    closedPositions: closedArr,
  });
  const copy = scoreCopyability({ wallet: address, closedPositions: closedArr, trades: tradesArr });
  const typology = classifyWalletTypology({
    wallet: address,
    fingerprint: fp,
    copyability: copy,
    portfolioValueUsd: (value as any)?.value ?? null,
  });

  const banner = `╔═ ${address} ═══════════════════════════════════════════`;
  console.log("");
  console.log(banner);
  console.log(`║  bucket:        ${typology.primaryBucket.padEnd(20)} class: ${typology.copyabilityClass}`);
  console.log(`║  confidence:    ${(typology.confidence * 100).toFixed(0)}%`);
  console.log("╟  features ─────────────────────────────────────────────");
  for (const [k, v] of Object.entries(typology.features)) {
    const valStr =
      v == null
        ? "—"
        : typeof v === "number"
        ? Number.isFinite(v)
          ? v.toFixed(2)
          : String(v)
        : String(v);
    console.log(`║    ${k.padEnd(28)} ${valStr}`);
  }
  console.log("╟  candidates ───────────────────────────────────────────");
  for (const c of typology.candidates.slice(0, 5)) {
    console.log(`║    [${c.weight.toFixed(2)}] ${c.bucket.padEnd(22)} ${c.reason}`);
  }
  if (typology.caveats.length > 0) {
    console.log("╟  caveats ──────────────────────────────────────────────");
    for (const c of typology.caveats) console.log(`║    ⚠ ${c}`);
  }
  if (typology.resolutionPlan.length > 0) {
    console.log("╟  to resolve uncertainty ───────────────────────────────");
    for (const r of typology.resolutionPlan) console.log(`║    → ${r}`);
  }
  console.log("╚════════════════════════════════════════════════════════");

  if (PERSIST) {
    insertEvolutionEvent({
      event_type: "wallet-typology",
      summary: `${address.slice(0, 10)}… → ${typology.primaryBucket} (${typology.copyabilityClass}, ${(typology.confidence * 100).toFixed(0)}%)`,
      payload_json: JSON.stringify(typology),
    });
    console.log(`[classify-wallet] persisted to evolution_log`);
  }
}

(async () => {
  let addresses: string[];
  if (HANDLE) {
    console.log(`[classify-wallet] resolving handle "${HANDLE}"...`);
    try {
      const resolved = await resolveHandleToAddress(HANDLE);
      console.log(`[classify-wallet] resolved → ${resolved}`);
      addresses = [resolved];
    } catch (err) {
      console.error(`[classify-wallet] failed to resolve "${HANDLE}": ${(err as Error).message}`);
      process.exit(1);
    }
  } else if (ADDR) {
    if (!isValidAddr(ADDR)) {
      console.error(`[classify-wallet] invalid address "${ADDR}"`);
      console.error(`  expected 0x + 40 hex chars; got 0x + ${ADDR.startsWith("0x") ? ADDR.length - 2 : ADDR.length} chars`);
      console.error(`  TIP: try --handle "${ADDR}" to resolve from a partial / truncated URL`);
      process.exit(1);
    }
    addresses = [ADDR];
  } else {
    addresses = (db()
      .prepare("SELECT proxy_wallet FROM tracked_wallets WHERE proxy_wallet IS NOT NULL")
      .all() as Array<{ proxy_wallet: string }>).map((r) => r.proxy_wallet);
    console.log(`[classify-wallet] no --address given; classifying ${addresses.length} tracked wallets`);
  }
  for (const addr of addresses) {
    try {
      await classifyOne(addr);
    } catch (err) {
      console.error(`[classify-wallet] ${addr.slice(0, 10)}… FAILED: ${(err as Error).message}`);
    }
  }
})().catch((err) => {
  console.error("[classify-wallet] FATAL:", err);
  process.exit(1);
});
