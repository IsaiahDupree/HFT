/**
 * Bridge runner — shared between the CLI (scripts/bridge-eth-to-polymarket.ts)
 * and the API (src/app/api/polymarket/bridge/route.ts). Encapsulates the
 * complete safe-bridge flow:
 *
 *   1. Read mainnet balance, deduct reserve
 *   2. Enforce safety gates (amount cap, rate limit, env, dry-run flag)
 *   3. Fetch LI.FI quote
 *   4. (LIVE only) sign + broadcast via the user's POLYMARKET_PRIVATE_KEY
 *   5. Wait for mainnet receipt
 *   6. Poll Polygon for USDC.e arrival
 *   7. Audit each phase to evolution_log
 */
import { createPublicClient, createWalletClient, http, formatEther, parseEther } from "viem";
import { mainnet, polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { db } from "@/lib/db/client";
import { insertEvolutionEvent } from "@/lib/db/queries";
import { getLifiQuote, getLifiStatus, maxBridgeableWei, type LifiQuote } from "./lifi-bridge";
import { POLYGON_USDC_E } from "@/lib/polymarket/deposit";

const HIGH_VALUE_CAP_ETH = 0.5;
const RECENT_BRIDGE_WINDOW_MS = 24 * 3600 * 1000;

const BALANCE_OF_ABI = [{
  type: "function" as const,
  name: "balanceOf",
  stateMutability: "view" as const,
  inputs: [{ name: "", type: "address" }],
  outputs: [{ type: "uint256" }],
}];

export type BridgeRunOptions = {
  /** Override the default RESERVE_ETH env (0.005). */
  reserveEth?: number;
  /** Bypass the high-value cap (only the operator should set this). */
  highValueOverride?: boolean;
  /** Bypass the recent-bridge rate limit (only the operator should set this). */
  forceRecent?: boolean;
  /** True = actually sign + broadcast. False = dry-run, just return the plan. */
  live?: boolean;
  /** Log prefix for stdout (helps separate CLI vs API output). */
  logPrefix?: string;
};

export type BridgePlan = {
  account: string;
  native_balance_eth: number;
  reserve_eth: number;
  bridge_eth: number;
  bridge_wei: string;
  quote: LifiQuote;
};

export type BridgeRunResult =
  | { kind: "dry-run"; plan: BridgePlan }
  | { kind: "executed"; plan: BridgePlan; tx_hash: string; delta_usdce: number; elapsed_sec: number }
  | { kind: "submitted-pending"; plan: BridgePlan; tx_hash: string; elapsed_sec: number }
  | { kind: "rejected"; reason: string; code: "no_key" | "malformed_key" | "below_reserve" | "above_cap" | "recent_bridge" | "gas_estimate_failed" | "quote_failed" | "tx_failed"; plan?: BridgePlan };

function logger(prefix?: string) {
  const tag = prefix ? `[${prefix}] ` : "";
  return (msg: string) => console.log(tag + msg);
}

function hasRecentBridge(): { found: boolean; created_at?: string } {
  const row = db().prepare(
    `SELECT created_at FROM evolution_log
       WHERE event_type IN ('bridge-submitted', 'bridge-confirmed')
       ORDER BY id DESC LIMIT 1`,
  ).get() as { created_at: string } | undefined;
  if (!row) return { found: false };
  const ageMs = Date.now() - new Date(row.created_at + "Z").getTime();
  return { found: ageMs <= RECENT_BRIDGE_WINDOW_MS, created_at: row.created_at };
}

/**
 * Run the full bridge flow. Caller controls the live/dry-run flag — env gates
 * (`ALLOW_BRIDGE=1`) are the caller's responsibility (the CLI and the API
 * enforce them differently).
 */
export async function runBridge(opts: BridgeRunOptions = {}): Promise<BridgeRunResult> {
  const log = logger(opts.logPrefix);
  const live = opts.live === true;

  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  if (!pk) return { kind: "rejected", code: "no_key", reason: "POLYMARKET_PRIVATE_KEY missing from .env.local" };
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) return { kind: "rejected", code: "malformed_key", reason: "POLYMARKET_PRIVATE_KEY malformed (expected 0x + 64 hex chars)" };

  const reserveEth = opts.reserveEth ?? Number(process.env.RESERVE_ETH ?? "0.005");
  const reserveWei = parseEther(reserveEth.toString());
  const account = privateKeyToAccount(pk as `0x${string}`);
  const mainnetClient = createPublicClient({ chain: mainnet, transport: http(process.env.ETH_RPC_URL) });
  const polygonClient = createPublicClient({ chain: polygon, transport: http(process.env.POLYGON_RPC_URL) });

  const nativeWei = await mainnetClient.getBalance({ address: account.address });
  const nativeEth = Number(formatEther(nativeWei));
  log(`Mainnet balance ${account.address}: ${nativeEth.toFixed(6)} ETH (reserve ${reserveEth} ETH)`);

  if (nativeEth < reserveEth * 2) {
    return {
      kind: "rejected", code: "below_reserve",
      reason: `balance ${nativeEth.toFixed(6)} ETH below 2× reserve (${reserveEth * 2} ETH)`,
    };
  }
  const bridgeWei = maxBridgeableWei(nativeWei, reserveWei);
  const bridgeEth = Number(formatEther(bridgeWei));

  if (bridgeEth > HIGH_VALUE_CAP_ETH && !opts.highValueOverride) {
    return {
      kind: "rejected", code: "above_cap",
      reason: `amount ${bridgeEth.toFixed(4)} ETH > high-value cap ${HIGH_VALUE_CAP_ETH} ETH; require highValueOverride`,
    };
  }

  const recent = hasRecentBridge();
  if (recent.found && !opts.forceRecent) {
    return {
      kind: "rejected", code: "recent_bridge",
      reason: `last bridge at ${recent.created_at} (within 24h); require forceRecent`,
    };
  }

  let quote: LifiQuote;
  try {
    quote = await getLifiQuote({
      fromAddress: account.address,
      fromAmount: bridgeWei.toString(),
      fromChain: 1, toChain: 137,
      fromToken: "ETH", toToken: POLYGON_USDC_E,
      slippage: 0.005,
    });
  } catch (e) {
    return { kind: "rejected", code: "quote_failed", reason: (e as Error).message };
  }

  const plan: BridgePlan = {
    account: account.address,
    native_balance_eth: nativeEth,
    reserve_eth: reserveEth,
    bridge_eth: bridgeEth,
    bridge_wei: bridgeWei.toString(),
    quote,
  };

  const expectedUsdcE = Number(quote.toAmount) / 1e6;
  log(`Bridge ${bridgeEth.toFixed(6)} ETH → ${expectedUsdcE.toFixed(2)} USDC.e via ${quote.toolName} (${quote.executionDurationSec}s ETA)`);

  if (!live) {
    insertEvolutionEvent({
      event_type: "bridge-dry-run",
      summary: `DRY: ${bridgeEth.toFixed(6)} ETH → ${expectedUsdcE.toFixed(2)} USDC.e via ${quote.toolName}`,
      payload_json: JSON.stringify({ plan }),
    });
    return { kind: "dry-run", plan };
  }

  // LIVE — sign, broadcast, poll.
  const wallet = createWalletClient({ chain: mainnet, transport: http(process.env.ETH_RPC_URL), account });
  let gasLimit: bigint;
  try {
    gasLimit = await mainnetClient.estimateGas({
      account, to: quote.tx.to, data: quote.tx.data, value: BigInt(quote.tx.value),
    });
  } catch (e) {
    insertEvolutionEvent({
      event_type: "bridge-rejected",
      summary: `Bridge gas estimate failed: ${(e as Error).message.slice(0, 100)}`,
      payload_json: JSON.stringify({ plan, error: (e as Error).message }),
    });
    return { kind: "rejected", code: "gas_estimate_failed", reason: (e as Error).message, plan };
  }

  const hash = await wallet.sendTransaction({
    to: quote.tx.to, data: quote.tx.data, value: BigInt(quote.tx.value),
    gas: (gasLimit * 12n) / 10n,
  });
  log(`Submitted: ${hash}`);
  insertEvolutionEvent({
    event_type: "bridge-submitted",
    summary: `Bridge submitted ${hash.slice(0, 10)}…: ${bridgeEth.toFixed(6)} ETH → ~${expectedUsdcE.toFixed(2)} USDC.e via ${quote.toolName}`,
    payload_json: JSON.stringify({ hash, plan }),
  });

  const receipt = await mainnetClient.waitForTransactionReceipt({ hash });
  log(`Mainnet receipt: block ${receipt.blockNumber}, status ${receipt.status}`);
  if (receipt.status !== "success") {
    insertEvolutionEvent({
      event_type: "bridge-rejected",
      summary: `Bridge mainnet tx reverted: ${hash.slice(0, 10)}…`,
      payload_json: JSON.stringify({ hash, plan, receipt: { block: receipt.blockNumber.toString(), status: receipt.status } }),
    });
    return { kind: "rejected", code: "tx_failed", reason: `mainnet tx ${hash} reverted`, plan };
  }

  // Poll Polygon for arrival.
  const startUsdcE = await polygonClient.readContract({
    address: POLYGON_USDC_E as `0x${string}`,
    abi: BALANCE_OF_ABI, functionName: "balanceOf", args: [account.address],
  }) as bigint;
  const maxWaitMs = 15 * 60 * 1000;
  const pollMs = 15_000;
  const t0 = Date.now();
  while (Date.now() - t0 < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    const current = await polygonClient.readContract({
      address: POLYGON_USDC_E as `0x${string}`,
      abi: BALANCE_OF_ABI, functionName: "balanceOf", args: [account.address],
    }) as bigint;
    if (current > startUsdcE) {
      const delta = Number(current - startUsdcE) / 1e6;
      const elapsed = Math.round((Date.now() - t0) / 1000);
      log(`USDC.e arrived: +${delta.toFixed(2)} (${elapsed}s)`);
      insertEvolutionEvent({
        event_type: "bridge-confirmed",
        summary: `Bridge confirmed: +${delta.toFixed(2)} USDC.e on Polygon (mainnet tx ${hash.slice(0, 10)}…)`,
        payload_json: JSON.stringify({ hash, plan, delta_usdce: delta, elapsed_sec: elapsed }),
      });
      return { kind: "executed", plan, tx_hash: hash, delta_usdce: delta, elapsed_sec: elapsed };
    }
    const status = await getLifiStatus(hash, 1, 137, quote.tool).catch(() => ({ status: "PENDING" as const }));
    log(`…${Math.round((Date.now() - t0) / 1000)}s · LI.FI=${status.status}`);
    if (status.status === "FAILED") {
      insertEvolutionEvent({
        event_type: "bridge-rejected",
        summary: `Bridge LI.FI status=FAILED for ${hash.slice(0, 10)}…`,
        payload_json: JSON.stringify({ hash, plan }),
      });
      return { kind: "rejected", code: "tx_failed", reason: `LI.FI status=FAILED for ${hash}`, plan };
    }
  }
  return { kind: "submitted-pending", plan, tx_hash: hash, elapsed_sec: Math.round((Date.now() - t0) / 1000) };
}
