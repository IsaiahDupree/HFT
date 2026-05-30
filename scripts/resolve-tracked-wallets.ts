/**
 * For each tracked_wallets handle, look up the proxy wallet via Gamma's
 * /v1/leaderboard?userName=<handle> query (most reliable resolver we have
 * because handles can collide otherwise). Stores the resolved address.
 *
 * Handles already starting with `0x` are treated as raw addresses (truncated
 * or full) and skipped — caller must fill in full addresses manually.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { poly } from "../src/lib/polymarket/client.ts";

const handle = db();
const rows = handle.prepare("SELECT id, handle FROM tracked_wallets ORDER BY id").all() as Array<{ id: number; handle: string }>;
const update = handle.prepare("UPDATE tracked_wallets SET proxy_wallet = ?, last_resolved = datetime('now') WHERE id = ?");

let resolved = 0;
let skipped = 0;
let failed = 0;
for (const row of rows) {
  // Skip only handles that look like full Ethereum addresses (0x + 40 hex chars).
  // Polymarket handles like "0x732F1" should still be resolved via userName lookup.
  if (/^0x[0-9a-fA-F]{40}$/.test(row.handle)) {
    skipped++;
    continue;
  }
  try {
    // Gamma leaderboard accepts userName as exact match. The full traderLeaderboard
    // wrapper hits Data API; here we want Gamma so handles get fuzzy-resolved.
    const r = await poly.traderLeaderboard({ limit: 1 }).catch(() => []);
    // Reissue with userName param — the wrapper doesn't expose it, so call manually.
    const data = await fetch(
      `https://data-api.polymarket.com/v1/leaderboard?category=OVERALL&timePeriod=ALL&orderBy=PNL&limit=1&userName=${encodeURIComponent(row.handle)}`,
    );
    if (!data.ok) {
      failed++;
      console.warn(`[fail ${data.status}] ${row.handle}`);
      continue;
    }
    const arr = (await data.json()) as Array<{ proxyWallet?: string; userName?: string }>;
    const proxy = arr?.[0]?.proxyWallet;
    if (!proxy) {
      failed++;
      console.warn(`[no match] ${row.handle}`);
      continue;
    }
    update.run(proxy, row.id);
    resolved++;
    console.log(`[ ok ] ${row.handle.padEnd(22)} → ${proxy}`);
  } catch (err) {
    failed++;
    console.warn(`[err] ${row.handle}: ${(err as Error).message}`);
  }
}

console.log(`\nResolved ${resolved}, skipped ${skipped} (0x… handles), failed ${failed}.`);
