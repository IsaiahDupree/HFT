/**
 * CLI entry point — delegates to src/lib/arena/snapshot.ts:runSnapshotPass()
 * so the same code path runs both from cron AND the /api/worker/snapshot
 * UI button.
 */
import "./_env.ts";
import { runSnapshotPass } from "../src/lib/arena/snapshot.ts";

(async () => {
  const result = await runSnapshotPass();
  const sb = Object.entries(result.short_binaries_by_asset).map(([k, v]) => `${k}:${v}`).join(",");
  const sbStr = result.short_binaries_count > 0 ? `  binaries=${result.short_binaries_count}(${sb})` : "  binaries=0";
  console.log(`snapshot-worker: poly=${result.poly_count}  coinbase=${result.coinbase_count}  candles=${result.candle_count}  warehouse=${result.warehouse_mirrored}c/${result.snapshots_mirrored}s${sbStr}  in ${result.latency_ms}ms`);
  if (result.errors.length > 0) {
    console.error("errors:");
    for (const e of result.errors) console.error("  -", e);
    process.exit(1);
  }
  process.exit(0);
})();
