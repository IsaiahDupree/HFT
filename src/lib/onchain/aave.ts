/**
 * Aave V3 health-factor reader for Polygon.
 *
 * Pure wrapper around the Aave V3 Pool contract's getUserAccountData function.
 * Returns USD-denominated collateral/debt + a normalized healthFactor + a
 * risk tier. No DB, no HTTP layer beyond viem — caller supplies the client,
 * so tests can stub readContract.
 *
 * Aave V3 returns:
 *   - totalCollateralBase / totalDebtBase / availableBorrowsBase in BASE units
 *     (1e8 USD per Aave's price oracle).
 *   - currentLiquidationThreshold + ltv in bps (basis points; 8000 = 80%).
 *   - healthFactor in WAD (1e18). max-uint256 sentinel = "no debt" → Infinity.
 *
 * Risk tiers (HF):
 *   ≥ 2.0      healthy
 *   1.5 – 2.0  cautious
 *   1.1 – 1.5  risky
 *   1.0 – 1.1  pre_liquidation
 *   < 1.0      liquidatable RIGHT NOW
 *   (no debt + no collateral) no_position
 *
 * Used by /onchain/aave (tracked-wallet risk dashboard) and
 * /onchain/leverage/[address] (personal-leverage advisor).
 */
import { createPublicClient, http, type PublicClient } from "viem";
import { polygon } from "viem/chains";

export const AAVE_V3_POOL_POLYGON = "0x794a61358D6845594F94dc1DB02A252b5b4814aD" as const;

const POOL_ABI = [
  {
    inputs: [{ name: "user", type: "address" }],
    name: "getUserAccountData",
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export type AaveRiskTier =
  | "healthy"
  | "cautious"
  | "risky"
  | "pre_liquidation"
  | "liquidatable"
  | "no_position";

export type AaveAccountData = {
  wallet: string;
  totalCollateralUsd: number;
  totalDebtUsd: number;
  availableBorrowsUsd: number;
  /** In bps (e.g., 8000 = 80%). */
  currentLiquidationThresholdBps: number;
  /** In bps (e.g., 7500 = 75%). */
  ltvBps: number;
  /** Health factor as a decimal (1.5 = 1.5). Infinity when there is no debt. */
  healthFactor: number;
  riskTier: AaveRiskTier;
};

/** Aave returns max-uint256 for HF when there is no debt. */
export const HF_INFINITY_SENTINEL = (BigInt(2) ** BigInt(256)) - BigInt(1);
const WAD = 1_000_000_000_000_000_000n;
const BASE_UNIT = 100_000_000n;

export function wadToFloat(w: bigint): number {
  if (w === HF_INFINITY_SENTINEL) return Infinity;
  const whole = Number(w / WAD);
  const frac = Number(w % WAD) / 1e18;
  return whole + frac;
}

/** BASE units = 1e8 USD per Aave's price oracle. */
export function baseUnitToUsd(b: bigint): number {
  const whole = Number(b / BASE_UNIT);
  const frac = Number(b % BASE_UNIT) / 1e8;
  return whole + frac;
}

export function riskTierFor(hf: number, hasPosition: boolean): AaveRiskTier {
  if (!hasPosition) return "no_position";
  if (!Number.isFinite(hf)) return "healthy"; // no debt
  if (hf >= 2.0) return "healthy";
  if (hf >= 1.5) return "cautious";
  if (hf >= 1.1) return "risky";
  if (hf >= 1.0) return "pre_liquidation";
  return "liquidatable";
}

export function defaultAavePolygonClient(rpcUrl?: string): PublicClient {
  const url =
    rpcUrl ??
    process.env.POLYGON_HTTP_URL ??
    process.env.POLYGON_RPC_URL ??
    "https://polygon-bor-rpc.publicnode.com";
  return createPublicClient({ chain: polygon, transport: http(url) });
}

/**
 * Read a wallet's Aave V3 account data. Caller supplies the client so tests
 * can stub `readContract` without touching the network.
 */
export async function getAaveAccountData(
  client: Pick<PublicClient, "readContract">,
  wallet: `0x${string}`,
): Promise<AaveAccountData> {
  const result = (await client.readContract({
    address: AAVE_V3_POOL_POLYGON,
    abi: POOL_ABI,
    functionName: "getUserAccountData",
    args: [wallet],
  })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint];

  const [
    totalCollateralBase,
    totalDebtBase,
    availableBorrowsBase,
    currentLiquidationThreshold,
    ltv,
    healthFactor,
  ] = result;

  const totalCollateralUsd = baseUnitToUsd(totalCollateralBase);
  const totalDebtUsd = baseUnitToUsd(totalDebtBase);
  const availableBorrowsUsd = baseUnitToUsd(availableBorrowsBase);
  const hasPosition = totalCollateralUsd > 0 || totalDebtUsd > 0;
  const hf = wadToFloat(healthFactor);

  return {
    wallet,
    totalCollateralUsd,
    totalDebtUsd,
    availableBorrowsUsd,
    currentLiquidationThresholdBps: Number(currentLiquidationThreshold),
    ltvBps: Number(ltv),
    healthFactor: hf,
    riskTier: riskTierFor(hf, hasPosition),
  };
}
