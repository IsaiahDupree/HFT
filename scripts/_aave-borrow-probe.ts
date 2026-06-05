/**
 * _aave-borrow-probe — ground-truth: is asset X borrowable on Aave V3 (Ethereum) and at what variable APR?
 * Resolves the PoolDataProvider from the canonical PoolAddressesProvider (robust to redeploys), then reads
 * getReserveConfigurationData (borrowingEnabled) + getReserveData (currentVariableBorrowRate, RAY 1e27).
 * This is the make-or-break input for whether a NEGATIVE-funding perp carry (long perp + SHORT spot) can be
 * hedged KYC-free by borrowing the token on Aave and selling it.
 */
import { createPublicClient, http, getAddress } from "viem";
import { mainnet } from "viem/chains";

const client = createPublicClient({ chain: mainnet, transport: http("https://ethereum-rpc.publicnode.com") });
const ADDRESSES_PROVIDER = "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e"; // Aave V3 Ethereum PoolAddressesProvider

const TOKENS: Record<string, string> = {
  COMP: "0xc00e94Cb662C3520282E6f5717214004A7f26888",
  LINK: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
  UNI: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
  AAVE: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
  MKR: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2",
  CRV: "0xD533a949740bb3306d119CC777fa900bA034cd52",
  SNX: "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F",
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
};

const PROVIDER_ABI = [{ inputs: [{ type: "uint8" }], name: "getAddress", outputs: [{ type: "address" }], stateMutability: "view", type: "function" }] as const;
// id(1) in PoolAddressesProvider maps to the PoolDataProvider in Aave V3 conventions; fall back to known addr.
const DATA_PROVIDER_FALLBACK = "0x41393e5e337606dc3821075Af65AeE84D7688CBD";
const ALL_RESERVES_ABI = [{ inputs: [], name: "getAllReservesTokens", outputs: [{ components: [{ name: "symbol", type: "string" }, { name: "tokenAddress", type: "address" }], type: "tuple[]" }], stateMutability: "view", type: "function" }] as const;
const DP_ABI = [
  { inputs: [{ type: "address" }], name: "getReserveConfigurationData", outputs: [
    { name: "decimals", type: "uint256" }, { name: "ltv", type: "uint256" }, { name: "liquidationThreshold", type: "uint256" },
    { name: "liquidationBonus", type: "uint256" }, { name: "reserveFactor", type: "uint256" }, { name: "usageAsCollateralEnabled", type: "bool" },
    { name: "borrowingEnabled", type: "bool" }, { name: "stableBorrowRateEnabled", type: "bool" }, { name: "isActive", type: "bool" }, { name: "isFrozen", type: "bool" },
  ], stateMutability: "view", type: "function" },
  { inputs: [{ type: "address" }], name: "getReserveData", outputs: [
    { name: "unbacked", type: "uint256" }, { name: "accruedToTreasuryScaled", type: "uint256" }, { name: "totalAToken", type: "uint256" },
    { name: "totalStableDebt", type: "uint256" }, { name: "totalVariableDebt", type: "uint256" }, { name: "liquidityRate", type: "uint256" },
    { name: "variableBorrowRate", type: "uint256" }, { name: "stableBorrowRate", type: "uint256" }, { name: "averageStableBorrowRate", type: "uint256" },
    { name: "liquidityIndex", type: "uint256" }, { name: "variableBorrowIndex", type: "uint256" }, { name: "lastUpdateTimestamp", type: "uint40" },
  ], stateMutability: "view", type: "function" },
] as const;

let dp = DATA_PROVIDER_FALLBACK;
try {
  const a = await client.readContract({ address: getAddress(ADDRESSES_PROVIDER), abi: PROVIDER_ABI, functionName: "getAddress", args: [1] });
  if (a && a !== "0x0000000000000000000000000000000000000000") dp = a as string;
} catch { /* use fallback */ }
console.log(`\nAave V3 (Ethereum) PoolDataProvider: ${dp}\n`);

