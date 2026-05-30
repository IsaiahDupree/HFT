/**
 * Aave V3 liquidation-risk watcher — one-shot scan.
 *
 *   npm run watch:aave-liq
 *   npm run watch:aave-liq -- --threshold 1.5
 *   npm run watch:aave-liq -- --addresses 0xabc,0xdef
 *
 * For each tracked wallet (or --addresses override), reads Aave V3 account
 * data on Polygon, logs a liquidation-risk event for wallets with HF < threshold.
 *
 * Defaults to 1.5 (cautious-or-worse). Dedupes within the same hour on
 * (wallet, hf-bucket) so re-runs don't double-fire on the same risk level.
 *
 * Run from a cron or docker-compose sidecar (every 5–15min is plenty for HF
 * tracking — these move slowly except during liquidation cascades).
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { insertEvolutionEvent } from "../src/lib/db/queries.ts";
import { defaultAavePolygonClient, getAaveAccountData } from "../src/lib/onchain/aave.ts";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const THRESHOLD = Number(flag("threshold") ?? 1.5);
const ADDRESSES_RAW = flag("addresses");

(async () => {
  const client = defaultAavePolygonClient();
  const handle = db();

  let addresses: string[];
  if (ADDRESSES_RAW) {
    addresses = ADDRESSES_RAW.split(",").map((s) => s.trim()).filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s));
  } else {
    const rows = handle
      .prepare("SELECT proxy_wallet, handle FROM tracked_wallets WHERE proxy_wallet IS NOT NULL")
      .all() as Array<{ proxy_wallet: string; handle: string }>;
    addresses = rows.map((r) => r.proxy_wallet);
  }
  console.log(`[aave-watch] scanning ${addresses.length} addresses against HF<${THRESHOLD}`);
  if (addresses.length === 0) return;

  // Build a dedup set from the last hour of aave-liquidation-risk events
  const recent = handle
    .prepare(
      `SELECT payload_json FROM evolution_log
        WHERE event_type = 'aave-liquidation-risk'
          AND created_at >= datetime('now', '-1 hour')`,
    )
    .all() as Array<{ payload_json: string }>;
  const seen = new Set<string>();
  for (const r of recent) {
    try {
      const p = JSON.parse(r.payload_json);
      seen.add(`${p.wallet}|${p.riskTier}`);
    } catch {
      /* ignore */
    }
  }

  let observed = 0;
  let risky = 0;
  let logged = 0;
  for (const addr of addresses) {
    try {
      const data = await getAaveAccountData(client, addr as `0x${string}`);
      observed++;
      if (data.riskTier === "no_position") continue;
      const hfPrint = Number.isFinite(data.healthFactor) ? data.healthFactor.toFixed(2) : "∞";
      if (Number.isFinite(data.healthFactor) && data.healthFactor < THRESHOLD) {
        risky++;
        console.log(`  ⚠ ${addr.slice(0, 10)}… HF=${hfPrint} collateral=$${data.totalCollateralUsd.toFixed(0)} debt=$${data.totalDebtUsd.toFixed(0)} tier=${data.riskTier}`);
        const dedupKey = `${data.wallet}|${data.riskTier}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        insertEvolutionEvent({
          event_type: "aave-liquidation-risk",
          summary: `${data.riskTier}: ${addr.slice(0, 10)}… HF=${hfPrint} (collateral $${data.totalCollateralUsd.toFixed(0)}, debt $${data.totalDebtUsd.toFixed(0)})`,
          payload_json: JSON.stringify({
            wallet: data.wallet,
            healthFactor: data.healthFactor,
            totalCollateralUsd: data.totalCollateralUsd,
            totalDebtUsd: data.totalDebtUsd,
            availableBorrowsUsd: data.availableBorrowsUsd,
            riskTier: data.riskTier,
            ltvBps: data.ltvBps,
            currentLiquidationThresholdBps: data.currentLiquidationThresholdBps,
            scannedAt: new Date().toISOString(),
          }),
        });
        logged++;
      }
    } catch (err) {
      console.warn(`  ✗ ${addr.slice(0, 10)}…: ${(err as Error).message}`);
    }
  }
  console.log(`[aave-watch] observed=${observed} risky=${risky} logged=${logged} (${risky - logged} deduped)`);
  if (observed === 0) {
    insertEvolutionEvent({
      event_type: "aave-watch-empty",
      summary: `aave-watch: scanned ${addresses.length}, all RPC reads failed`,
      payload_json: JSON.stringify({ addresses: addresses.length }),
    });
  }
})().catch((err) => {
  console.error("[aave-watch] FAILED:", err);
  process.exit(1);
});
