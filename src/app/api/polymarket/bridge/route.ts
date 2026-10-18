/**
 * POST /api/polymarket/bridge
 *
 * Triggers the ETH-mainnet → USDC.e-Polygon bridge via LI.FI. Defaults to
 * DRY_RUN unless body.live=true AND ALLOW_BRIDGE=1 are both present.
 *
 * Safety contract:
 *   - GET would be a free read; we use POST so the Next.js middleware's
 *     mutating-routes auth gate applies
 *   - ALLOW_BRIDGE env must be "1" for any live signing
 *   - Amount-cap and 24h rate-limit enforced in `runBridge`
 *   - The signing private key is read server-side from .env.local — the
 *     browser never sees it
 *
 * Request body (JSON, all optional):
 *   {
 *     "live": boolean,            // default false (DRY_RUN regardless of env)
 *     "highValueOverride": bool,  // bypass 0.5 ETH cap (admin-only intent)
 *     "forceRecent": bool         // bypass 24h rate limit (admin-only intent)
 *   }
 *
 * Response shape:
 *   { kind: "dry-run" | "executed" | "submitted-pending" | "rejected", … }
 */
import { NextResponse } from "next/server";
import { runBridge } from "@/lib/onchain/bridge-runner";

export const dynamic = "force-dynamic";
// Bridge polling can take up to ~16 min in the worst case. Tell Next/Vercel.
export const maxDuration = 900;

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty body OK */ }

  const wantLive = body.live === true;
  const allowBridge = process.env.ALLOW_BRIDGE === "1";
  const live = wantLive && allowBridge;
  // If the caller asked for live but env is locked, surface that clearly.
  const envBlocked = wantLive && !allowBridge;

  const result = await runBridge({
    live,
    highValueOverride: body.highValueOverride === true,
    forceRecent: body.forceRecent === true,
    logPrefix: "api-bridge",
  });

  if (envBlocked) {
    return NextResponse.json({
      ...result,
      note: "ALLOW_BRIDGE env is unset — request degraded to DRY_RUN despite live=true.",
    });
  }
  if (result.kind === "rejected") {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
