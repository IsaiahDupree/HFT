import { NextResponse } from "next/server";
import { z } from "zod";
import { setVersionStage } from "@/lib/stages/gate";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  versionId: z.number().int().positive(),
  stage: z.enum(["sim", "paper", "live_eligible", "live", "restricted"]),
  force: z.boolean().optional(),
  rationale: z.string().max(500).optional(),
});

/**
 * POST /api/strategies/:id/stage { versionId, stage, force?, rationale? }
 * The `:id` in the route is the strategy id (for parity with existing routes);
 * the body's versionId is what actually moves. Enforces the promotion ladder
 * unless force=true.
 */
export async function POST(req: Request, _ctx: { params: Promise<{ id: string }> }) {
  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, error: parsed.error.flatten() }, { status: 400 });
  const result = setVersionStage(parsed.data.versionId, parsed.data.stage, {
    force: parsed.data.force,
    rationale: parsed.data.rationale,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
