import { NextResponse } from "next/server";
import { getDefaultRouter } from "@/lib/venue/router";
import { verifyChain } from "@/lib/venue/order-events";

export const dynamic = "force-dynamic";

/** GET /api/venue/health — per-adapter health + order-event chain status */
export async function GET() {
  const router = getDefaultRouter();
  const [adapters] = await Promise.all([router.health()]);
  return NextResponse.json({
    adapters,
    risk_engine: {
      halted: router.riskEngine.isHalted(),
      halt_reason: router.riskEngine.getHaltReason(),
    },
    order_event_chain: verifyChain(),
  });
}
