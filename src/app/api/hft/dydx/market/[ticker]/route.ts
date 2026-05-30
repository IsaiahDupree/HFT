import { NextResponse } from "next/server";
import { makeIndexerClient } from "@/lib/hft/dydx";
import type { DydxNet } from "@/lib/hft/dydx";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = { params: Promise<{ ticker: string }> };

export async function GET(req: Request, { params }: Params) {
  const { ticker } = await params;
  const url = new URL(req.url);
  const net = ((url.searchParams.get("net") as DydxNet) ?? "testnet") as DydxNet;
  const candleResolution = url.searchParams.get("candles") ?? "1MIN";
  const candleLimit = Math.min(Number(url.searchParams.get("limit") ?? "60"), 200);
  const indexer = makeIndexerClient(net);

  try {
    const [m, ob, trades, candles] = await Promise.all([
      indexer.markets.getPerpetualMarkets(ticker),
      indexer.markets.getPerpetualMarketOrderbook(ticker),
      indexer.markets.getPerpetualMarketTrades(ticker, undefined, undefined, 30),
      indexer.markets.getPerpetualMarketCandles(ticker, candleResolution, undefined, undefined, candleLimit),
    ]);

    const market = (m as any)?.markets?.[ticker] ?? null;
    return NextResponse.json(
      {
        net,
        ticker,
        market: market
          ? {
              oraclePrice: Number(market.oraclePrice),
              indexPrice: market.indexPrice ? Number(market.indexPrice) : null,
              priceChange24H: Number(market.priceChange24H ?? 0),
              volume24H: Number(market.volume24H ?? 0),
              openInterest: Number(market.openInterest ?? 0),
              nextFundingRate: Number(market.nextFundingRate ?? 0),
              tickSize: Number(market.tickSize),
              stepSize: Number(market.stepSize),
              status: market.status,
            }
          : null,
        orderbook: {
          bids: ((ob as any)?.bids ?? []).slice(0, 25).map((b: any) => ({ price: Number(b.price), size: Number(b.size) })),
          asks: ((ob as any)?.asks ?? []).slice(0, 25).map((a: any) => ({ price: Number(a.price), size: Number(a.size) })),
        },
        trades: ((trades as any)?.trades ?? []).slice(0, 30).map((t: any) => ({
          side: t.side, price: Number(t.price), size: Number(t.size), createdAt: t.createdAt,
        })),
        candles: ((candles as any)?.candles ?? []).map((c: any) => ({
          startedAt: c.startedAt,
          open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close),
          baseTokenVolume: Number(c.baseTokenVolume ?? 0),
        })),
        when: Date.now(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
