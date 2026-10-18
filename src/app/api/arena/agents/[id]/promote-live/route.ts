/**
 * POST /api/arena/agents/[id]/promote-live
 *
 * Creates a live capsule bound to a paper agent. Mirrors the same validation
 * + side-effects as scripts/promote-to-live.ts (the script and the UI button
 * both call into shared validation via inline checks).
 *
 * Request body (JSON):
 *   { capitalUsd?: number; maxTradeUsd?: number; maxDailyLossUsd?: number;
 *     maxTotalDdUsd?: number; maxOpenPositions?: number; maxTradesPerDay?: number;
 *     allowedVenues?: string[] }
 *
 * Responses:
 *   200 { capsule_id, status } on success
 *   400 { error } on validation failure
 *
 * IMPORTANT: This endpoint is gated by the Next.js middleware mutating-routes
 * lock (POST + non-localhost). When ALLOW_TRADE is unset, the capsule is still
 * created — but the live router will DRY_RUN every order.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { getPaperAgent } from "@/lib/arena/db";
import { createCapsule, getCapsule, setStatus } from "@/lib/capsules/store";
import { insertEvolutionEvent } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const agentId = Number(id);
  if (!Number.isFinite(agentId)) {
    return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  }

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* allow empty body */ }
  const capitalUsd       = Number(body.capitalUsd ?? 50);
  const maxTradeUsd      = Number(body.maxTradeUsd ?? 5);
  const maxDailyLossUsd  = Number(body.maxDailyLossUsd ?? 10);
  const maxTotalDdUsd    = Number(body.maxTotalDdUsd ?? 25);
  const maxOpenPositions = Number(body.maxOpenPositions ?? 3);
  const maxTradesPerDay  = Number(body.maxTradesPerDay ?? 20);
  const allowedVenues    = Array.isArray(body.allowedVenues) && body.allowedVenues.length > 0
    ? (body.allowedVenues as string[])
    : ["polymarket"];

  const agent = getPaperAgent(agentId);
  if (!agent)         return NextResponse.json({ error: `agent ${agentId} not found` }, { status: 400 });
  if (!agent.alive)   return NextResponse.json({ error: `agent ${agent.name} is retired` }, { status: 400 });
  if (agent.entries_count === 0) {
    return NextResponse.json({ error: `agent ${agent.name} has never traded (entries=0)` }, { status: 400 });
  }
  const existing = db().prepare(
    `SELECT id, status FROM capsules WHERE paper_agent_id = ? AND status IN ('paper','live')`,
  ).get(agentId) as { id: string; status: string } | undefined;
  if (existing) {
    return NextResponse.json({
      error: `agent already has a ${existing.status} capsule`,
      capsule_id: existing.id,
    }, { status: 400 });
  }

  const capsule = createCapsule({
    name: `live-${agent.name}`,
    capitalUsd,
    allowedVenues,
    maxDailyLossUsd,
    maxTotalDrawdownUsd: maxTotalDdUsd,
    maxOpenPositions,
    maxTradesPerDay,
  });
  db().prepare(`UPDATE capsules SET paper_agent_id = ? WHERE id = ?`).run(agentId, capsule.id);
  setStatus(capsule.id, "live");

  insertEvolutionEvent({
    event_type: "capsule-live-promoted",
    summary: `agent ${agent.name} (${agentId}) promoted to live capsule ${capsule.id.slice(0, 8)} with $${capitalUsd} capital`,
    payload_json: JSON.stringify({
      agent_id: agentId, capsule_id: capsule.id, source: "api",
      capitalUsd, maxTradeUsd, maxDailyLossUsd, maxTotalDdUsd, maxOpenPositions, maxTradesPerDay, allowedVenues,
    }),
  });

  const final = getCapsule(capsule.id);
  return NextResponse.json({
    capsule_id: capsule.id,
    status: final?.status,
    capital_available_usd: final?.capital_available_usd,
    allow_trade_set: process.env.ALLOW_TRADE === "1",
    note: process.env.ALLOW_TRADE === "1"
      ? "ALLOW_TRADE=1 — live orders will fire on next tick."
      : "ALLOW_TRADE is not set — orders will DRY_RUN.",
  });
}
