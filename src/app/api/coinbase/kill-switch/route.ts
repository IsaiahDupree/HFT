import { NextResponse } from "next/server";
import { killSwitch } from "@/lib/coinbase/execute";

export const dynamic = "force-dynamic";

/**
 * POST /api/coinbase/kill-switch
 * Cancel every currently-OPEN order. Always allowed; ignores COINBASE_ALLOW_TRADE.
 */
export async function POST() {
  const result = await killSwitch();
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
