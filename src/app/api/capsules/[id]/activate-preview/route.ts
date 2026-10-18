import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { getCapsule } from "@/lib/capsules/store";
import { getPaperAgent } from "@/lib/arena/db";
import { parseGenome } from "@/lib/arena/genome";
import { computeReplayFitness } from "@/lib/arena/replay-fitness";

export const dynamic = "force-dynamic";

/**
 * GET /api/capsules/[id]/activate-preview?window_days=14
 *
 * Runs the SAME backtest the activation gate uses, returns the verdict +
 * numbers. Read-only: no DB writes, no status changes. Use to inspect
 * whether activation would succeed before clicking the live button.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const windowDays = Number(url.searchParams.get("window_days") ?? process.env.ARENA_ACTIVATE_WINDOW_DAYS ?? "14");
  const minPnlPct = Number(process.env.ARENA_ACTIVATE_MIN_PNL_PCT ?? "-0.02");
  const maxDdPct = Number(process.env.ARENA_ACTIVATE_MAX_DD_PCT ?? "0.25");

  const cap = getCapsule(id);
  if (!cap) return NextResponse.json({ error: "capsule not found" }, { status: 404 });

  const binding = db().prepare(`SELECT paper_agent_id FROM capsules WHERE id = ?`).get(id) as { paper_agent_id: number | null } | undefined;
  if (!binding?.paper_agent_id) {
    return NextResponse.json({ verdict: "no-binding", reason: "capsule has no bound paper_agent — gate would be skipped", capsule: cap });
  }
  const agent = getPaperAgent(binding.paper_agent_id);
  if (!agent) return NextResponse.json({ error: "bound paper_agent not found" }, { status: 404 });

  try {
    const genome = parseGenome(agent.genome_json);
    const startIso = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    const endIso = new Date().toISOString();
    const bt = computeReplayFitness(genome, { startIso, endIso });
    const wouldPassPnl = bt.pnl_pct >= minPnlPct;
    const wouldPassDd = bt.max_dd_pct <= maxDdPct;
    const verdict = (wouldPassPnl && wouldPassDd) ? "would-pass" : "would-fail";
    return NextResponse.json({
      verdict,
      backtest: bt,
      thresholds: { min_pnl_pct: minPnlPct, max_dd_pct: maxDdPct, window_days: windowDays },
      checks: { pnl_ok: wouldPassPnl, dd_ok: wouldPassDd },
      bound_paper_agent: { id: agent.id, name: agent.name, genome_kind: genome.kind, generation: agent.generation },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
