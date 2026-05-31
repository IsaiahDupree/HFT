/**
 * tsdb-init — create the TimescaleDB warehouse schema (hypertables) from
 * src/lib/db/tsdb-schema.sql. Idempotent; safe to re-run.   npm run tsdb:init
 */
import "./_env.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tsdb, closeTsdb } from "../src/lib/db/candle-store.ts";

const sql = readFileSync(resolve(process.cwd(), "src/lib/db/tsdb-schema.sql"), "utf8");
await tsdb().query(sql); // node-pg runs the whole multi-statement DDL in one simple-query call
const t = await tsdb().query(`SELECT hypertable_name FROM timescaledb_information.hypertables ORDER BY 1`);
console.log(`tsdb-init: hypertables = ${t.rows.map((r) => r.hypertable_name).join(", ")}`);
await closeTsdb();
