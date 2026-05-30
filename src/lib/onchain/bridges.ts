/**
 * Polygon-side USDC.e flow reader.
 *
 * USDC.e (bridged USDC, 6 decimals) is the primary collateral on Polymarket.
 * Tracking large inflows TO and outflows FROM a wallet is the cleanest
 * signal of whether the wallet is funded for a big bet — and large outflows
 * back to a CEX deposit address are the signal that they're cashing out.
 *
 * Polygon-only (uses existing POLYGON_HTTP_URL / POLYGON_RPC_URL); no
 * Ethereum mainnet RPC required. The Polygon-side native bridge mint
 * (RootChainManager on L1 → ChildToken on Polygon) is visible from the
 * receiving wallet's perspective as a regular USDC.e Transfer where
 * `from = address(0)`.
 *
 * Pure wrapper around viem; caller supplies the client so tests can stub.
 */
import { createPublicClient, getAddress, http, parseAbiItem, type PublicClient } from "viem";
import { polygon } from "viem/chains";

export const USDC_E_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;
const USDC_DECIMALS = 6n;
const USDC_WEI = 10n ** USDC_DECIMALS;

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

export type UsdcFlow = {
  wallet: string;
  direction: "in" | "out";
  /** Counterparty (sender for "in", recipient for "out"). zero address = bridge mint/burn. */
  counterparty: string;
  amountUsd: number;
  blockNumber: number;
  txHash: string;
  /** True when counterparty is the zero address — i.e. a bridge mint (in) or burn (out). */
  isBridgeEvent: boolean;
};

export function defaultPolygonRpcClient(rpcUrl?: string): PublicClient {
  const url =
    rpcUrl ??
    process.env.POLYGON_HTTP_URL ??
    process.env.POLYGON_RPC_URL ??
    "https://polygon-bor-rpc.publicnode.com";
  return createPublicClient({ chain: polygon, transport: http(url) });
}

export function usdcUnitsToUsd(units: bigint): number {
  const whole = Number(units / USDC_WEI);
  const frac = Number(units % USDC_WEI) / Number(USDC_WEI);
  return whole + frac;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Read recent USDC.e inflows + outflows for a wallet over the last N blocks.
 * Polygon block time ~2sec; 1800 blocks ≈ 1 hour, 10800 blocks ≈ 6 hours.
 *
 * `minAmountUsd` filters small dust transfers — set to e.g. 10_000 for
 * "whale-only" watching.
 */
export async function readUsdcFlowsForWallet(
  client: Pick<PublicClient, "getBlockNumber" | "getLogs">,
  wallet: `0x${string}`,
  opts: { lookbackBlocks?: number; minAmountUsd?: number } = {},
): Promise<UsdcFlow[]> {
  const lookback = BigInt(opts.lookbackBlocks ?? 1800);
  const minAmount = opts.minAmountUsd ?? 0;
  const latest = await client.getBlockNumber();
  const fromBlock = latest > lookback ? latest - lookback : 0n;

  const [inLogs, outLogs] = await Promise.all([
    client.getLogs({
      address: USDC_E_POLYGON,
      event: TRANSFER_EVENT,
      args: { to: getAddress(wallet) },
      fromBlock,
      toBlock: latest,
    } as any),
    client.getLogs({
      address: USDC_E_POLYGON,
      event: TRANSFER_EVENT,
      args: { from: getAddress(wallet) },
      fromBlock,
      toBlock: latest,
    } as any),
  ]);

  function logToFlow(log: any, direction: "in" | "out"): UsdcFlow {
    const value = log.args.value as bigint;
    const counterparty = direction === "in" ? (log.args.from as string) : (log.args.to as string);
    return {
      wallet,
      direction,
      counterparty,
      amountUsd: usdcUnitsToUsd(value),
      blockNumber: Number(log.blockNumber),
      txHash: log.transactionHash,
      isBridgeEvent: counterparty.toLowerCase() === ZERO_ADDRESS,
    };
  }

  const flows: UsdcFlow[] = [
    ...(inLogs as any[]).map((log) => logToFlow(log, "in")),
    ...(outLogs as any[]).map((log) => logToFlow(log, "out")),
  ];
  return flows
    .filter((f) => f.amountUsd >= minAmount)
    .sort((a, b) => b.blockNumber - a.blockNumber);
}

/** Summarize a flow array: net flow, gross in, gross out, bridge in/out. */
export function summarizeFlows(flows: UsdcFlow[]): {
  netUsd: number;
  grossInUsd: number;
  grossOutUsd: number;
  bridgeInUsd: number;
  bridgeOutUsd: number;
  txCount: number;
} {
  let grossIn = 0;
  let grossOut = 0;
  let bridgeIn = 0;
  let bridgeOut = 0;
  for (const f of flows) {
    if (f.direction === "in") {
      grossIn += f.amountUsd;
      if (f.isBridgeEvent) bridgeIn += f.amountUsd;
    } else {
      grossOut += f.amountUsd;
      if (f.isBridgeEvent) bridgeOut += f.amountUsd;
    }
  }
  return {
    netUsd: grossIn - grossOut,
    grossInUsd: grossIn,
    grossOutUsd: grossOut,
    bridgeInUsd: bridgeIn,
    bridgeOutUsd: bridgeOut,
    txCount: flows.length,
  };
}
