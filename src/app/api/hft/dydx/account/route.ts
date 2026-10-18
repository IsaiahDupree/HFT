import { NextResponse } from "next/server";
import { loadWallet, makeIndexerClient } from "@/lib/hft/dydx";
import type { DydxNet } from "@/lib/hft/dydx";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const net = ((url.searchParams.get("net") as DydxNet) ?? "testnet") as DydxNet;
  const subaccountNumber = Number(url.searchParams.get("subaccount") ?? "0");

  try {
    const { address } = await loadWallet(net, subaccountNumber);
    const indexer = makeIndexerClient(net);
    const [sub, positions, orders, fills] = await Promise.all([
      indexer.account.getSubaccount(address, subaccountNumber),
      indexer.account.getSubaccountPerpetualPositions(address, subaccountNumber, "OPEN" as any),
      indexer.account.getSubaccountOrders(address, subaccountNumber),
      indexer.account.getSubaccountFills(address, subaccountNumber),
    ]);

    const orderArr = Array.isArray(orders) ? orders : ((orders as any)?.orders ?? []);
    const fillArr = (fills as any)?.fills ?? [];

    return NextResponse.json({
      net,
      address,
      subaccountNumber,
      equity: Number((sub as any)?.subaccount?.equity ?? "0"),
      freeCollateral: Number((sub as any)?.subaccount?.freeCollateral ?? "0"),
      positions: ((positions as any)?.positions ?? []).map((p: any) => ({
        market: p.market, side: p.side, size: Number(p.size), entryPrice: Number(p.entryPrice),
        unrealizedPnl: Number(p.unrealizedPnl ?? 0), realizedPnl: Number(p.realizedPnl ?? 0),
      })),
      orders: orderArr.map((o: any) => ({
        id: o.id, clientId: Number(o.clientId), ticker: o.ticker, side: o.side, type: o.type,
        price: Number(o.price), size: Number(o.size), status: o.status, timeInForce: o.timeInForce,
        postOnly: !!o.postOnly, reduceOnly: !!o.reduceOnly, createdAt: o.createdAtHeight,
      })),
      fills: fillArr.slice(0, 50).map((f: any) => ({
        market: f.market, side: f.side, price: Number(f.price), size: Number(f.size),
        fee: Number(f.fee ?? 0), liquidity: f.liquidity, createdAt: f.createdAt,
      })),
      when: Date.now(),
    });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    const code = /Missing mnemonic/i.test(msg) ? 400 : 502;
    return NextResponse.json({ error: msg }, { status: code });
  }
}
