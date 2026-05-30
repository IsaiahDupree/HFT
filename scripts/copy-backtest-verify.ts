/**
 * Cross-validate Polymarket Data API trades against the on-chain
 * `wallet_fills` mirror that `scripts/backfill-wallet.ts` populates from CTF
 * Exchange `OrderFilled` events. Any large discrepancy means the Data API is
 * either dropping fills (back end skew) or counting things the chain doesn't
 * (synthetic events).
 *
 *   npm run copy:verify                        # all tracked wallets
 *   npm run copy:verify -- --wallet 0x...      # one wallet only
 *
 * Output per wallet: total counts, USD volume, price-divergence histogram.
 * Read-only.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { poly } from "../src/lib/polymarket/client.ts";

const argv = process.argv.slice(2);
function flag(name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] ?? null : null;
}
const onlyWallet = flag("wallet");
const limit = Number(flag("limit") ?? "500");

const handle = db();
const wallets = onlyWallet
  ? handle.prepare("SELECT id, handle, proxy_wallet FROM tracked_wallets WHERE proxy_wallet = ? OR handle = ?").all(onlyWallet, onlyWallet)
  : handle.prepare("SELECT id, handle, proxy_wallet FROM tracked_wallets WHERE proxy_wallet IS NOT NULL").all();

if (wallets.length === 0) {
  console.log("No tracked wallets.");
  process.exit(0);
}

for (const w of wallets as Array<{ handle: string; proxy_wallet: string }>) {
  const addr = w.proxy_wallet.toLowerCase();
  console.log(`\n=== ${w.handle} (${addr}) ===`);

  const onchain = handle.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(implied_usd), 0) AS usd,
            MIN(implied_price) AS pmin, MAX(implied_price) AS pmax
       FROM wallet_fills WHERE wallet = ?`,
  ).get(addr) as { n: number; usd: number; pmin: number | null; pmax: number | null };
  console.log(`  on-chain wallet_fills:    n=${onchain.n}  usd=$${onchain.usd.toFixed(2)}  price∈[${onchain.pmin?.toFixed(3) ?? "-"},${onchain.pmax?.toFixed(3) ?? "-"}]`);

  if (onchain.n === 0) {
    console.log(`  (no on-chain mirror yet — run \`npm run backfill:wallet -- --wallet ${addr}\` to populate)`);
  }

  let apiTrades: any[] = [];
  try {
    apiTrades = await poly.userTrades(addr, { limit });
  } catch (e) {
    console.log(`  data API fetch failed: ${(e as Error).message}`);
    continue;
  }
  // The Data API's `usdcSize` is often empty on /trades — fall back to
  // size × price (the implied dollar notional).
  const apiUsd = apiTrades.reduce((s, t) => {
    const explicit = Number(t.usdcSize ?? 0);
    if (explicit > 0) return s + explicit;
    const sz = Number(t.size ?? 0);
    const px = Number(t.price ?? 0);
    return s + (Number.isFinite(sz) && Number.isFinite(px) ? sz * px : 0);
  }, 0);
  const apiPrices = apiTrades.map((t) => Number(t.price)).filter((p) => Number.isFinite(p) && p > 0 && p < 1);
  const apiPmin = apiPrices.length > 0 ? Math.min(...apiPrices) : null;
  const apiPmax = apiPrices.length > 0 ? Math.max(...apiPrices) : null;
  console.log(`  data API userTrades(${limit}): n=${apiTrades.length}  usd=$${apiUsd.toFixed(2)}  price∈[${apiPmin?.toFixed(3) ?? "-"},${apiPmax?.toFixed(3) ?? "-"}]`);

  // If both sides have data, sample-compare by tx_hash where present.
  if (onchain.n > 0 && apiTrades.length > 0) {
    const apiHashes = new Set(apiTrades.map((t) => String(t.transactionHash ?? "").toLowerCase()).filter(Boolean));
    const chainHashes = handle.prepare(`SELECT DISTINCT LOWER(tx_hash) AS h FROM wallet_fills WHERE wallet = ?`).all(addr) as Array<{ h: string }>;
    const chainSet = new Set(chainHashes.map((r) => r.h));
    const matched = [...apiHashes].filter((h) => chainSet.has(h)).length;
    console.log(`  tx-hash overlap: ${matched}/${apiHashes.size} API trades present on-chain`);
    const apiOnly = [...apiHashes].filter((h) => !chainSet.has(h)).length;
    const chainOnly = chainHashes.filter((r) => !apiHashes.has(r.h)).length;
    console.log(`    api-only: ${apiOnly} · chain-only: ${chainOnly}`);
  }
}
