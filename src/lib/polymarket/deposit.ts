/**
 * Polymarket deposit-address resolver.
 *
 * Returns the correct address to send USDC.e to, given the user's EOA.
 *
 *   - **EOA mode (SIGNATURE_TYPE=0)** — the default. Deposit address = the EOA
 *     itself. The signer holds USDC.e + position tokens directly. This is
 *     what we recommend for new bot-only accounts: no separate proxy
 *     contract, no relayer dependency, the address you scan in your Base
 *     App is your own wallet.
 *
 *   - **Pre-existing proxy** — if the EOA has already used polymarket.com,
 *     the Gamma public-profile endpoint returns the actual proxy address.
 *     We surface it as a secondary option in case the user signed up before
 *     (e.g. via VPN) and want to keep using that existing account.
 *
 * The relayer-v2 /relay-payload endpoint we originally tried is NOT
 * deterministic — it returns a fresh session address per call — so it
 * cannot be used to predict a deterministic deposit address. We do not
 * call it any more.
 */

export type DepositResolution = {
  /** Lower-cased EOA we looked up. */
  eoa: string;
  /** The recommended deposit recipient for SIGNATURE_TYPE=0 — = the EOA. */
  eoa_deposit_addr: string;
  /** If the EOA already has a Polymarket account (proxy in the Gamma DB),
   *  this is set. Different from eoa_deposit_addr means they used the
   *  Magic.link / Safe model in the past. */
  existing_proxy_addr: string | null;
  /** Display info from Gamma if registered. */
  existing_profile: {
    created_at?: string;
    pseudonym?: string;
    name?: string;
  } | null;
  errors: string[];
};

/** Polygon USDC.e (bridged) — what Polymarket recognizes for funding. */
export const POLYGON_USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
/** Polygon native USDC — issued by Circle; NOT what Polymarket wants. */
export const POLYGON_USDC_NATIVE = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
/** Polygon WETH — wrapped ETH on Polygon, used for swaps. Native MATIC is at the chain level. */
export const POLYGON_WETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
export const POLYGON_CHAIN_ID = 137;

const GAMMA_HOST = process.env.POLYMARKET_GAMMA_HOST ?? "https://gamma-api.polymarket.com";

type GammaProfile = {
  createdAt?: string;
  proxyWallet?: string;
  pseudonym?: string;
  name?: string;
};

async function lookupGammaProfile(eoa: string): Promise<GammaProfile | null> {
  try {
    // Route through Webshare proxy when configured — gamma-api is geo-restricted.
    const { polyFetch } = await import("./proxy-routing");
    const r = await polyFetch(`${GAMMA_HOST}/public-profile?address=${eoa}`, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return null;  // 404 = not registered
    return (await r.json()) as GammaProfile;
  } catch {
    return null;
  }
}

export async function resolveDepositAddresses(eoa: string): Promise<DepositResolution> {
  const norm = eoa.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(norm)) {
    return {
      eoa: norm,
      eoa_deposit_addr: norm,
      existing_proxy_addr: null,
      existing_profile: null,
      errors: [`malformed address: expected 0x + 40 hex chars, got '${eoa}'`],
    };
  }
  const profile = await lookupGammaProfile(norm);
  const existing_proxy_addr = profile?.proxyWallet ? profile.proxyWallet.toLowerCase() : null;
  return {
    eoa: norm,
    eoa_deposit_addr: norm,        // SIGNATURE_TYPE=0 mode: deposit to the EOA itself
    existing_proxy_addr,
    existing_profile: profile ? { created_at: profile.createdAt, pseudonym: profile.pseudonym, name: profile.name } : null,
    errors: [],
  };
}

/**
 * Build an EIP-681 token-transfer URI for USDC.e on Polygon. Wallets that
 * scan this QR code pre-fill the recipient + token contract + chain + amount.
 *
 * Format reference: https://eips.ethereum.org/EIPS/eip-681
 *   ethereum:<token>@<chainId>/transfer?address=<recipient>&uint256=<amount>
 *
 * `amountUsdc` is in human-readable USDC (e.g. 20 = $20). Pass 0 to leave
 * the amount blank so the user enters it in the wallet — many wallets handle
 * "amount=0" by skipping the prefill and showing the keypad.
 */
export function buildEip681TransferUri(recipient: string, amountUsdc: number): string {
  const recipientLower = recipient.toLowerCase();
  const baseUnits = Math.floor(Math.max(0, amountUsdc) * 1_000_000); // USDC has 6 decimals
  let uri = `ethereum:${POLYGON_USDC_E}@${POLYGON_CHAIN_ID}/transfer?address=${recipientLower}`;
  if (baseUnits > 0) uri += `&uint256=${baseUnits}`;
  return uri;
}

/** Fallback URI that just encodes the recipient address. Wallets that don't
 *  parse EIP-681 (or that only support BIP-21 style) at least get the address
 *  pre-filled — the user picks USDC + Polygon manually. */
