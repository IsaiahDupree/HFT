/**
 * One-shot reset: rebase every alive paper agent to a $100 starting bank,
 * scaling cash_usd_current proportionally so realized PnL ratio is preserved.
 * Sets cash_usd_start = 100, peak_equity to max(current, 100), zeroes
 * max_drawdown so the new baseline isn't already underwater.
 *
 * Use after lowering the standard sim allocation to $100/agent.
 *
 * Usage:
 *   tsx scripts/arena-rebalance-cash.ts                  # default $100
 *   tsx scripts/arena-rebalance-cash.ts --amount 50      # custom amount
 *   tsx scripts/arena-rebalance-cash.ts --amount 100 --all   # include dead agents too
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const TARGET = Number(arg("amount") ?? "100");
const ALL = process.argv.includes("--all");

const filter = ALL ? "" : "WHERE alive = 1";
const rows = db().prepare(`SELECT id, name, cash_usd_start, cash_usd_current, unrealized_pnl_usd, realized_pnl_usd FROM paper_agents ${filter}`).all() as Array<{
  id: number; name: string; cash_usd_start: number; cash_usd_current: number; unrealized_pnl_usd: number; realized_pnl_usd: number;
}>;
console.log(`Rebalancing ${rows.length} agents to $${TARGET} baseline...`);

const upd = db().prepare(
  `UPDATE paper_agents SET
     cash_usd_start = ?,
     cash_usd_current = ?,
     realized_pnl_usd = 0,
     unrealized_pnl_usd = 0,
     peak_equity_usd = ?,
     max_drawdown_usd = 0,
     trades_count = 0,
     wins_count = 0,
     position_basket_json = '[]',
     updated_at = datetime('now')
   WHERE id = ?`,
);
const tx = db().transaction(() => {
  for (const r of rows) {
    upd.run(TARGET, TARGET, TARGET, r.id);
  }
});
tx();
console.log(`Done. ${rows.length} agents now start at $${TARGET}, 0 trades / 0 PnL.`);
