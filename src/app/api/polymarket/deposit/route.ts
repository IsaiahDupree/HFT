/**
 * GET /api/polymarket/deposit?eoa=0x...&amount=20
 *
 * Returns the correct deposit address for the EOA (= itself in EOA-mode,
 * plus any existing Polymarket proxy registered against it) along with
 * EIP-681 URIs ready for QR encoding.
 *
 * Read-only — no DB writes, no trading side-effects.
 */
import { NextResponse } from "next/server";
import {
  resolveDepositAddresses, buildEip681TransferUri, buildAddressOnlyUri,
  readPolygonBalances, readMultiChainBalances,
  uniswapDeepLink, acrossBridgeLink, polygonPortalLink, squidRouterLink,
  POLYGON_USDC_E, POLYGON_USDC_NATIVE, POLYGON_WETH, POLYGON_CHAIN_ID,
} from "@/lib/polymarket/deposit";
import type { MultiChainBalance } from "@/lib/polymarket/deposit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const eoa = url.searchParams.get("eoa") ?? "";
  const amountParam = url.searchParams.get("amount");
  const amount = amountParam ? Number(amountParam) : 0;

  if (!eoa) return NextResponse.json({ error: "missing ?eoa param" }, { status: 400 });

  // Resolve deposit addresses + balances (Polygon + all major EVMs) in parallel.
  const [r, balances, multiChain] = await Promise.all([
    resolveDepositAddresses(eoa),
    readPolygonBalances(eoa),
    readMultiChainBalances(eoa),
  ]);
  if (r.errors.length > 0 && !r.eoa_deposit_addr) {
    return NextResponse.json({ ...r, error: r.errors.join("; ") }, { status: 400 });
  }

  const eoaUris = {
    eip681: buildEip681TransferUri(r.eoa_deposit_addr, amount),
    address_only: buildAddressOnlyUri(r.eoa_deposit_addr),
  };
  const existingUris = r.existing_proxy_addr ? {
    eip681: buildEip681TransferUri(r.existing_proxy_addr, amount),
    address_only: buildAddressOnlyUri(r.existing_proxy_addr),
  } : null;

  // Build swap deep-links + suggestion based on what the user actually has.
  const swap = {
    uniswap: {
      eth_to_usdce: uniswapDeepLink("ETH"),
      matic_to_usdce: uniswapDeepLink("MATIC"),
      weth_to_usdce: uniswapDeepLink("WETH"),
      native_usdc_to_usdce: uniswapDeepLink("USDC_NATIVE"),
    },
    suggestion: multiChainSuggestion(balances, multiChain),
  };

  // Bridge deep-links — only relevant when funds are detected on a non-Polygon chain.
  const offChainFunded = multiChain.find((b) => b.chain !== "polygon" && (b.native > 0 || b.usdc > 0 || b.weth > 0));
  const bridges = offChainFunded ? {
    detected_chain: offChainFunded.chain,
    detected_native_amount: offChainFunded.native,
    detected_usdc_amount: offChainFunded.usdc,
    across: acrossBridgeLink(offChainFunded.chain as "ethereum" | "base" | "arbitrum" | "optimism"),
    squid: squidRouterLink(offChainFunded.chain as "ethereum" | "base" | "arbitrum" | "optimism"),
    polygon_portal: polygonPortalLink(),
  } : null;

  return NextResponse.json({
    eoa: r.eoa,
    amount_usdc: amount,
    token: { address: POLYGON_USDC_E, symbol: "USDC.e", decimals: 6, network: "Polygon", chain_id: POLYGON_CHAIN_ID },
    eoa_mode: {
      signature_type: 0,
      label: "Recommended (EOA mode) — deposit to your own wallet",
      address: r.eoa_deposit_addr,
      uris: eoaUris,
    },
    existing_proxy: r.existing_proxy_addr ? {
      signature_type: r.existing_proxy_addr === r.eoa_deposit_addr ? 0 : 1,
      label: r.existing_proxy_addr === r.eoa_deposit_addr
        ? "Pre-existing account (also EOA mode)"
        : "Pre-existing account (separate proxy — Magic.link or Safe)",
      address: r.existing_proxy_addr,
      uris: existingUris,
      profile: r.existing_profile,
    } : null,
    balances,
    multi_chain_balances: multiChain,
    swap,
    bridges,
    tokens: {
      usdc_e: POLYGON_USDC_E,
      usdc_native: POLYGON_USDC_NATIVE,
      weth: POLYGON_WETH,
    },
    errors: r.errors,
  });
}

/** Decide what the user should do next based on Polygon + multi-chain balances. */
function multiChainSuggestion(b: { matic: number; weth: number; usdc_e: number; usdc_native: number; error?: string }, mc: MultiChainBalance[]): { state: string; message: string } {
  if (b.error) return { state: "rpc-failed", message: `Couldn't read balances (${b.error}). Try the QR code anyway, or refresh.` };
  if (b.usdc_e >= 5) return { state: "ready", message: `You have ${b.usdc_e.toFixed(2)} USDC.e on Polygon — ready to trade. No swap needed.` };
  if (b.usdc_native >= 5) return { state: "swap-native-usdc", message: `You have ${b.usdc_native.toFixed(2)} native USDC on Polygon. Swap → USDC.e on Uniswap (~0.05% fee, instant).` };
  if (b.weth >= 0.001) return { state: "swap-weth", message: `You have ${b.weth.toFixed(4)} WETH on Polygon. Swap → USDC.e on Uniswap.` };
  if (b.matic >= 0.5) return { state: "swap-matic", message: `You have ${b.matic.toFixed(2)} MATIC on Polygon. Swap a portion → USDC.e (keep ~0.5 for gas).` };

  // Polygon empty — check if funds landed on the WRONG chain.
  const ethereum = mc.find((x) => x.chain === "ethereum");
  const base = mc.find((x) => x.chain === "base");
  if (ethereum && (ethereum.native > 0.001 || ethereum.usdc > 1)) {
    return {
      state: "wrong-chain-ethereum",
      message: `⚠ Funds detected on ETHEREUM MAINNET (${ethereum.native.toFixed(4)} ETH, ${ethereum.usdc.toFixed(2)} USDC) — not Polygon. Bridge to Polygon as USDC.e using Across or Squid (links below).`,
    };
  }
  if (base && (base.native > 0.001 || base.usdc > 1)) {
    return {
      state: "wrong-chain-base",
      message: `⚠ Funds detected on BASE (${base.native.toFixed(4)} ETH, ${base.usdc.toFixed(2)} USDC) — not Polygon. Bridge to Polygon (links below).`,
    };
  }

  return { state: "empty", message: "Wallet is empty on every chain we checked. Send USDC.e on Polygon from Coinbase Base App or your exchange (network selector: Polygon, not Base/Ethereum)." };
}
