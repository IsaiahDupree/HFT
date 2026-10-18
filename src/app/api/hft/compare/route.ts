import { NextResponse } from "next/server";
import { z } from "zod";
import { rankStrategies, rankPolyBtcStrategies } from "@/lib/hft/strategies";
import { VENUES, roundTripFeeBps } from "@/lib/hft/venues";
import { computeEdge } from "@/lib/hft/edge";

export const dynamic = "force-dynamic";

const Body = z.object({
  notionalUsd: z.number().positive().max(10_000_000).default(2500),
  edgeMultiplier: z.number().min(0).max(10).default(1),
  polyNotionalUsd: z.number().positive().max(10_000_000).default(500),
  polyFillsMultiplier: z.number().nonnegative().max(100).default(1),
  /** Optional per-venue override: rank only one strategy spec across every venue. */
  override: z
    .object({
      expectedEdgeBps: z.number(),
      side: z.enum(["maker", "taker"]).default("maker"),
      spreadBps: z.number().default(4),
      slippageBps: z.number().default(1),
      latencyPenaltyBps: z.number().default(1),
      adverseSelectionBps: z.number().default(2),
      fillsPerDay: z.number().default(200),
      fillRate: z.number().min(0).max(1).default(0.4),
    })
    .partial()
    .optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const parsed = Body.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", details: parsed.error.format() }, { status: 400 });
  }
  const { notionalUsd, edgeMultiplier, polyNotionalUsd, polyFillsMultiplier, override } = parsed.data;

  const hft = rankStrategies(notionalUsd, edgeMultiplier);
  const poly = rankPolyBtcStrategies(polyNotionalUsd, polyFillsMultiplier);

  // Optional uniform-spec ranking across every venue, for sanity checks.
  const uniform = override
    ? VENUES.map((v) => {
        const res = computeEdge(v, {
          notionalUsd,
          expectedEdgeBps: override.expectedEdgeBps ?? 8,
          side: override.side ?? "maker",
          spreadBps: override.spreadBps,
          slippageBps: override.slippageBps,
          latencyPenaltyBps: override.latencyPenaltyBps,
          adverseSelectionBps: override.adverseSelectionBps,
          fillsPerDay: override.fillsPerDay,
          fillRate: override.fillRate,
        });
        return {
          venueId: v.id,
          venueName: v.name,
          feeBps: roundTripFeeBps(v, override.side ?? "maker"),
          ...res,
        };
      }).sort((a, b) => b.expectedDailyUsd - a.expectedDailyUsd)
    : null;

  return NextResponse.json({
    inputs: parsed.data,
    hft: hft.map((r) => ({
      strategyId: r.strategy.id,
      strategyName: r.strategy.name,
      venueId: r.venue.id,
      venueName: r.venue.name,
      ...r.result,
    })),
    polymarketBtc: poly.map((r) => ({
      strategyId: r.id,
      name: r.name,
      horizon: r.horizon,
      thesis: r.thesis,
      ...r.result,
    })),
    uniform,
  });
}

export async function GET() {
  return NextResponse.json({
    hft: rankStrategies(2500, 1).map((r) => ({
      strategyId: r.strategy.id,
      strategyName: r.strategy.name,
      venueId: r.venue.id,
      venueName: r.venue.name,
      ...r.result,
    })),
    polymarketBtc: rankPolyBtcStrategies(500, 1).map((r) => ({
      strategyId: r.id,
      name: r.name,
      horizon: r.horizon,
      ...r.result,
    })),
  });
}
