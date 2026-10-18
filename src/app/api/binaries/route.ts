/**
 * Binaries API — backs /binaries dashboard.
 *
 * GET /api/binaries?section=active   → upcoming binaries with countdown
 * GET /api/binaries?section=resolved → last N resolutions
 * GET /api/binaries?section=summary  → win-rate + counts by asset
 *
 * Default section=all returns all three so the page can do one fetch.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";

export const dynamic = "force-dynamic";

type ActiveRow = {
  token_id: string;
  asset: string;
  duration_kind: string;
  expiry_iso: string;
  question: string;
  midpoint: number | null;
  midpoint_captured_at: string | null;
  agent_positions: number;
};

type ResolvedRow = {
  token_id: string;
  asset: string;
  duration_kind: string;
  expiry_iso: string;
  reference_price: number | null;
  outcome_yes: number | null;
  resolved_at: string;
};

function loadActive(limit: number): ActiveRow[] {
  return db().prepare(`
    SELECT
      b.token_id,
      b.asset,
      b.duration_kind,
      b.expiry_iso,
      b.question,
      (
        SELECT midpoint FROM market_snapshots
         WHERE token_id = b.token_id AND midpoint IS NOT NULL
         ORDER BY captured_at DESC LIMIT 1
      ) AS midpoint,
      (
        SELECT captured_at FROM market_snapshots
         WHERE token_id = b.token_id AND midpoint IS NOT NULL
         ORDER BY captured_at DESC LIMIT 1
      ) AS midpoint_captured_at,
      (
        SELECT COUNT(*) FROM paper_agents
         WHERE alive = 1 AND position_basket_json LIKE '%' || b.token_id || '%'
      ) AS agent_positions
    FROM poly_binaries b
    WHERE b.settled = 0 AND b.expiry_iso > datetime('now')
    ORDER BY b.expiry_iso ASC
    LIMIT ?
  `).all(limit) as ActiveRow[];
}

function loadResolved(limit: number): ResolvedRow[] {
  return db().prepare(`
    SELECT token_id, asset, duration_kind, expiry_iso, reference_price, outcome_yes, resolved_at
    FROM poly_binaries
    WHERE settled = 1 AND resolved_at IS NOT NULL
    ORDER BY resolved_at DESC
    LIMIT ?
  `).all(limit) as ResolvedRow[];
}

function loadSummary() {
  const byAsset = db().prepare(`
    SELECT
      asset,
      COUNT(*) AS total,
      SUM(CASE WHEN settled = 1 AND outcome_yes IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
      SUM(CASE WHEN outcome_yes = 1 THEN 1 ELSE 0 END) AS yes_wins,
      SUM(CASE WHEN outcome_yes = 0 THEN 1 ELSE 0 END) AS no_wins,
      SUM(CASE WHEN settled = 0 AND expiry_iso > datetime('now') THEN 1 ELSE 0 END) AS active
    FROM poly_binaries
    GROUP BY asset
    ORDER BY asset
  `).all() as Array<{
    asset: string; total: number; resolved: number;
    yes_wins: number; no_wins: number; active: number;
  }>;
  const overall = db().prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN settled = 1 AND outcome_yes IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
      SUM(CASE WHEN settled = 0 AND expiry_iso > datetime('now') THEN 1 ELSE 0 END) AS active
    FROM poly_binaries
  `).get() as { total: number; resolved: number; active: number };
  return { overall, by_asset: byAsset };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const section = url.searchParams.get("section") ?? "all";
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);

  if (section === "active")   return NextResponse.json({ active: loadActive(limit) });
  if (section === "resolved") return NextResponse.json({ resolved: loadResolved(limit) });
  if (section === "summary")  return NextResponse.json({ summary: loadSummary() });

  // section=all
  return NextResponse.json({
    active: loadActive(limit),
    resolved: loadResolved(limit),
    summary: loadSummary(),
    fetched_at: new Date().toISOString(),
  });
}
