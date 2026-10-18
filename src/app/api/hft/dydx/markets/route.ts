import { NextResponse } from "next/server";
import { makeIndexerClient } from "@/lib/hft/dydx";
import type { DydxNet } from "@/lib/hft/dydx";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const net = ((url.searchParams.get("net") as DydxNet) ?? "testnet") as DydxNet;
  const indexer = makeIndexerClient(net);
  try {
    const raw = await indexer.markets.getPerpetualMarkets();
    const markets = Object.entries((raw as any).markets ?? {}).map(([ticker, m]: [string, any]) => ({
      ticker,
      status: m.status,
      oraclePrice: Number(m.oraclePrice),
      indexPrice: m.indexPrice ? Number(m.indexPrice) : null,
      priceChange24H: Number(m.priceChange24H ?? 0),
      volume24H: Number(m.volume24H ?? 0),
      openInterest: Number(m.openInterest ?? 0),
      nextFundingRate: Number(m.nextFundingRate ?? 0),
      tickSize: Number(m.tickSize),
      stepSize: Number(m.stepSize),
      initialMarginFraction: Number(m.initialMarginFraction ?? 0),
      maintenanceMarginFraction: Number(m.maintenanceMarginFraction ?? 0),
    }));
    return NextResponse.json(
      { net, markets, when: Date.now() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
