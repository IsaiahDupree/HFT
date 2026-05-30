/**
 * Polygon-side, on-chain order-fill listener — viem implementation.
 *
 * Subscribes to the OrderFilled event on both Polymarket exchange contracts
 * (regular CTF Exchange + Neg Risk CTF Exchange) via a viem WebSocket
 * transport. We use viem (not ethers v5) because ethers v5's WebSocketProvider
 * crashes on the unsolicited messages some public Polygon RPCs send.
 *
 * Public Polygon RPC by default; override with POLYGON_WS_URL.
 */
import { createPublicClient, webSocket, parseAbiItem, type Log } from "viem";
import { polygon } from "viem/chains";

export const POLYGON_CONTRACTS = {
  ctfExchange: "0xE111180000d2663C0091e4f400237545B87B996B" as const,
  negRiskCtfExchange: "0xe2222d279d744050d28e00520010520000310F59" as const,
  ctf: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as const,
} as const;

// CTF Exchange V2 signature (verified by keccak hash match against on-chain topic[0]
// 0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee).
// v2 swapped (makerAssetId, takerAssetId) for a single tokenId + explicit `side`,
// and added builder + metadata fields.
const ORDER_FILLED_EVENT = parseAbiItem(
  "event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint8 side, uint256 tokenId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee, bytes32 builder, bytes32 metadata)",
);

export type OnChainFill = {
  exchange: "ctf" | "neg-risk";
  txHash: string;
  blockNumber: number;
  orderHash: string;
  maker: string;
  taker: string;
  side: "BUY" | "SELL"; // maker order side; 0=BUY, 1=SELL per the exchange enum
  tokenId: string;       // uint256 outcome token id as decimal string
  makerAmountFilled: string;
  takerAmountFilled: string;
  fee: string;
  builder: string;      // bytes32 builder code (or zero)
  receivedAt: number;   // ms when we observed it
};

export type OnChainSubscribeOpts = {
  onFill: (fill: OnChainFill) => void;
  onStatus?: (status: "connecting" | "open" | "closed" | "error") => void;
  rpcUrl?: string;
  contracts?: ("ctf" | "neg-risk")[];
};

export function subscribeOrderFilled(opts: OnChainSubscribeOpts): () => void {
  const rpc = opts.rpcUrl ?? process.env.POLYGON_WS_URL ?? "wss://polygon-bor-rpc.publicnode.com";
  const which = opts.contracts ?? ["ctf", "neg-risk"];
  const client = createPublicClient({
    chain: polygon,
    transport: webSocket(rpc, {
      reconnect: { attempts: 999, delay: 2_000 },
      keepAlive: { interval: 30_000 },
    }),
  });

  let stopped = false;
  opts.onStatus?.("connecting");
  const unwatchers: Array<() => void> = [];

  for (const tag of which) {
    const address = tag === "ctf" ? POLYGON_CONTRACTS.ctfExchange : POLYGON_CONTRACTS.negRiskCtfExchange;
    const unwatch = client.watchEvent({
      address,
      // viem overloads on `event` vs `events`; the inferred type here picks
      // the empty-event variant (`event: undefined`). Cast keeps the runtime
      // behavior identical while satisfying the chosen overload.
      event: ORDER_FILLED_EVENT as any,
      onLogs: (logs: Log[]) => {
        opts.onStatus?.("open");
        for (const log of logs) {
          const args = (log as any).args ?? {};
          const fill: OnChainFill = {
            exchange: tag,
            txHash: String(log.transactionHash ?? ""),
            blockNumber: Number(log.blockNumber ?? 0),
            orderHash: String(args.orderHash ?? ""),
            maker: String(args.maker ?? ""),
            taker: String(args.taker ?? ""),
            side: Number(args.side ?? 0) === 0 ? "BUY" : "SELL",
            tokenId: String(args.tokenId ?? ""),
            makerAmountFilled: String(args.makerAmountFilled ?? ""),
            takerAmountFilled: String(args.takerAmountFilled ?? ""),
            fee: String(args.fee ?? ""),
            builder: String(args.builder ?? ""),
            receivedAt: Date.now(),
          };
          opts.onFill(fill);
        }
      },
      onError: (err) => {
        opts.onStatus?.("error");
        if (!stopped) console.warn(`[onchain] watch error on ${tag}:`, err.message);
      },
    });
    unwatchers.push(unwatch);
  }

  return () => {
    stopped = true;
    for (const unwatch of unwatchers) try { unwatch(); } catch {}
  };
}

/**
 * v2 semantics: `side` is the MAKER order's side.
 *  - Maker BUY  → maker pays USDC (makerAmount), receives shares (takerAmount). Price = maker/taker.
 *  - Maker SELL → maker pays shares (makerAmount), receives USDC (takerAmount). Price = taker/maker.
 * Both USDC and outcome tokens use 6 decimals on Polymarket.
 */
export function impliedPriceFromFill(fill: OnChainFill): { tokenId: string; pricePerShare: number; sizeShares: number; makerSide: "BUY" | "SELL" } | null {
  const makerAmt = Number(fill.makerAmountFilled);
  const takerAmt = Number(fill.takerAmountFilled);
  if (makerAmt <= 0 || takerAmt <= 0) return null;
  if (fill.side === "BUY") {
    const usdc = makerAmt / 1e6;
    const sh = takerAmt / 1e6;
    return { tokenId: fill.tokenId, pricePerShare: usdc / sh, sizeShares: sh, makerSide: "BUY" };
  }
  // SELL
  const usdc = takerAmt / 1e6;
  const sh = makerAmt / 1e6;
  return { tokenId: fill.tokenId, pricePerShare: usdc / sh, sizeShares: sh, makerSide: "SELL" };
}
