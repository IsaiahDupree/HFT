/**
 * CLI entry point — delegates to src/lib/arena/snapshot.ts:runSnapshotPass()
 * so the same code path runs both from cron AND the /api/worker/snapshot
 * UI button.
 */
import "./_env.ts";
import { runSnapshotPass } from "../src/lib/arena/snapshot.ts";
import { captureOracleSnapshots } from "../src/lib/oracle/capture.ts";

(async () => {
  const result = await runSnapshotPass();
  const sb = Object.entries(result.short_binaries_by_asset).map(([k, v]) => `${k}:${v}`).join(",");
  const sbStr = result.short_binaries_count > 0 ? `  binaries=${result.short_binaries_count}(${sb})` : "  binaries=0";

  // Oracle/spot agreement + Chainlink update-age capture (PRD-04 #1/#2). On by
  // default; set ARENA_CAPTURE_ORACLE=0 to disable. Fully isolated so it can never
  // break the snapshot pass that feeds trading.
  let oracleStr = "";
  if ((process.env.ARENA_CAPTURE_ORACLE ?? "1") === "1") {
    try {
      const o = await captureOracleSnapshots();
      oracleStr = `  oracle=${o.written}`;
    } catch (err) {
      oracleStr = `  oracle=ERR(${(err as Error).message.slice(0, 40)})`;
    }
  }

  console.log(`snapshot-worker: poly=${result.poly_count}  coinbase=${result.coinbase_count}  candles=${result.candle_count}  warehouse=${result.warehouse_mirrored}c/${result.snapshots_mirrored}s${sbStr}${oracleStr}  in ${result.latency_ms}ms`);
  if (result.errors.length > 0) {
    console.error("errors:");
    for (const e of result.errors) console.error("  -", e);
    process.exit(1);
  }
  process.exit(0);
})();