// Enumerate the FULL reserve list and keep the BORROWABLE (enabled + active + not frozen) set with its APR.
const all = await client.readContract({ address: getAddress(dp), abi: ALL_RESERVES_ABI, functionName: "getAllReservesTokens" }) as Array<{ symbol: string; tokenAddress: string }>;
const borrowable: Array<{ sym: string; apr: number }> = [];
for (const t of all) {
  try {
    const cfg = await client.readContract({ address: getAddress(dp), abi: DP_ABI, functionName: "getReserveConfigurationData", args: [getAddress(t.tokenAddress)] }) as any[];
    if (!(cfg[6] && cfg[8] && !cfg[9])) continue;             // borrowingEnabled && isActive && !isFrozen
    const data = await client.readContract({ address: getAddress(dp), abi: DP_ABI, functionName: "getReserveData", args: [getAddress(t.tokenAddress)] }) as any[];
    borrowable.push({ sym: t.symbol.toUpperCase(), apr: Number(data[6] as bigint) / 1e27 * 100 });
  } catch { /* skip */ }
}
console.log(`Aave V3 has ${all.length} reserves; ${borrowable.length} are BORROWABLE (enabled+active+unfrozen):`);
console.log("  " + borrowable.sort((a, b) => a.apr - b.apr).map((b) => `${b.sym} ${b.apr.toFixed(1)}%`).join(", "));

// Cross-check each borrowable symbol against dYdX perp DURABLE funding → the executable negative-carry set.
const STABLES = new Set(["USDC", "USDT", "DAI", "GHO", "LUSD", "FRAX", "USDE", "PYUSD", "USDS", "CRVUSD", "TUSD", "RLUSD"]);
async function durableFundingApr(coin: string): Promise<{ medApr: number; persistNeg: number; n: number } | null> {
  try {
    const h = await (await fetch(`https://indexer.dydx.trade/v4/historicalFunding/${coin}-USD?limit=168`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15_000) })).json();
    const r = (h.historicalFunding as Array<{ rate: string }>).map((x) => Number(x.rate)).filter(Number.isFinite);
    if (r.length < 48) return null;
    const s = [...r].sort((a, b) => a - b), med = s[Math.floor(s.length / 2)];
    const neg = r.filter((x) => x < 0).length;
    return { medApr: med * 24 * 365 * 100, persistNeg: neg / r.length, n: r.length };
  } catch { return null; }
}
console.log(`\nThe carry needs FAT NEGATIVE durable funding on a BORROWABLE name. Cross-check (non-stables):\n`);
console.log(`  ${"asset".padEnd(8)} ${"borrowAPR".padEnd(10)} ${"perp durable funding".padEnd(22)} carry?`);
let found = 0;
for (const b of borrowable) {
  if (STABLES.has(b.sym)) continue;
  const coin = b.sym.replace(/^W(BTC|ETH)$/, "$1"); // WBTC→BTC, WETH→ETH for the perp ticker
  const f = await durableFundingApr(coin);
  const fund = f ? `${f.medApr >= 0 ? "+" : ""}${f.medApr.toFixed(0)}% (negPersist ${(f.persistNeg * 100).toFixed(0)}%)` : "no dYdX perp";
  // executable negative carry: durable funding ≤ −(borrow+fee+margin); require ≤ −15% to clear a real bar
  const ok = !!f && f.medApr <= -(b.apr + 12) && f.persistNeg >= 0.7;
  if (ok) found++;
  console.log(`  ${b.sym.padEnd(8)} ${`${b.apr.toFixed(2)}%`.padEnd(10)} ${fund.padEnd(22)} ${ok ? "✓ candidate" : "—"}`);
}
console.log(`\n  EXECUTABLE negative-funding carries (borrowable ∩ fat-negative ∩ persistent): ${found}`);
console.log("");
