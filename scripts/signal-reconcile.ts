/**
 * Shadow-vs-outcome reconciliation — for every ROUTED signal in signal_intake,
 * derive its window outcome (close>open from 1-min candles) and report whether the
 * signals actually won + realized would-be PnL. The arm-on-evidence gate.
 *
 *   npm run report:signal-reconcile
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { reconcileOne, summarize, type RoutedSignal } from "../src/lib/signal/reconcile.ts";

const STEP = 300;

function outcomeFor(asset: string, windowEnd: number): boolean | null {
  const inst = `${asset}-USD`;
  const start = windowEnd - STEP;
  const get = (t: number) => {
    const cd = db().prepare(
      `SELECT open, close FROM coindesk_candles WHERE instrument=? AND granularity='ONE_MINUTE' AND start_unix=?`,
    ).get(inst, t) as { open: number; close: number } | undefined;
    if (cd) return cd;
    return db().prepare(
      `SELECT open, close FROM coinbase_candles WHERE product_id=? AND granularity='ONE_MINUTE' AND start_unix=?`,
    ).get(inst, t) as { open: number; close: number } | undefined;
  };
  const first = get(start);
  const last = get(windowEnd - 60);
  if (!first || !last) return null;
  return last.close > first.open;
}

(async () => {
  const rows = db().prepare(
    `SELECT asset, recurrence, side, entry_price, window_end_ts FROM signal_intake
     WHERE routed=1 AND window_end_ts IS NOT NULL ORDER BY window_end_ts`,
  ).all() as RoutedSignal[];

  console.log("════════════════════════════════════════════════════════════════");
  console.log(`  SIGNAL SHADOW RECONCILIATION — ${rows.length} routed signal(s)`);
  console.log("════════════════════════════════════════════════════════════════");
  if (rows.length === 0) {
    console.log("  no routed signals yet — let the shadow loop emit a few ETH:5m windows.");
    process.exit(0);
  }

  const reconciled = rows.map((s) => {
    const resolvedUp = outcomeFor(s.asset, s.window_end_ts);
    return { ...s, ...reconcileOne(s, resolvedUp) };
  });

  for (const r of reconciled.slice(-15)) {
    const out = r.won === null ? "pending"
      : `${r.won ? "WIN " : "LOSS"} pnl=$${(r.pnl ?? 0).toFixed(2)}`;
    console.log(`  ${r.asset}:${r.recurrence} ${String(r.side).padEnd(4)} @${r.entry_price.toFixed(3)}  win@${r.window_end_ts}  → ${out}`);
  }

  const s = summarize(reconciled);
  console.log("  ----------------------------------------------------------------");
  console.log(`  resolved ${s.n} (pending ${s.pending}) · win ${(s.win * 100).toFixed(1)}% ` +
    `(CI-low ${(s.winCiLow * 100).toFixed(1)}%) · would-be PnL $${s.pnl.toFixed(2)} · ROI ${(s.roi * 100).toFixed(1)}%`);
  console.log("  (arm ALLOW_TRADE only once this shows a clean, positive shadow sample.)");
  process.exit(0);
})();
