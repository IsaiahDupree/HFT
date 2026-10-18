import { NextResponse } from "next/server";
import { z } from "zod";
import { getDefaultRouter } from "@/lib/venue/router";

export const dynamic = "force-dynamic";

const submitSchema = z.object({
  clientOrderId: z.string().min(1).max(128),
  venue: z.string().min(1).max(64),
  symbol: z.string().min(1).max(128),
  side: z.enum(["BUY", "SELL"]),
  type: z.enum(["MARKET", "LIMIT", "FOK_BASKET"]),
  size: z.number().positive(),
  refPrice: z.number().positive(),
  limitPrice: z.number().positive().optional(),
  capsuleId: z.string().uuid().optional(),
  agentId: z.number().int().positive().optional(),
  strategyId: z.number().int().positive().optional(),
  strategyVersionId: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * POST /api/venue/submit — submit through the unified router.
 * The router enforces halt + capsule + risk + adapter gates. Per-venue safety
 * envs (ALLOW_TRADE / COINBASE_ALLOW_TRADE) ALSO still apply inside each adapter.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const parsed = submitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.flatten() }, { status: 400 });
  }
  const router = getDefaultRouter();
  const verdict = await router.submit(parsed.data);
  return NextResponse.json(verdict, { status: verdict.ok ? 200 : 400 });
}
