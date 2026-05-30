import { NextResponse } from "next/server";
import { z } from "zod";
import { cb } from "@/lib/coinbase/client";
import { executeCoinbaseMarket } from "@/lib/coinbase/execute";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const statusParams = url.searchParams.getAll("status");
  const limit = Number(url.searchParams.get("limit") ?? "25");
  try {
    const data = await cb.listOrders({
      order_status: statusParams.length > 0 ? statusParams : undefined,
      limit,
    });
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

const MarketOrderBody = z.object({
  productId: z.string().min(3),
  side: z.enum(["BUY", "SELL"]),
  size: z.string().regex(/^\d+(\.\d+)?$/),
  note: z.string().max(200).optional(),
  agentId: z.number().int().optional(),
  strategyId: z.number().int().optional(),
});

/**
 * POST /api/coinbase/orders
 * Submits a single market order through executeCoinbaseMarket().
 * Honors COINBASE_ALLOW_TRADE + per-trade + per-day caps. Always responds with
 * the verdict (dry-run / executed / rejected) and an audit-log id.
 */
export async function POST(req: Request) {
  let parsed: z.infer<typeof MarketOrderBody>;
  try {
    parsed = MarketOrderBody.parse(await req.json());
  } catch (err) {
    return NextResponse.json({ error: "invalid body", details: (err as Error).message }, { status: 400 });
  }
  const verdict = await executeCoinbaseMarket(parsed);
  const status = verdict.kind === "executed" ? 200 : verdict.kind === "dry-run" ? 202 : 422;
  return NextResponse.json(verdict, { status });
}
