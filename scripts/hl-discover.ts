/**
 * hl-discover — find the copyable humans the PnL leaderboard buries, by CONVICTION not profit. Pulls a broad
 * leaderboard slice ranked by ACCOUNT VALUE (holders have skin in the game, scalpers don't park size), reads
 * each wallet's live open positions, and finds coins where many independent wallets co-hold the same side. The
 * wallets in those conviction clusters become a SEED list written to data/wallet-seeds.json — a different
 * population than top-by-PnL — which `npm run hl:wallet-track -- --seeds data/wallet-seeds.json` then profiles
 * to confirm (or reject) trade-copyability. Discovery widens the net; the strategy profile is still the gate.
 *
 *   npm run hl:discover [-- --scan 300 --min-wallets 3]
 */
import "./_env.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parseLeaderboard, type WalletPosition } from "../src/lib/exec/smart-money.ts";
import { consensusCoins, seedFromConsensus, DEFAULT_DISCOVER } from "../src/lib/exec/consensus-discovery.ts";

const num = (n: string, d: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const SCAN = num("--scan", 300), MIN_WALLETS = num("--min-wallets", DEFAULT_DISCOVER.minWallets), SKIP = num("--skip", 0);
const INFO = "https://api.hyperliquid.xyz/info", LB = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const OUT = process.env.WALLET_SEEDS_OUT ?? resolve(process.cwd(), "data", "wallet-seeds.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function jget(u: string): Promise<any> { const r = await fetch(u, { signal: AbortSignal.timeout(30_000) }); if (!r.ok) throw new Error(`${r.status}`); return r.json(); }
async function info(b: unknown, tries = 4): Promise<any> { for (let i = 0; i < tries; i++) { const r = await fetch(INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(20_000) }); if (r.ok) return r.json(); if (r.status === 429 && i < tries - 1) { await sleep(1000 * (i + 1)); continue; } throw new Error(`info ${r.status}`); } }

console.log(`\nhl-discover — scanning accounts ranked ${SKIP + 1}–${SKIP + SCAN} by size${SKIP ? " (mid-size band — skipping the top whales/funds)" : ""} for conviction clusters (min ${MIN_WALLETS} co-holders)\n`);
const rows = parseLeaderboard(await jget(LB)).sort((a, b) => b.accountValue - a.accountValue).slice(SKIP, SKIP + SCAN);

const positions: WalletPosition[] = [];
let scanned = 0;
for (const w of rows) {
  try {
    const st = await info({ type: "clearinghouseState", user: w.address });
    const acct = Number(st?.marginSummary?.accountValue ?? w.accountValue);
    for (const a of (st?.assetPositions ?? []) as Array<{ position: { coin: string; szi: string; positionValue?: string } }>) {
      const szi = Number(a.position.szi);
      if (szi !== 0) positions.push({ wallet: w.address, coin: a.position.coin, szi, notionalUsd: Number(a.position.positionValue ?? 0), accountValue: acct });
    }
    if (++scanned % 50 === 0) process.stdout.write(`  scanned ${scanned}/${rows.length} · ${positions.length} open positions\n`);
    await sleep(35);
  } catch { /* skip */ }
}

const clusters = consensusCoins(positions, { ...DEFAULT_DISCOVER, minWallets: MIN_WALLETS });
const seeds = seedFromConsensus(clusters);

console.log(`\n  scanned ${scanned} wallets · ${positions.length} open positions · ${clusters.length} conviction clusters\n`);
console.log("  Top conviction clusters (coin · side · #wallets · $conviction):");
for (const c of clusters.slice(0, 12)) console.log(`    ${c.coin.padEnd(8)} ${c.side.padEnd(5)} ${String(c.nWallets).padStart(3)} wallets  $${(c.convictionUsd / 1e6).toFixed(2)}M`);

mkdirSync(dirname(OUT), { recursive: true });
const seedAddrs = seeds.map((s) => s.wallet);
writeFileSync(OUT, JSON.stringify({ generatedFrom: "consensus-discovery", scan: SCAN, minWallets: MIN_WALLETS, nClusters: clusters.length, seeds }, null, 2));
console.log(`\n  ${seeds.length} seed wallets (co-holders) → ${OUT}`);
console.log(`  wallets in ≥2 clusters: ${seeds.filter((s) => s.clusters >= 2).length}`);
console.log(`\n  next: npm run hl:wallet-track -- --seeds ${OUT.replace(process.cwd() + "/", "")} --days 30\n`);
