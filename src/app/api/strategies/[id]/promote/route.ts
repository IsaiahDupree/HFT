import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { insertEvolutionEvent } from "@/lib/db/queries";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: stratIdRaw } = await params;
  const strategyId = Number(stratIdRaw);
  const body = await req.json().catch(() => ({}));
  const versionId = Number(body.versionId);
  if (!strategyId || !versionId) {
    return NextResponse.json({ error: "strategyId and versionId required" }, { status: 400 });
  }
  const handle = db();
  const target = handle.prepare("SELECT * FROM strategy_versions WHERE id = ? AND strategy_id = ?").get(versionId, strategyId) as any;
  if (!target) return NextResponse.json({ error: "version not found for this strategy" }, { status: 404 });
  const prior = handle.prepare("SELECT * FROM strategy_versions WHERE strategy_id = ? AND is_current = 1").get(strategyId) as any;
  if (prior?.id === target.id) return NextResponse.json({ ok: true, already: true });

  const tx = handle.transaction(() => {
    handle.prepare("UPDATE strategy_versions SET is_current = 0 WHERE strategy_id = ?").run(strategyId);
    handle.prepare("UPDATE strategy_versions SET is_current = 1 WHERE id = ?").run(versionId);
  });
  tx();
  const strat = handle.prepare("SELECT name, agent_id FROM strategies WHERE id = ?").get(strategyId) as any;
  insertEvolutionEvent({
    agent_id: strat?.agent_id,
    strategy_id: strategyId,
    from_version_id: prior?.id,
    to_version_id: target.id,
    event_type: "promotion",
    summary: `Promoted v${target.version} of "${strat?.name}"${prior ? ` (was v${prior.version})` : ""}`,
    payload_json: JSON.stringify({ rationale: target.rationale }),
  });
  return NextResponse.json({ ok: true, promoted: target.id });
}
