/**
 * tsdb-policies — apply TimescaleDB compression + retention policies to the
 * warehouse hypertables (idempotent), then optionally force-compress already-old
 * chunks so the storage win is realized immediately rather than waiting for the
 * background scheduler.
 *
 *   npm run tsdb:policies            # apply policies + compress eligible old chunks
 *   npm run tsdb:policies -- --no-compress-now   # just register the policies
 */
import "./_env.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tsdb, closeTsdb } from "../src/lib/db/candle-store.ts";

const compressNow = !process.argv.includes("--no-compress-now");
const sql = readFileSync(resolve(process.cwd(), "src/lib/db/tsdb-policies.sql"), "utf8");

await tsdb().query(sql);
console.log("tsdb-policies: compression + retention policies applied.");

if (compressNow) {
  // Compress every chunk older than each table's threshold, right now.
  const targets: Array<[string, string]> = [
    ["coinbase_candles", "604800"],   // 7d in seconds (integer-time)
    ["realtime_ticks", "86400"],      // 1d
  ];
  for (const [table, olderSec] of targets) {
    // show_chunks(older_than) on an integer hypertable takes an ABSOLUTE value in
    // the dimension's units, so pass (now_epoch − threshold), not the raw interval.
    const chunks = (await tsdb().query(
      `SELECT show_chunks($1, older_than => (EXTRACT(epoch FROM now())::bigint - $2::bigint)) AS chunk`, [table, olderSec],
    )).rows.map((r) => r.chunk as string);
    let done = 0;
    for (const c of chunks) {
      try { await tsdb().query(`SELECT compress_chunk($1, if_not_compressed => true)`, [c]); done++; } catch { /* already compressed */ }
    }
    console.log(`  ${table}: compressed ${done}/${chunks.length} eligible chunks`);
  }
  // market_snapshots is timestamptz.
  try {
    const snaps = (await tsdb().query(
      `SELECT show_chunks('market_snapshots', older_than => INTERVAL '7 days') AS chunk`,
    )).rows.map((r) => r.chunk as string);
    let done = 0;
    for (const c of snaps) { try { await tsdb().query(`SELECT compress_chunk($1, if_not_compressed => true)`, [c]); done++; } catch { /* noop */ } }
    console.log(`  market_snapshots: compressed ${done}/${snaps.length} eligible chunks`);
  } catch { /* no eligible chunks */ }
}

// Report before/after sizes + compression stats.
const stats = (await tsdb().query(`
  SELECT hypertable_name,
         pg_size_pretty(before_compression_total_bytes) AS uncompressed,
         pg_size_pretty(after_compression_total_bytes)  AS compressed,
         CASE WHEN after_compression_total_bytes > 0
              THEN round(before_compression_total_bytes::numeric / after_compression_total_bytes, 1)
              ELSE NULL END AS ratio
    FROM hypertable_compression_stats('coinbase_candles')
   UNION ALL SELECT hypertable_name, pg_size_pretty(before_compression_total_bytes), pg_size_pretty(after_compression_total_bytes),
         CASE WHEN after_compression_total_bytes > 0 THEN round(before_compression_total_bytes::numeric / after_compression_total_bytes, 1) ELSE NULL END
    FROM hypertable_compression_stats('realtime_ticks')
   UNION ALL SELECT hypertable_name, pg_size_pretty(before_compression_total_bytes), pg_size_pretty(after_compression_total_bytes),
         CASE WHEN after_compression_total_bytes > 0 THEN round(before_compression_total_bytes::numeric / after_compression_total_bytes, 1) ELSE NULL END
    FROM hypertable_compression_stats('market_snapshots')
`).catch(() => ({ rows: [] as Array<Record<string, unknown>> }))).rows;

console.log("\n  compression stats (compressed chunks only):");
for (const r of stats) {
  console.log(`    ${String(r.hypertable_name).padEnd(18)} ${String(r.uncompressed ?? "—").padStart(9)} → ${String(r.compressed ?? "—").padStart(9)}  (${r.ratio ?? "—"}×)`);
}
const total = (await tsdb().query(`SELECT pg_size_pretty(pg_database_size('hft')) AS s`)).rows[0]?.s;
console.log(`\n  total db size now: ${total}`);
await closeTsdb();
