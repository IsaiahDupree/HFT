/**
 * Standalone oracle snapshot — capture Coinbase/OKX/CoinDesk/Chainlink agreement
 * + Chainlink update-age per crypto asset into oracle_snapshots. Runs the same
 * code the snapshot worker calls; use for a one-off / independent cadence.
 *
 *   npm run worker:oracle
 *   npm run worker:oracle -- BTC,ETH,SOL
 */
import "./_env.ts";
import { captureOracleSnapshots } from "../src/lib/oracle/capture.ts";

(async () => {
  const arg = process.argv[2];
  const assets = arg ? arg.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : undefined;
  const { written, rows } = await captureOracleSnapshots(assets);
  for (const r of rows) {
    console.log(
      `  ${r.asset}: agree=${(r.agreement_score * 100).toFixed(0)}% (${r.n_sources} src` +
        `${r.side_agree ? "" : ", STRADDLE"})  chainlink=${r.chainlink ?? "—"}` +
        `  age=${r.chainlink_update_age ?? "—"}s (${r.chainlink_zone ?? "—"})`,
    );
  }
  console.log(`oracle-snapshot: wrote ${written}/${rows.length} rows`);
  process.exit(0);
})();
