import { NextResponse } from "next/server";
import { runSnapshotPass } from "@/lib/arena/snapshot";

export const dynamic = "force-dynamic";

/**
 * POST /api/worker/snapshot — fires one snapshot pass, returns counts +
 * latency + any errors. Idempotent; safe to call from a UI button.
 */
export async function POST() {
  const result = await runSnapshotPass();
  return NextResponse.json(result);
}
