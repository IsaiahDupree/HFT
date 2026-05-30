/**
 * Synthetic test data. No real wallets, no real keys.
 */
import type { OrderBookSummary, MarketPair } from "@/lib/polymarket/arb";
import type { OnChainFill } from "@/lib/polymarket/onchain";

export const FAKE_TOKEN_YES = "1111111111111111111111111111111111111111111111111111111111111111";
export const FAKE_TOKEN_NO = "2222222222222222222222222222222222222222222222222222222222222222";
export const FAKE_CONDITION = "0x3333333333333333333333333333333333333333333333333333333333333333";
export const FAKE_ADDRESS = "0x4444444444444444444444444444444444444444";

export function book(asks: Array<[number, number]>, bids: Array<[number, number]> = []): OrderBookSummary {
  return {
    market: FAKE_CONDITION,
    asset_id: FAKE_TOKEN_YES,
    asks: asks.map(([p, s]) => ({ price: String(p), size: String(s) })),
    bids: bids.map(([p, s]) => ({ price: String(p), size: String(s) })),
  };
}

export const samplePair: MarketPair = {
  conditionId: FAKE_CONDITION,
  question: "Will the test pass?",
  yesTokenId: FAKE_TOKEN_YES,
  noTokenId: FAKE_TOKEN_NO,
};

export function fill(over: Partial<OnChainFill> = {}): OnChainFill {
  return {
    exchange: "ctf",
    txHash: "0xdeadbeef",
    blockNumber: 100,
    orderHash: "0x0",
    maker: FAKE_ADDRESS,
    taker: FAKE_ADDRESS,
    side: "BUY",
    tokenId: FAKE_TOKEN_YES,
    makerAmountFilled: "1000000",   // 1 USDC
    takerAmountFilled: "2000000",   // 2 shares
    fee: "0",
    builder: "0x0",
    receivedAt: 1700000000000,
    ...over,
  };
}

export function syntheticSeries(opts: { len: number; start: number; slope: number; noise?: number }) {
  const { len, start, slope, noise = 0 } = opts;
  return Array.from({ length: len }, (_, i) => ({
    t: 1700000000 + i * 60,
    p: start + slope * i + (noise ? (Math.sin(i * 1.7) * noise) : 0),
  }));
}
