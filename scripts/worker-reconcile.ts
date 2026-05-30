import "./_env.ts";
import { reconcileCoinbase, reconcilePolymarket } from "../src/lib/reconcile/loop.ts";

function logSummary(label: string, s: Awaited<ReturnType<typeof reconcileCoinbase>>) {
  console.log(
    `[reconcile] ${label}: scanned local=${s.scannedLocal} remote=${s.scannedRemote} drifts=${s.drifts.length} (${s.durationMs}ms)`,
  );
  for (const d of s.drifts) {
    console.log(`  drift ${d.brokerOrderId} kind=${d.kind} local.status=${d.local?.status ?? "-"} remote.status=${d.remote?.status ?? "-"}`);
  }
}

async function main() {
  console.log("[reconcile] starting one-shot pass...");
  let hadFailure = false;

  try {
    logSummary("coinbase", await reconcileCoinbase());
  } catch (err) {
    console.error("[reconcile] coinbase failed:", (err as Error).message);
    hadFailure = true;
  }

  try {
    logSummary("polymarket", await reconcilePolymarket({ lookbackHours: 6 }));
  } catch (err) {
    console.error("[reconcile] polymarket failed:", (err as Error).message);
    hadFailure = true;
  }

  if (hadFailure) process.exitCode = 1;
}

main();
