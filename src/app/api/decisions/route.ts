/**
 * JSON endpoint for the decision journal. Backs the /decisions UI's
 * auto-refresh + manual export.
 *
 *   GET /api/decisions
 *   GET /api/decisions?decision=REJECTED&strategy=midwindow-trajectory&capsule=0edfced5&limit=100
 *   GET /api/decisions?format=csv   (returns text/csv)
 */
import { NextResponse } from "next/server";
import { readRecentDecisions } from "@/lib/decision/journal";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const decision = url.searchParams.get("decision") ?? undefined;
  const strategy = url.searchParams.get("strategy") ?? undefined;
  const capsule = url.searchParams.get("capsule") ?? undefined;
  const limit = Math.min(Math.max(10, Number(url.searchParams.get("limit")) || 50), 500);
  const format = url.searchParams.get("format") ?? "json";

  const rows = readRecentDecisions({
    limit,
    decision: decision ?? undefined,
    strategyKind: strategy ?? undefined,
    capsuleId: capsule ?? undefined,
  });

  if (format === "csv") {
    const header = [
      "id", "ts", "agent_id", "capsule_id", "strategy_kind",
      "venue", "symbol", "side",
      "proposed_size_usd", "approved_size_usd", "proposed_price",
      "decision", "approval_score", "size_multiplier", "order_id",
    ];
    const body = rows.map((r) =>
      [
        r.id, r.ts, r.agent_id ?? "", r.capsule_id ?? "", r.strategy_kind,
        r.venue, r.symbol, r.side,
        r.proposed_size_usd, r.approved_size_usd, r.proposed_price,
        r.decision, r.approval_score, r.size_multiplier, r.order_id ?? "",
      ]
        .map((v) => {
          const s = String(v);
          // Quote any value containing comma / quote / newline.
          return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(","),
    );
    const csv = [header.join(","), ...body].join("\n");
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="decisions-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  return NextResponse.json({
    count: rows.length,
    filters: { decision, strategy, capsule, limit },
    rows,
  });
}
