import { NextResponse } from "next/server";
import { z } from "zod";
import { createCapsule, listCapsules } from "@/lib/capsules/store";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(1).max(100),
  agentId: z.number().int().positive().optional(),
  strategyId: z.number().int().positive().optional(),
  capitalUsd: z.number().positive(),
  allowedVenues: z.array(z.enum(["polymarket", "coinbase", "sim", "paper"])).min(1),
  allowedSymbols: z.array(z.string()).optional(),
  maxDailyLossUsd: z.number().nonnegative().optional(),
  maxTotalDrawdownUsd: z.number().nonnegative().optional(),
  maxPositionPct: z.number().min(0).max(1).optional(),
  maxOpenPositions: z.number().int().nonnegative().optional(),
  maxTradesPerDay: z.number().int().nonnegative().optional(),
  minSecondsBetweenTrades: z.number().nonnegative().optional(),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? undefined;
  const agentParam = url.searchParams.get("agent_id");
  const agentId = agentParam ? Number(agentParam) : undefined;
  return NextResponse.json({
    capsules: listCapsules({
      status: status as any,
      agentId: Number.isFinite(agentId) ? agentId : undefined,
    }),
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.flatten() }, { status: 400 });
  }
  const capsule = createCapsule(parsed.data);
  return NextResponse.json({ ok: true, capsule }, { status: 201 });
}
