/**
 * LI.FI aggregator bridge — ETH on Ethereum mainnet → USDC.e on Polygon.
 *
 * LI.FI returns a fully-formed transaction request (to, data, value) that we
 * just sign and broadcast. No need to construct Across/Celer/Hop calldata
 * ourselves — LI.FI picks the cheapest live route across all of them.
 *
 * Why not Across directly: Across no longer enables the USDC.e output route
 * (they only support ETH → WETH on Polygon now), so we'd need a second swap
 * step. LI.FI handles bridge+swap in one tx via whichever underlying tool
 * is cheapest at the time.
 *
 * Why not Squid: requires an integrator-id auth header. LI.FI's public API
 * is anonymous-friendly which is enough for our scale.
 */

export type LifiQuoteRequest = {
  fromAddress: string;
  fromAmount: string;          // wei (string)
  fromChain: number;
  toChain: number;
  fromToken: string;           // address or symbol (e.g. "ETH")
  toToken: string;             // address
  slippage?: number;           // 0.005 = 0.5%
};

export type LifiQuote = {
  tool: string;                // e.g. "cbridge", "across", "stargate"
  toolName: string;
  fromAmount: string;
  toAmount: string;            // expected output (string of 6-decimal USDC.e units)
  toAmountMin: string;         // minimum output after slippage
  toAmountUsd: number;
  executionDurationSec: number;
  feeCostsUsd: number;
  gasCostsUsd: number;
  tx: {
    to: `0x${string}`;
    data: `0x${string}`;
    value: `0x${string}`;
    chainId: number;
    gasLimit?: string;
    gasPrice?: string;
  };
};

const LIFI_HOST = "https://li.quest/v1";

/**
 * Get a quote + ready-to-sign tx from LI.FI. Throws on API error.
 *
 * The returned `tx` is ready to send via viem's `wallet.sendTransaction(tx)`
 * after attaching `account` + `chain`. Importantly: LI.FI's tx.value already
 * accounts for protocol-side fees — pass it through as-is.
 */
export async function getLifiQuote(req: LifiQuoteRequest): Promise<LifiQuote> {
  const params = new URLSearchParams({
    fromAddress: req.fromAddress,
    fromAmount: req.fromAmount,
    fromChain: String(req.fromChain),
    toChain: String(req.toChain),
    fromToken: req.fromToken,
    toToken: req.toToken,
  });
  if (req.slippage != null) params.set("slippage", String(req.slippage));
  const url = `${LIFI_HOST}/quote?${params}`;

  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`LI.FI /quote → ${r.status}: ${body.slice(0, 300)}`);
  }
  const data = (await r.json()) as {
    tool?: string;
    toolDetails?: { name?: string };
    action?: { fromAmount?: string };
    estimate?: {
      toAmount?: string; toAmountMin?: string; toAmountUSD?: string;
      executionDuration?: number;
      feeCosts?: Array<{ amountUSD?: string }>;
      gasCosts?: Array<{ amountUSD?: string }>;
    };
    transactionRequest?: { to?: string; data?: string; value?: string; chainId?: number; gasLimit?: string; gasPrice?: string };
    message?: string;
  };

  if (data.message && !data.transactionRequest) {
    throw new Error(`LI.FI /quote: ${data.message}`);
  }
  if (!data.transactionRequest?.to || !data.transactionRequest?.data) {
    throw new Error("LI.FI /quote: missing transactionRequest in response");
  }
  const feeUsd = (data.estimate?.feeCosts ?? []).reduce((s, f) => s + Number(f.amountUSD ?? 0), 0);
  const gasUsd = (data.estimate?.gasCosts ?? []).reduce((s, g) => s + Number(g.amountUSD ?? 0), 0);

  return {
    tool: data.tool ?? "unknown",
    toolName: data.toolDetails?.name ?? data.tool ?? "unknown",
    fromAmount: data.action?.fromAmount ?? req.fromAmount,
    toAmount: data.estimate?.toAmount ?? "0",
    toAmountMin: data.estimate?.toAmountMin ?? "0",
    toAmountUsd: Number(data.estimate?.toAmountUSD ?? 0),
    executionDurationSec: data.estimate?.executionDuration ?? 0,
    feeCostsUsd: feeUsd,
    gasCostsUsd: gasUsd,
    tx: {
      to: data.transactionRequest.to as `0x${string}`,
      data: data.transactionRequest.data as `0x${string}`,
      value: (data.transactionRequest.value ?? "0x0") as `0x${string}`,
      chainId: data.transactionRequest.chainId ?? req.fromChain,
      gasLimit: data.transactionRequest.gasLimit,
      gasPrice: data.transactionRequest.gasPrice,
    },
  };
}

/**
 * Status check — LI.FI exposes /status?txHash=... to poll for completion.
 * Returns "DONE" when the destination-chain fill has confirmed, "PENDING"
 * while still in flight, "FAILED" on error.
 */
export type LifiStatus = "DONE" | "PENDING" | "FAILED" | "INVALID" | "NOT_FOUND";

export async function getLifiStatus(txHash: string, fromChain: number, toChain: number, tool?: string): Promise<{ status: LifiStatus; receiving?: { txHash?: string; amount?: string } }> {
  const params = new URLSearchParams({
    txHash,
    fromChain: String(fromChain),
    toChain: String(toChain),
  });
  if (tool) params.set("bridge", tool);
  const r = await fetch(`${LIFI_HOST}/status?${params}`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) return { status: "NOT_FOUND" };
  const data = (await r.json()) as { status?: string; receiving?: { txHash?: string; amount?: string } };
  const s = (data.status ?? "PENDING") as LifiStatus;
  return { status: s, receiving: data.receiving };
}

/**
 * Compute the maximum ETH (in wei) we should bridge given a native balance,
 * leaving `reserveWei` behind for future gas. Returns 0n if the balance is
 * below the reserve floor.
 */
export function maxBridgeableWei(nativeWei: bigint, reserveWei: bigint): bigint {
  return nativeWei > reserveWei ? nativeWei - reserveWei : 0n;
}
