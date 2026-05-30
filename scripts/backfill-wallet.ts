/**
 * Backfills a wallet's on-chain Polymarket OrderFilled events directly from
 * Polygon via viem `eth_getLogs`. Doesn't go through Polymarket's Data API —
 * we read the contract logs ourselves, which gives us:
 *
 *  - ground-truth fill timestamps (block-accurate)
 *  - the maker/taker counterparty, builder code, and fee per fill
 *  - the actual on-chain price (collateral/share ratio)
 *
 * Stores fills into a new `wallet_fills` table (created on first run). Prints
 * a compact pattern summary at the end.
 *
 *   npx tsx scripts/backfill-wallet.ts <handle|0xaddress> [--blocks N] [--chunk M]
 *
 * Default scan: 10000 blocks (~5.5 hours of Polygon activity), 1000 blocks per
 * chunk to stay under public RPC log-window limits.
 */
import "./_env.ts";
import { createPublicClient, http, parseAbiItem, pad } from "viem";
import { polygon } from "viem/chains";
import { db } from "../src/lib/db/client.ts";
import { POLYGON_CONTRACTS } from "../src/lib/polymarket/onchain.ts";

const args = process.argv.slice(2);
const handle = args.find((a) => !a.startsWith("--"));
const blocksArg = Number(args.find((a) => a.startsWith("--blocks="))?.split("=")[1] ?? "10000");
const chunkArg = Number(args.find((a) => a.startsWith("--chunk="))?.split("=")[1] ?? "1000");
if (!handle) {
  console.error("usage: tsx scripts/backfill-wallet.ts <handle|0xaddress> [--blocks=N] [--chunk=M]");
  process.exit(2);
}

const EVENT = parseAbiItem(
  "event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint8 side, uint256 tokenId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee, bytes32 builder, bytes32 metadata)",
);

async function resolveAddress(input: string): Promise<{ address: `0x${string}`; userName?: string; pnl?: number }> {
  if (/^0x[0-9a-fA-F]{40}$/.test(input)) return { address: input as `0x${string}` };
  const r = await fetch(
    `https://data-api.polymarket.com/v1/leaderboard?category=OVERALL&timePeriod=ALL&orderBy=PNL&limit=1&userName=${encodeURIComponent(input)}`,
  );
  if (!r.ok) throw new Error(`leaderboard lookup failed (${r.status})`);
  const arr = (await r.json()) as Array<{ proxyWallet: string; userName: string; pnl: number }>;
  if (!arr?.[0]?.proxyWallet) throw new Error(`no leaderboard match for "${input}"`);
  return { address: arr[0].proxyWallet as `0x${string}`, userName: arr[0].userName, pnl: arr[0].pnl };
}

