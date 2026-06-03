/**
 * build-regime-fit-table — offline builder for the meta-layer BUILD 6 learned
 * regime→strategy fit table. Aggregates the live ledger into (strategy_kind ×
 * regime) Beta-LCB win-rates, DROPS venue-vocabulary rows (parity), and persists
 * the artifact the serve path loads (gated by ARENA_REGIME_FIT_TABLE=1).
 *
 *   npm run build:regime-fit [-- --min-trades 30 --days 3650 --dry-run]
 *
 * Artifact data/regime-fit-table.json is gitignored (derived, rebuildable model);
 * regenerate it the way the meta-label model is regenerated. On a thin ledger this
 * intentionally writes a NO-OP table (0 cells reach min-trades) — that's correct.
 */
import "./_env.ts";
import { loadLabeledDecisions } from "../src/lib/decision/calibration-loader.ts";
import {
  buildRegimeFitTableFromRows, saveRegimeFitTable, REGIME_FIT_PATH, DEFAULT_MIN_TRADES,
} from "../src/lib/decision/regime-fit-table.ts";

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const minTrades = Number(arg("--min-trades") ?? DEFAULT_MIN_TRADES);
const days = Number(arg("--days") ?? 3650);
const dryRun = process.argv.includes("--dry-run");
const since = new Date(Date.now() - days * 86_400_000).toISOString();

const rows = loadLabeledDecisions({ sinceTs: since, limit: 10_000 });
const table = buildRegimeFitTableFromRows(rows, { minTrades });
const keys = Object.keys(table.cells).sort();
const qualified = keys.filter((k) => table.cells[k].n >= minTrades);

console.log(`\nbuild-regime-fit-table — (strategy_kind × regime) Beta-LCB win-rate · last ${days}d\n`);
console.log(`  labeled rows: ${rows.length}  ·  dropped (venue/out-of-vocab/no-regime): ${table.dropped}  ·  cells: ${keys.length}  ·  minTrades: ${minTrades}`);
if (keys.length) {
  console.log(`\n  ${"strategy_kind | regime".padEnd(50)} ${"n".padStart(4)} ${"wins".padStart(5)} ${"win%".padStart(6)} ${"LCB".padStart(7)}  serves?`);
  for (const k of keys) {
    const c = table.cells[k];
    console.log(`  ${k.padEnd(50)} ${String(c.n).padStart(4)} ${String(c.wins).padStart(5)} ${`${((c.wins / c.n) * 100).toFixed(0)}%`.padStart(6)} ${c.lcb.toFixed(3).padStart(7)}  ${c.n >= minTrades ? "YES" : "no (thin)"}`);
  }
}
if (qualified.length === 0) {
  console.log(`\n  ⚠ INSUFFICIENT DATA: 0 of ${keys.length} cells reach minTrades=${minTrades} — the table will NO-OP (every regime lookup falls back to the static regimeFitScore).`);
  console.log(`     Expected while the ledger is thin; cells activate automatically as more linked exits land. (Lower with --min-trades to inspect, but thin cells are noisy.)`);
}

if (dryRun) {
  console.log(`\n  --dry-run: not writing. Would write ${keys.length} cell(s) → ${REGIME_FIT_PATH}\n`);
} else {
  saveRegimeFitTable(table);
  console.log(`\n  saved → ${REGIME_FIT_PATH}  (${qualified.length} cell(s) will serve a learned LCB; the rest fall back to static)`);
  console.log(`  live path: set ARENA_REGIME_FIT_TABLE=1 to have the regime gate use learned LCB win-rates`);
  console.log(`  (replace-when-confident; news_shock reject + 'unknown'/thin cells stay static; sim genome-kind only).\n`);
}
