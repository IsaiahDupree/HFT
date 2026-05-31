/**
 * Chainlink latestRoundData reader (PRD-04 #1) via viem — uses the SAME authed
 * Polygon RPC the onchain layer already relies on (POLYGON_HTTP_URL /
 * POLYGON_RPC_URL), so it works here where public-RPC reads from the 2dollar-bot
 * 401'd. Returns the settlement price + last-update timestamp for the update-age
 * risk filter; null on any failure (never fabricates).
 */
import { createPublicClient, http } from "viem";
import { polygon } from "viem/chains";

// Chainlink aggregator addresses on Polygon mainnet.
export const POLYGON_FEEDS: Record<string, `0x${string}`> = {
  BTC: "0xc907E116054Ad103354f2D350FD2514433D57F6f",
  ETH: "0xF9680D99D6C9589e2a93a78A04A279e509205945",
  SOL: "0x10C8264C0935b3B9870013e057f330Ff3e9C56dC",
  MATIC: "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0",
};

const CHAINLINK_DECIMALS = 8;

const AGGREGATOR_ABI = [
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

function rpcUrl(): string {
  return process.env.POLYGON_HTTP_URL ?? process.env.POLYGON_RPC_URL ?? "https://polygon-bor-rpc.publicnode.com";
}

export type ChainlinkRound = { price: number; updatedAt: number; roundId: bigint };

/** Read a feed's latest round. Returns null on unknown asset / RPC failure. */
export async function chainlinkLatestRound(asset: string): Promise<ChainlinkRound | null> {
  const addr = POLYGON_FEEDS[asset.toUpperCase()];
  if (!addr) return null;
  try {
    const client = createPublicClient({ chain: polygon, transport: http(rpcUrl()) });
    const r = (await client.readContract({
      address: addr,
      abi: AGGREGATOR_ABI,
      functionName: "latestRoundData",
    })) as readonly [bigint, bigint, bigint, bigint, bigint];
    return {
      roundId: r[0],
      price: Number(r[1]) / 10 ** CHAINLINK_DECIMALS,
      updatedAt: Number(r[3]),
    };
  } catch {
    return null;
  }
}
