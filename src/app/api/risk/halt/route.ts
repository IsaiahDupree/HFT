import { NextResponse } from "next/server";
import { z } from "zod";
import { getDefaultKillSwitch } from "@/lib/risk/kill-switch";
import { getDefaultRouter } from "@/lib/venue/router";

export const dynamic = "force-dynamic";

const haltSchema = z.object({
  reason: z.string().min(1).max(500),
  mode: z.enum(["pause_new_only", "close_and_pause", "liquidate"]).default("liquidate"),
});

/** GET /api/risk/halt — current halt state */
export async function GET() {
  // Ensure router has registered adapters with the kill switch
  getDefaultRouter();
  const ks = getDefaultKillSwitch();
  return NextResponse.json({
    state: ks.getState(),
    registered_brokers: ks.getRegisteredBrokers(),
    risk_engine: {
      halted: ks.riskEngine.isHalted(),
      halt_reason: ks.riskEngine.getHaltReason(),
      limits: ks.riskEngine.getLimits(),
      last_rejection: ks.riskEngine.getLastRejection(),
    },
  });
}

/** POST /api/risk/halt { reason, mode } — engage kill switch on every venue */
export async function POST(req: Request) {
  // Force adapter registration before halt
  getDefaultRouter();
  const body = await req.json().catch(() => ({}));
  const parsed = haltSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.flatten() }, { status: 400 });
  }
  const ks = getDefaultKillSwitch();
  const result = await ks.haltAll(parsed.data.reason, parsed.data.mode);
  return NextResponse.json(result, { status: result.ok ? 200 : 207 });
}

/** DELETE /api/risk/halt — clear the halt */
export async function DELETE() {
  const ks = getDefaultKillSwitch();
  return NextResponse.json(ks.resume());
}
