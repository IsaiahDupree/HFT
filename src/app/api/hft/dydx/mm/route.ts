import { NextResponse } from "next/server";
import { z } from "zod";
import { getEngine, listEngines, startEngine, stopEngine } from "@/lib/hft/dydx/engine-registry";
import type { DydxNet, MmConfig } from "@/lib/hft/dydx";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ConfigSchema = z.object({
  halfSpreadBps: z.number().min(1).max(500).default(15),
  perSideUsd: z.number().min(1).max(10000).default(25),
  maxInventoryUsd: z.number().min(0).max(100000).default(100),
  driftBps: z.number().min(1).max(500).default(5),
  skewBpsPerDollar: z.number().min(0).max(10).default(0.1),
  useMicroprice: z.boolean().optional(),
  obiToxicityThreshold: z.number().min(0).max(1).optional(),
  obiToxicityMaxMultiplier: z.number().min(1).max(10).optional(),
  spreadAnomalyBps: z.number().min(0).max(10000).optional(),
});

const StartBody = z.object({
  action: z.literal("start"),
  net: z.enum(["testnet", "mainnet"]).default("testnet"),
  market: z.string().min(3).default("ETH-USD"),
  tickMs: z.number().int().min(1000).max(60000).default(6000),
  goodTilSec: z.number().int().min(15).max(86400).default(120),
  cfg: ConfigSchema.default({} as MmConfig),
});

const StopBody = z.object({
  action: z.literal("stop"),
  net: z.enum(["testnet", "mainnet"]).default("testnet"),
  market: z.string().min(3).default("ETH-USD"),
  reason: z.string().optional(),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const net = ((url.searchParams.get("net") as DydxNet) ?? "testnet") as DydxNet;
  const market = url.searchParams.get("market");
  if (market) {
    const engine = getEngine(net, market);
    if (!engine) return NextResponse.json({ running: false, net, market });
    return NextResponse.json(engine.getStatus());
  }
  return NextResponse.json({ engines: listEngines() });
}

export async function POST(req: Request) {
  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }

  const action = (body as any)?.action;
  if (action === "start") {
    const parsed = StartBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid body", details: parsed.error.format() }, { status: 400 });
    }
    try {
      const engine = await startEngine({
        net: parsed.data.net, market: parsed.data.market, cfg: parsed.data.cfg,
        tickMs: parsed.data.tickMs, goodTilSec: parsed.data.goodTilSec,
      });
      return NextResponse.json(engine.getStatus());
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 502 });
    }
  }

  if (action === "stop") {
    const parsed = StopBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid body", details: parsed.error.format() }, { status: 400 });
    }
    const engine = await stopEngine(parsed.data.net, parsed.data.market, parsed.data.reason ?? "user");
    if (!engine) return NextResponse.json({ stopped: false, reason: "no-such-engine" });
    return NextResponse.json(engine.getStatus());
  }

  return NextResponse.json({ error: "action must be 'start' or 'stop'" }, { status: 400 });
}