export function buildAddressOnlyUri(recipient: string): string {
  return `ethereum:${recipient.toLowerCase()}@${POLYGON_CHAIN_ID}`;
}

/**
 * Read MATIC + USDC.e + native-USDC + WETH balances on Polygon for an
 * address. Lets the deposit page surface "you have $X native USDC but $0
 * USDC.e — swap before depositing" guidance.
 *
 * Pure read; uses our existing public RPC client. Returns NaN values on RPC
 * failure rather than throwing — UI should render dashes in that case.
 */
export type WalletBalances = {
  address: string;
  matic: number;           // native MATIC, 18 decimals
  weth: number;            // WETH (ERC-20), 18 decimals
  usdc_e: number;          // bridged USDC.e (Polymarket-recognized), 6 decimals
  usdc_native: number;     // Circle's native USDC on Polygon, 6 decimals
  error?: string;
};

// ERC-20 balanceOf ABI snippet (minimal — we only need the one call).
const ERC20_BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

/** Multi-chain balance read. Helps detect when the user sent funds to the
 *  wrong network (very common — they used Ethereum mainnet by mistake when
 *  Polymarket needs Polygon). */
export type MultiChainBalance = {
  chain: "ethereum" | "polygon" | "base" | "arbitrum" | "optimism";
  chain_id: number;
  native_symbol: string;
  native: number;       // 18 decimals
  usdc: number;         // 6 decimals (native USDC contract per chain)
  weth: number;         // 18 decimals (WETH contract per chain)
  /** Polygon-only: bridged USDC.e (what Polymarket needs). */
  usdc_e?: number;
  error?: string;
};

const NATIVE_USDC_BY_CHAIN: Record<string, string> = {
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  polygon:  "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  base:     "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
};
const WETH_BY_CHAIN: Record<string, string> = {
  ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  polygon:  POLYGON_WETH,
  base:     "0x4200000000000000000000000000000000000006",
  arbitrum: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  optimism: "0x4200000000000000000000000000000000000006",
};
const RPC_BY_CHAIN: Record<string, { id: number; rpc: string; native: string }> = {
  ethereum: { id: 1,     rpc: process.env.ETH_RPC_URL      ?? "https://ethereum.publicnode.com",          native: "ETH" },
  polygon:  { id: 137,   rpc: process.env.POLYGON_RPC_URL  ?? "https://polygon-bor-rpc.publicnode.com",   native: "MATIC" },
  base:     { id: 8453,  rpc: process.env.BASE_RPC_URL     ?? "https://base.publicnode.com",              native: "ETH" },
  arbitrum: { id: 42161, rpc: process.env.ARBITRUM_RPC_URL ?? "https://arbitrum.publicnode.com",          native: "ETH" },
  optimism: { id: 10,    rpc: process.env.OPTIMISM_RPC_URL ?? "https://optimism.publicnode.com",          native: "ETH" },
};

/** Minimal raw JSON-RPC call so we can reach any chain without a viem chain
 *  config per network. The fetch is concurrent across chains so the call
 *  takes O(slowest_chain) rather than the sum of them. */
async function rawEthCall(rpc: string, to: string, data: string): Promise<bigint> {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) throw new Error(`rpc ${rpc} → ${r.status}`);
  const j = (await r.json()) as { result?: string };
  return BigInt(j.result ?? "0x0");
}
async function rawEthBalance(rpc: string, address: string): Promise<bigint> {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) throw new Error(`rpc ${rpc} → ${r.status}`);
  const j = (await r.json()) as { result?: string };
  return BigInt(j.result ?? "0x0");
}

const BALANCE_OF_SELECTOR = "0x70a08231";

export async function readMultiChainBalances(address: string): Promise<MultiChainBalance[]> {
  const lower = address.toLowerCase();
  const dataField = BALANCE_OF_SELECTOR + lower.replace("0x", "").padStart(64, "0");

  const chains: Array<MultiChainBalance["chain"]> = ["ethereum", "polygon", "base", "arbitrum", "optimism"];
  const results = await Promise.all(chains.map(async (chain): Promise<MultiChainBalance> => {
    const cfg = RPC_BY_CHAIN[chain];
    try {
      const [native, usdc, weth, usdcE] = await Promise.all([
        rawEthBalance(cfg.rpc, lower),
        rawEthCall(cfg.rpc, NATIVE_USDC_BY_CHAIN[chain], dataField),
        rawEthCall(cfg.rpc, WETH_BY_CHAIN[chain], dataField),
        chain === "polygon"
          ? rawEthCall(cfg.rpc, POLYGON_USDC_E, dataField).catch(() => 0n)
          : Promise.resolve(undefined),
      ]);
      const base: MultiChainBalance = {
        chain, chain_id: cfg.id, native_symbol: cfg.native,
        native: Number(native) / 1e18,
        usdc: Number(usdc) / 1e6,
        weth: Number(weth) / 1e18,
      };
      if (usdcE !== undefined) base.usdc_e = Number(usdcE) / 1e6;
      return base;
    } catch (e) {
      return {
        chain, chain_id: cfg.id, native_symbol: cfg.native,
        native: NaN, usdc: NaN, weth: NaN, error: (e as Error).message,
      };
    }
  }));
  return results;
}

