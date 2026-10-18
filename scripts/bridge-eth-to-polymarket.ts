/**
 * Bridge ETH from Ethereum mainnet → USDC.e on Polygon, via LI.FI.
 *
 * Reads `POLYMARKET_PRIVATE_KEY` from .env.local, looks at the mainnet ETH
 * balance, leaves `RESERVE_ETH` behind for future gas, bridges the rest,
 * polls Polygon for the USDC.e arrival, and records to evolution_log.
 *
 * Usage:
 *   npx tsx scripts/bridge-eth-to-polymarket.ts            # DRY_RUN by default
 *   ALLOW_BRIDGE=1 npx tsx scripts/bridge-eth-to-polymarket.ts --confirm   # actually sign + send
 *
 * Safety gates (all enforced):
 *   - ALLOW_BRIDGE != "1" → DRY_RUN (prints the tx, doesn't submit)
 *   - --confirm must also be present even with ALLOW_BRIDGE=1 (double opt-in)
 *   - Amount > 0.5 ETH refuses unless --high-value flag is passed
 *   - Last successful bridge within 24h refuses unless --force flag is passed
 */
import "./_env.ts";
import { runBridge } from "../src/lib/onchain/bridge-runner.ts";

const argv = process.argv.slice(2);
const confirmed   = argv.includes("--confirm");
const highValue   = argv.includes("--high-value");
const forceRecent = argv.includes("--force");

(async () => {
  const live = process.env.ALLOW_BRIDGE === "1" && confirmed;
  if (!live) {
    console.log("[DRY_RUN] ALLOW_BRIDGE != 1 or --confirm missing. To go live:");
    console.log("  ALLOW_BRIDGE=1 npx tsx scripts/bridge-eth-to-polymarket.ts --confirm\n");
  }

  const result = await runBridge({
    live,
    highValueOverride: highValue,
    forceRecent,
    logPrefix: "bridge",
  });

  if (result.kind === "rejected") {
    console.error(`\nREJECTED [${result.code}]: ${result.reason}`);
    process.exit(1);
  }
  if (result.kind === "dry-run") {
    console.log("\n=== DRY_RUN plan ===");
    console.log(JSON.stringify({
      bridge_eth: result.plan.bridge_eth,
      expected_usdce: Number(result.plan.quote.toAmount) / 1e6,
      tool: result.plan.quote.toolName,
      eta_sec: result.plan.quote.executionDurationSec,
      fees_usd: result.plan.quote.feeCostsUsd,
      gas_usd: result.plan.quote.gasCostsUsd,
    }, null, 2));
    process.exit(0);
  }
  if (result.kind === "executed") {
    console.log(`\n✓ Bridge complete in ${result.elapsed_sec}s.`);
    console.log(`  +${result.delta_usdce.toFixed(2)} USDC.e on Polygon (tx ${result.tx_hash}).`);
    console.log(`  Refresh /deposit to see the new balance.`);
    process.exit(0);
  }
  // submitted-pending
  console.warn(`\nSubmitted but no Polygon arrival within ${result.elapsed_sec}s — still pending.`);
  console.warn(`  Mainnet tx: ${result.tx_hash}`);
  console.warn(`  Check Polygon manually in a few minutes.`);
  process.exit(2);
})();
