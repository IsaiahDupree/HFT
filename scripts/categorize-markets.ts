/**
 * One-shot backfill: walk every `market_snapshots` row whose `category` is
 * NULL, classify by question text, update in place. Idempotent — re-running
 * only touches NULL rows.
 *
 * Run: `npm run market:categorize`
 *
 * Spec: PRD `lunar-inspired-arena-strategies.md` §6.2.R2 + IMPLEMENTATION-PLAN
 * Phase 3.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { classifyMarket, type MarketCategory } from "../src/lib/polymarket/category.ts";

const rows = db().prepare(
  `SELECT id, question, condition_id FROM market_snapshots WHERE category IS NULL`,
).all() as Array<{ id: number; question: string; condition_id: string }>;

if (rows.length === 0) {
  console.log("market:categorize — nothing to do, all rows categorized.");
  process.exit(0);
}

console.log(`market:categorize — classifying ${rows.length} rows...`);
const update = db().prepare(`UPDATE market_snapshots SET category = ? WHERE id = ?`);
const counts = new Map<MarketCategory, number>();
const tx = db().transaction((items: typeof rows) => {
  for (const r of items) {
    const cat = classifyMarket(r.question, undefined);
    update.run(cat, r.id);
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
});
tx(rows);

console.log("distribution:");
for (const [cat, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cat.padEnd(12)} ${n}`);
}
console.log(`market:categorize — done. ${rows.length} rows updated.`);