/** Read the four key balances on Polygon. Dynamic-import viem so this module
 *  stays cheap to require when only the address-resolution code path runs. */
export async function readPolygonBalances(address: string): Promise<WalletBalances> {
  const lower = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(lower)) {
    return { address: lower, matic: NaN, weth: NaN, usdc_e: NaN, usdc_native: NaN, error: "malformed address" };
  }
  try {
    const { defaultPolygonRpcClient } = await import("@/lib/onchain/bridges");
    const client = defaultPolygonRpcClient();
    const addr = lower as `0x${string}`;
    const [maticWei, usdcEUnits, usdcNativeUnits, wethWei] = await Promise.all([
      client.getBalance({ address: addr }),
      client.readContract({
        address: POLYGON_USDC_E as `0x${string}`,
        abi: ERC20_BALANCE_OF_ABI, functionName: "balanceOf", args: [addr],
      }) as Promise<bigint>,
      client.readContract({
        address: POLYGON_USDC_NATIVE as `0x${string}`,
        abi: ERC20_BALANCE_OF_ABI, functionName: "balanceOf", args: [addr],
      }) as Promise<bigint>,
      client.readContract({
        address: POLYGON_WETH as `0x${string}`,
        abi: ERC20_BALANCE_OF_ABI, functionName: "balanceOf", args: [addr],
      }) as Promise<bigint>,
    ]);
    return {
      address: lower,
      matic: Number(maticWei) / 1e18,
      weth: Number(wethWei) / 1e18,
      usdc_e: Number(usdcEUnits) / 1e6,
      usdc_native: Number(usdcNativeUnits) / 1e6,
    };
  } catch (e) {
    return { address: lower, matic: NaN, weth: NaN, usdc_e: NaN, usdc_native: NaN, error: (e as Error).message };
  }
}

/**
 * Uniswap deep-link helpers. Pre-fills the input/output tokens + Polygon
 * chain in the Uniswap web app so users don't have to manually pick them.
 *
 * Format reference: app.uniswap.org accepts `inputCurrency`, `outputCurrency`,
 * `chain=polygon` query params. Native ETH/MATIC is passed as the symbol
 * (ETH/MATIC); ERC-20s via their contract address.
 */
export type SwapTarget = "USDC_E";   // we only need to land at USDC.e

export function uniswapDeepLink(
  from: "ETH" | "MATIC" | "USDC_NATIVE" | "WETH",
  to: SwapTarget = "USDC_E",
): string {
  const inMap: Record<typeof from, string> = {
    ETH: "ETH",
    MATIC: "MATIC",
    USDC_NATIVE: POLYGON_USDC_NATIVE,
    WETH: POLYGON_WETH,
  };
  const outAddr = to === "USDC_E" ? POLYGON_USDC_E : POLYGON_USDC_E;
  return `https://app.uniswap.org/swap?inputCurrency=${encodeURIComponent(inMap[from])}&outputCurrency=${outAddr}&chain=polygon`;
}

/**
 * Bridge deep-link helpers. When the user's funds are on the wrong chain
 * (most common: ETH on Ethereum mainnet but Polymarket needs Polygon), we
 * offer pre-filled bridge UIs they can complete in one click.
 *
 *   - Across: fast (~minutes), low fees, supports ETH → USDC across chains
 *   - Polygon official PoS bridge: slower (~30 min) but most trusted
 *   - Squid Router: aggregator with bridge+swap
 */
export type BridgeFrom = "ethereum" | "base" | "arbitrum" | "optimism";

export function acrossBridgeLink(from: BridgeFrom): string {
  // Across uses `from` and `to` chain names + the output token address.
  const fromMap: Record<BridgeFrom, string> = {
    ethereum: "1", base: "8453", arbitrum: "42161", optimism: "10",
  };
  return `https://app.across.to/bridge?inputAmount=&fromChain=${fromMap[from]}&toChain=137&outputToken=${POLYGON_USDC_E}&inputToken=0x0000000000000000000000000000000000000000`;
}

export function polygonPortalLink(): string {
  return `https://portal.polygon.technology/bridge`;
}

export function squidRouterLink(from: BridgeFrom): string {
  const fromMap: Record<BridgeFrom, string> = {
    ethereum: "1", base: "8453", arbitrum: "42161", optimism: "10",
  };
  return `https://app.squidrouter.com/?chains=${fromMap[from]},137&tokens=0x0000000000000000000000000000000000000000,${POLYGON_USDC_E}`;
}