(async () => {
  const handleDb = db();
  handleDb.exec(`
    CREATE TABLE IF NOT EXISTS wallet_fills (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet          TEXT NOT NULL,
      side_of_wallet  TEXT NOT NULL,             -- 'maker' | 'taker'
      exchange        TEXT NOT NULL,             -- 'ctf' | 'neg-risk'
      block_number    INTEGER NOT NULL,
      tx_hash         TEXT NOT NULL,
      order_hash      TEXT NOT NULL,
      maker_address   TEXT NOT NULL,
      taker_address   TEXT NOT NULL,
      maker_side      TEXT NOT NULL,             -- 'BUY' | 'SELL'
      token_id        TEXT NOT NULL,
      maker_amount    TEXT NOT NULL,             -- raw uint256 as string
      taker_amount    TEXT NOT NULL,
      fee             TEXT NOT NULL,
      builder         TEXT,
      implied_price   REAL,
      implied_shares  REAL,
      implied_usd     REAL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tx_hash, order_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_fills_wallet_block ON wallet_fills(wallet, block_number DESC);
  `);

  const resolved = await resolveAddress(handle);
  const addr = resolved.address.toLowerCase() as `0x${string}`;
  console.log(`[backfill] wallet ${addr}${resolved.userName ? ` (@${resolved.userName})` : ""}${resolved.pnl ? ` PnL all-time $${Math.round(resolved.pnl)}` : ""}`);

  // RPC override via env so users can swap when the default rate-limits.
  // Verified options: https://polygon.drpc.org, custom Alchemy/Infura URLs.
  const rpcUrl = process.env.POLYGON_RPC_URL;
  const client = createPublicClient({ chain: polygon, transport: rpcUrl ? http(rpcUrl) : http() });
  if (rpcUrl) console.log(`[backfill] RPC: ${rpcUrl}`);
  const latest = await client.getBlockNumber();
  const start = latest - BigInt(blocksArg);
  console.log(`[backfill] scanning blocks ${start.toLocaleString()} → ${latest.toLocaleString()} (${blocksArg.toLocaleString()} blocks, ${chunkArg.toLocaleString()}-block chunks)`);

  const upsert = handleDb.prepare(
    `INSERT OR IGNORE INTO wallet_fills
      (wallet, side_of_wallet, exchange, block_number, tx_hash, order_hash, maker_address, taker_address, maker_side, token_id, maker_amount, taker_amount, fee, builder, implied_price, implied_shares, implied_usd)
     VALUES (@wallet, @side_of_wallet, @exchange, @block_number, @tx_hash, @order_hash, @maker_address, @taker_address, @maker_side, @token_id, @maker_amount, @taker_amount, @fee, @builder, @implied_price, @implied_shares, @implied_usd)`,
  );

  const exchanges: Array<{ tag: "ctf" | "neg-risk"; addr: `0x${string}` }> = [
    { tag: "ctf", addr: POLYGON_CONTRACTS.ctfExchange as `0x${string}` },
    { tag: "neg-risk", addr: POLYGON_CONTRACTS.negRiskCtfExchange as `0x${string}` },
  ];

  let totalFills = 0;
  // The address topic is 32-byte left-padded.
  const addrTopic = pad(addr, { size: 32 }) as `0x${string}`;

  for (const ex of exchanges) {
    let totalForExchange = 0;
    let chunksWithFills = 0;
    let chunksScanned = 0;
    let chunksErrored = 0;
    // Two passes — one with the wallet as `maker`, one as `taker`. The event
    // indexes orderHash (topic1), maker (topic2), taker (topic3). We pass
    // `args` with `maker` or `taker` and viem builds the right topic filter.
    for (const role of ["maker", "taker"] as const) {
      for (let from = start; from <= latest; from += BigInt(chunkArg)) {
        const to = from + BigInt(chunkArg) - 1n > latest ? latest : from + BigInt(chunkArg) - 1n;
        chunksScanned += 1;
        let logs;
        try {
          logs = await client.getLogs({
            address: ex.addr,
            event: EVENT,
            args: role === "maker" ? { maker: addr } : { taker: addr },
            fromBlock: from,
            toBlock: to,
          });
        } catch (err) {
          chunksErrored += 1;
          console.warn(`[backfill] ${ex.tag} ${role} ${from}-${to} err: ${(err as Error).message.slice(0, 80)}`);
          continue;
        }
        if (logs.length > 0) {
          chunksWithFills += 1;
          if (process.env.BACKFILL_VERBOSE) {
            console.log(`[backfill] ${ex.tag} ${role} ${from}-${to}: ${logs.length} fills`);
          }
        }
        for (const log of logs) {
          const a = (log as any).args;
          const makerSide = Number(a.side) === 0 ? "BUY" : "SELL";
          const makerAmt = Number(a.makerAmountFilled) / 1e6;
          const takerAmt = Number(a.takerAmountFilled) / 1e6;
          // v2 semantics: maker pays USDC on BUY, shares on SELL.
          const pricePerShare = makerSide === "BUY" ? makerAmt / takerAmt : takerAmt / makerAmt;
          const sizeShares = makerSide === "BUY" ? takerAmt : makerAmt;
          upsert.run({
            wallet: addr,
            side_of_wallet: role,
            exchange: ex.tag,
            block_number: Number(log.blockNumber),
            tx_hash: String(log.transactionHash),
            order_hash: String(a.orderHash),
            maker_address: String(a.maker).toLowerCase(),
            taker_address: String(a.taker).toLowerCase(),
            maker_side: makerSide,
            token_id: String(a.tokenId),
            maker_amount: String(a.makerAmountFilled),
            taker_amount: String(a.takerAmountFilled),
            fee: String(a.fee),
            builder: String(a.builder),
            implied_price: pricePerShare,
            implied_shares: sizeShares,
            implied_usd: pricePerShare * sizeShares,
          });
          totalForExchange++;
        }
      }
    }
    console.log(`[backfill] ${ex.tag}: ${totalForExchange} fills (scanned ${chunksScanned} chunks · ${chunksWithFills} non-empty · ${chunksErrored} errored)`);
    totalFills += totalForExchange;
  }

  // Aggregate stats
  const stats = handleDb.prepare(
    `SELECT COUNT(*) AS n,
            SUM(implied_usd) AS total_usd,
            AVG(implied_usd) AS avg_usd,
            AVG(implied_price) AS avg_price,
            SUM(CAST(fee AS INTEGER)) / 1.0e6 AS total_fee_usd,
            SUM(CASE WHEN side_of_wallet='maker' THEN 1 ELSE 0 END) AS as_maker,
            SUM(CASE WHEN side_of_wallet='taker' THEN 1 ELSE 0 END) AS as_taker,
            SUM(CASE WHEN maker_side='BUY' THEN 1 ELSE 0 END) AS buy_orders,
            SUM(CASE WHEN maker_side='SELL' THEN 1 ELSE 0 END) AS sell_orders
     FROM wallet_fills WHERE wallet = ?`,
  ).get(addr) as any;
  const topTokens = handleDb.prepare(
    `SELECT token_id, COUNT(*) AS n, SUM(implied_usd) AS usd
     FROM wallet_fills WHERE wallet = ? GROUP BY token_id ORDER BY n DESC LIMIT 5`,
  ).all(addr) as Array<{ token_id: string; n: number; usd: number }>;

  console.log(`\n=== Backfill summary for ${addr}${resolved.userName ? ` (@${resolved.userName})` : ""} ===`);
  console.log(`  Fills total:       ${stats.n}`);
  console.log(`  USDC notional:     $${Number(stats.total_usd ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  console.log(`  Avg trade size:    $${Number(stats.avg_usd ?? 0).toFixed(2)}`);
  console.log(`  Avg entry price:   ${Number(stats.avg_price ?? 0).toFixed(3)}`);
  console.log(`  Total fees paid:   $${Number(stats.total_fee_usd ?? 0).toFixed(2)}`);
  console.log(`  As maker / taker:  ${stats.as_maker} / ${stats.as_taker}`);
  console.log(`  Buy / Sell (maker view): ${stats.buy_orders} / ${stats.sell_orders}`);
  console.log(`  Top tokens (by frequency):`);
  for (const t of topTokens) {
    console.log(`    - ${t.token_id.slice(0, 18)}…  n=${t.n}  $${Number(t.usd).toLocaleString()}`);
  }
  console.log(`\nWrote ${totalFills} fills (deduped on (tx_hash, order_hash)).`);
})().catch((err) => { console.error(err); process.exit(1); });
