/**
 * Oracle lift readout — join oracle_snapshots to the resolved 5-min window each
 * was captured in (outcome from 1-min candles) and report favored-side win rate
 * by agreement band / side-straddle / Chainlink staleness zone.
 *
 *   npm run report:oracle-lift
 *
 * Candle source: coindesk_candles (market='coinbase') else coinbase_candles. A
 * snapshot is paired to the aligned 5-min window containing its captured_at when
 * the window's candles are present. Thin data → prints what it has (accrues live).
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { oracleLift, type OraclePair } from "../src/lib/oracle/lift.ts";

const STEP = 300; // 5-min windows

type Candle = { open: number; close: number };

function candleMap(asset: string): Map<number, Candle> {
  const inst = `${asset}-USD`;
  const m = new Map<number, Candle>();
  // Prefer CoinDesk (continuous backfill), fall back to Coinbase snapshots.
  const cd = db()
    .prepare(
      `SELECT start_unix, open, close FROM coindesk_candles
       WHERE instrument = ? AND granularity = 'ONE_MINUTE'`,
    )
    .all(inst) as Array<{ start_unix: number; open: number; close: number }>;
  for (const r of cd) m.set(r.start_unix, { open: r.open, close: r.close });
  if (m.size === 0) {
    const cb = db()
      .prepare(
        `SELECT start_unix, open, close FROM coinbase_candles
         WHERE product_id = ? AND granularity = 'ONE_MINUTE'`,
      )
      .all(inst) as Array<{ start_unix: number; open: number; close: number }>;
    for (const r of cb) m.set(r.start_unix, { open: r.open, close: r.close });
  }
  return m;
}

function windowPair(snap: any, candles: Map<number, Candle>): OraclePair | null {
  const t = Number(snap.captured_at);
  const start = Math.floor(t / STEP) * STEP; // aligned 5-min window containing the snapshot
  const first = candles.get(start);
  const last = candles.get(start + STEP - 60); // last 1-min candle of the window
  const decide = candles.get(start + STEP - 120); // ~60s before the close candle
  if (!first || !last || !decide) return null;
  return {
    agreement_score: snap.agreement_score,
    side_agree: snap.side_agree == null ? null : !!snap.side_agree,
    chainlink_zone: snap.chainlink_zone ?? null,
    favored_up: decide.close > first.open,
    resolved_up: last.close > first.open,
  };
}

function fmt(b: { label: string; n: number; win: number; winCiLow: number; winLift: number }): string {
  return `  ${b.label.padEnd(18)} n=${String(b.n).padStart(4)}  win=${(b.win * 100).toFixed(1).padStart(5)}%` +
    `  CIlow=${(b.winCiLow * 100).toFixed(1).padStart(5)}%  Δ=${(b.winLift * 100 >= 0 ? "+" : "") + (b.winLift * 100).toFixed(1)}`;
}

(async () => {
  const snaps = db().prepare(`SELECT * FROM oracle_snapshots`).all() as any[];
  if (snaps.length === 0) {
    console.log("oracle-lift: no oracle_snapshots yet — run `npm run worker:oracle` / let the snapshot worker accrue.");
    process.exit(0);
  }
  const byAsset = new Map<string, Map<number, Candle>>();
  const pairs: OraclePair[] = [];
  for (const s of snaps) {
    const a = String(s.asset).toUpperCase();
    if (!byAsset.has(a)) byAsset.set(a, candleMap(a));
    const p = windowPair(s, byAsset.get(a)!);
    if (p) pairs.push(p);
  }

  console.log("════════════════════════════════════════════════════════════════");
  console.log(`  ORACLE LIFT — ${snaps.length} snapshots, ${pairs.length} paired to a resolved window`);
  console.log("════════════════════════════════════════════════════════════════");
  if (pairs.length === 0) {
    console.log("  no snapshots pair to a completed window yet (need overlapping 1-min candles) — accruing.");
    process.exit(0);
  }
  const lift = oracleLift(pairs);
  console.log(fmt(lift.baseline));
  console.log("  -- by agreement band --");
  for (const b of lift.byAgreement) console.log(fmt(b));
  console.log("  -- by side --");
  for (const b of lift.bySideAgree) console.log(fmt(b));
  console.log("  -- by chainlink zone --");
  for (const b of lift.byZone) console.log(fmt(b));
  console.log("\n  (Δ = win-rate lift vs baseline. Hypothesis: low-agree / straddle / stale → lower win.)");
  process.exit(0);
})();
