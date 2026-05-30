/**
 * One-shot script to apply the current risk-budget derivation to existing
 * live capsules. Useful after changing RISK_* env vars to bring the in-DB
 * state in line with the new equations.
 *
 *   npx tsx scripts/apply-risk-budget.ts
 */
import "./_env";
import { readRiskBudgetFromEnv, summarizeBudget } from "../src/lib/arena/risk-budget";
import Database from "better-sqlite3";

const db = new Database("data/polymarket.db");
const budget = readRiskBudgetFromEnv();
console.log("Applying risk budget:");
console.log("  " + summarizeBudget(budget));
console.log("  per-capsule: capital=$" + budget.perCapsule.capital_usd + ", daily-cap=$" + budget.perCapsule.daily_loss_cap_usd + ", total-DD=$" + budget.perCapsule.total_dd_cap_usd + ", trades/day=" + budget.perCapsule.max_trades_per_day);
console.log("");

const today = new Date().toISOString().slice(0, 10);
const r = db.prepare(
  `UPDATE capsules
     SET capital_allocated_usd  = ?,
         capital_available_usd  = ?,
         max_daily_loss_usd     = ?,
         max_total_drawdown_usd = ?,
         max_trades_per_day     = ?,
         daily_pnl_usd          = 0,
         daily_pnl_reset_date   = ?,
         trades_today           = 0,
         updated_at             = datetime('now')
   WHERE status = 'live'`,
).run(
  budget.perCapsule.capital_usd,
  budget.perCapsule.capital_usd,
  budget.perCapsule.daily_loss_cap_usd,
  budget.perCapsule.total_dd_cap_usd,
  budget.perCapsule.max_trades_per_day,
  today,
);
console.log("Updated " + r.changes + " live capsule(s).");

db.prepare(
  `INSERT INTO evolution_log (created_at, event_type, summary, payload_json)
   VALUES (datetime('now'), 'risk-budget-applied', ?, ?)`,
).run(
  "Applied risk budget — " + summarizeBudget(budget),
  JSON.stringify(budget),
);

const after = db.prepare("SELECT id, paper_agent_id, name, capital_allocated_usd, max_daily_loss_usd, max_total_drawdown_usd, max_trades_per_day FROM capsules WHERE status='live' ORDER BY name").all() as any[];
console.log("");
console.log("After:");
for (const c of after) {
  console.log("  " + c.id.slice(0, 8) + " " + c.name.slice(0, 40), "cap=$" + c.capital_allocated_usd, "daily=$" + c.max_daily_loss_usd, "totalDD=$" + c.max_total_drawdown_usd, "tradesPerDay=" + c.max_trades_per_day);
}
