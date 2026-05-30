import { NextResponse } from "next/server";
import { getMarketFreshness } from "@/lib/arena/snapshot";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const stale = Number(url.searchParams.get("stale_seconds") ?? "600");
  const all = getMarketFreshness({ staleSeconds: stale });
  return NextResponse.json({
    stale_seconds_threshold: stale,
    n_markets: all.length,
    n_stale: all.filter((m) => m.is_stale).length,
    markets: all,
  });
}
