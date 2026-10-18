/**
 * Backtest harness for the midwindow-trajectory strategy.
 *
 * What it does:
 *   1. Pulls 1-minute candles from `coindesk_candles` for a given instrument.
 *   2. Walks the series, treating each disjoint 5-min boundary as a Polymarket
 *      "Up/Down" window. (T=floor(t/5min), strike=spot at T.)
 *   3. At T+2min, builds a snapshot from the first 120s of intra-minute
 *      ticks reconstructed from open/high/low/close + interpolation, then calls
 *      detectMidwindowTrajectory.
 *   4. For each fired signal, checks the realized close at T+5min and reports
 *      hit-rate, mean signed-edge, and hit-rate bucketed by |zMove|.
 *
 * Mode caveats:
 *   - "Crypto-only" mode (default): we DON'T have a historical Polymarket
 *     5m-binary price stream in the local DB. We approximate the market
 *     P(Up) as 0.5 (vig-free midpoint). This tells us whether the trajectory
 *     model is *informative* (hit-rate > 0.5 on directional bets), NOT
 *     whether it beats the actual MM quote + vig. To beat the actual market
 *     we need real Poly historical prices, which would be a v2 follow-up.
 *
 *   - We also report a "vig-adjusted" hit-rate threshold so the operator can
 *     see how much of the model's hit-rate is required just to clear fees.
 *
 *   - The strike is assumed = price at T (window-open). For real Polymarket
 *     5m-binaries the strike is typically pegged to a published reference
 *     price set when the market was created; close enough for sign analysis.
 *
 * Usage:
 *   npx tsx scripts/backtest-midwindow.ts                    # BTC-USD, default opts
 *   npx tsx scripts/backtest-midwindow.ts --instrument ETH-USD
 *   npx tsx scripts/backtest-midwindow.ts --min-z 1.5 --edge 0.10
 *   npx tsx scripts/backtest-midwindow.ts --json             # machine-readable output
 */
import "./_env.ts";
import Database from "better-sqlite3";
import {
  detectMidwindowTrajectory,
  type MidwindowSnapshot,
  type MidwindowTick,
} from "../src/lib/strategies/midwindow-trajectory.ts";

type Args = {
  instrument: string;
  minZMove: number;
  edgeThreshold: number;
  minPoolingHits: number;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    instrument: "BTC-USD",
    minZMove: 1.0,
    edgeThreshold: 0.05,
    minPoolingHits: 20,
    json: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--instrument") args.instrument = argv[++i]!;
    else if (a === "--min-z") args.minZMove = Number(argv[++i]);
    else if (a === "--edge") args.edgeThreshold = Number(argv[++i]);
    else if (a === "--json") args.json = true;
  }
  return args;
}

type Candle = {
  start_unix: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

function loadCandles(db: Database.Database, instrument: string): Candle[] {
  return db
    .prepare(
      `SELECT start_unix, open, high, low, close
         FROM coindesk_candles
        WHERE instrument = ? AND granularity = 'ONE_MINUTE'
        ORDER BY start_unix ASC`,
    )
    .all(instrument) as Candle[];
}

/**
 * Reconstruct per-2-second ticks across consecutive 1-min candles by
 * linearly interpolating along the open→high→low→close path. Yields 30
 * sub-ticks per minute (60 over a 2-min window), enough to feed the
 * strategy's stdev estimation. Variance shape is approximate but
 * directionally faithful.
 *
 * Leg order: open → high → low → close. Each leg gets 1/3 of the 60s.
 * Linear interpolation between waypoints gives non-degenerate per-tick
 * log returns (the strategy needs stdev > 0 to fire).
 */
const SUB_TICKS_PER_MIN = 30;

function reconstructTicks(candles: Candle[], startSec: number, endSec: number): MidwindowTick[] {
  const ticks: MidwindowTick[] = [];
  for (const c of candles) {
    if (c.start_unix < startSec || c.start_unix >= endSec) continue;
    const waypoints = [c.open, c.high, c.low, c.close]; // 4 points = 3 legs
    const subPerLeg = Math.floor(SUB_TICKS_PER_MIN / 3); // 10 ticks per leg
    const subIntervalMs = (60_000 / 3) / subPerLeg;
    let subIdx = 0;
    for (let leg = 0; leg < 3; leg++) {
      const from = waypoints[leg]!;
      const to = waypoints[leg + 1]!;
      for (let k = 0; k < subPerLeg; k++) {
        const t = k / subPerLeg;
        const price = from + (to - from) * t;
        ticks.push({
          ts: c.start_unix * 1000 + Math.round(subIdx * subIntervalMs),
          price,
        });
        subIdx++;
      }
    }
    // Final tick at end of minute = close.
    ticks.push({ ts: (c.start_unix + 60) * 1000 - 1, price: c.close });
  }
  return ticks;
}

type BacktestRow = {
  windowOpenSec: number;
  priceAtOpen: number;
  priceAtT120: number;
  priceAtT300: number; // realized close
  signaled: boolean;
  side?: "UP" | "DOWN";
  modelProbUp?: number;
  zMove?: number;
  edge?: number;
  hit?: boolean; // signal direction matched realized direction
};

function runBacktest(candles: Candle[], args: Args): BacktestRow[] {
  const byStart = new Map<number, Candle>();
  for (const c of candles) byStart.set(c.start_unix, c);
  const rows: BacktestRow[] = [];

  if (candles.length === 0) return rows;
  const firstSec = candles[0]!.start_unix;
  const lastSec = candles[candles.length - 1]!.start_unix;
  // Step by 5-min windows aligned to 300-second boundaries.
  const firstAligned = Math.ceil(firstSec / 300) * 300;
  for (let t0 = firstAligned; t0 + 300 <= lastSec; t0 += 300) {
    const openC = byStart.get(t0);
    const t120C = byStart.get(t0 + 120);
    const t300C = byStart.get(t0 + 300);
    if (!openC || !t120C || !t300C) continue;
    const priceAtOpen = openC.open;
    const priceAtT120 = t120C.close; // close of the minute that ends at T+120s
    const priceAtT300 = t300C.open; // open of the minute starting at T+300s = realized close of window

    const ticksSinceOpen = reconstructTicks(candles, t0, t0 + 120);

    const snap: MidwindowSnapshot = {
      conditionId: `synthetic-${t0}`,
      asset: args.instrument.split("-")[0]!,
      strike: priceAtOpen, // approximation: strike = price at window open
      windowOpenMs: t0 * 1000,
      windowCloseMs: (t0 + 300) * 1000,
      nowMs: (t0 + 120) * 1000,
      priceAtOpen,
      priceNow: priceAtT120,
      ticksSinceOpen,
      upPrice: 0.5,
      downPrice: 0.5,
      liquidityUsd: 50_000,
    };
    const op = detectMidwindowTrajectory(snap, {
      minZMove: args.minZMove,
      edgeThreshold: args.edgeThreshold,
    });
    const row: BacktestRow = {
      windowOpenSec: t0,
      priceAtOpen,
      priceAtT120,
      priceAtT300,
      signaled: op !== null,
    };
    if (op) {
      const realizedUp = priceAtT300 > priceAtOpen;
      row.side = op.side;
      row.modelProbUp = op.modelProbUp;
      row.zMove = op.zMove;
      row.edge = op.edge;
      row.hit =
        (op.side === "UP" && realizedUp) || (op.side === "DOWN" && !realizedUp);
    }
    rows.push(row);
  }
  return rows;
}

function summarize(rows: BacktestRow[], args: Args) {
  const total = rows.length;
  const fired = rows.filter((r) => r.signaled);
  const wins = fired.filter((r) => r.hit === true);
  const fireRate = total === 0 ? 0 : fired.length / total;
  const hitRate = fired.length === 0 ? 0 : wins.length / fired.length;
  const meanEdge =
    fired.length === 0 ? 0 : fired.reduce((s, r) => s + (r.edge ?? 0), 0) / fired.length;

  // Bucket by |zMove| to see whether stronger signals are more reliable.
  const buckets: { label: string; lo: number; hi: number }[] = [
    { label: "1.0–1.5", lo: 1.0, hi: 1.5 },
    { label: "1.5–2.0", lo: 1.5, hi: 2.0 },
    { label: "2.0–3.0", lo: 2.0, hi: 3.0 },
    { label: "3.0+", lo: 3.0, hi: Infinity },
  ];
  const bucketStats = buckets.map((b) => {
    const sub = fired.filter((r) => (r.zMove ?? 0) >= b.lo && (r.zMove ?? 0) < b.hi);
    const w = sub.filter((r) => r.hit === true).length;
    const hr = sub.length === 0 ? null : w / sub.length;
    return { label: b.label, n: sub.length, hits: w, hitRate: hr };
  });

  // Side breakdown.
  const upFired = fired.filter((r) => r.side === "UP");
  const downFired = fired.filter((r) => r.side === "DOWN");
  const upWins = upFired.filter((r) => r.hit === true).length;
  const downWins = downFired.filter((r) => r.hit === true).length;

  return {
    args,
    totals: { windows: total, fired: fired.length, fire_rate_pct: +(fireRate * 100).toFixed(2) },
    overall: {
      hits: wins.length,
      hit_rate_pct: +(hitRate * 100).toFixed(2),
      mean_edge_pct: +(meanEdge * 100).toFixed(2),
    },
    by_zmove_bucket: bucketStats,
    by_side: {
      UP: {
        fired: upFired.length,
        hits: upWins,
        hit_rate_pct: upFired.length === 0 ? null : +((upWins / upFired.length) * 100).toFixed(2),
      },
      DOWN: {
        fired: downFired.length,
        hits: downWins,
        hit_rate_pct:
          downFired.length === 0 ? null : +((downWins / downFired.length) * 100).toFixed(2),
      },
    },
    // Threshold the strategy must clear to be EV-positive on Polymarket
    // (after the typical 20bps round-trip fee + at-the-money 0.50 entry):
    //   payoff = (1 - entry) if win, (-entry) if lose. With entry=0.50:
    //   ev = p × 0.50 - (1-p) × 0.50 = 0.50 × (2p - 1)
    //   To clear 20bps fee on a $5 stake: ev > 0.002 × stake → p > 0.502
    //   But realistic Polymarket markups make breakeven closer to ~0.53–0.55.
    breakeven_note:
      "Hit-rate above 0.50 means trajectory model is INFORMATIVE. To beat actual " +
      "Polymarket pricing you'd need ~0.53–0.55 after fees + typical MM markup. " +
      "This backtest uses 0.50 mid as the market — a v2 with real Polymarket " +
      "historical prices is needed to validate live edge.",
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const dbHandle = new Database("data/polymarket.db", { readonly: true });
  const candles = loadCandles(dbHandle, args.instrument);
  if (candles.length === 0) {
    console.error(`No ${args.instrument} 1-min candles found in coindesk_candles.`);
    console.error("Run `npm run coindesk:backfill` first.");
    process.exit(2);
  }
  const rows = runBacktest(candles, args);
  const summary = summarize(rows, args);

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`\nMidwindow-trajectory backtest`);
  console.log(`  instrument:       ${args.instrument} (${candles.length} 1-min candles)`);
  console.log(`  date range:       ${new Date(candles[0]!.start_unix * 1000).toISOString().slice(0, 19)}Z → ${new Date(candles[candles.length - 1]!.start_unix * 1000).toISOString().slice(0, 19)}Z`);
  console.log(`  config:           min_z_move=${args.minZMove}  edge_threshold=${args.edgeThreshold}`);
  console.log(``);
  console.log(`  windows scanned:  ${summary.totals.windows}`);
  console.log(`  signals fired:    ${summary.totals.fired}  (fire-rate ${summary.totals.fire_rate_pct}%)`);
  console.log(``);
  console.log(`  Overall hit-rate: ${summary.overall.hits}/${summary.totals.fired} = ${summary.overall.hit_rate_pct}%`);
  console.log(`  Mean edge:        ${summary.overall.mean_edge_pct}pp (model − market)`);
  console.log(``);
  console.log(`  By |zMove| bucket:`);
  for (const b of summary.by_zmove_bucket) {
    const hr = b.hitRate === null ? "n/a " : `${(b.hitRate * 100).toFixed(1).padStart(5)}%`;
    console.log(`    ${b.label.padEnd(8)}  n=${String(b.n).padStart(5)}  ${b.hits} hits  →  ${hr}`);
  }
  console.log(``);
  console.log(`  By side:`);
  console.log(`    UP   fired ${summary.by_side.UP.fired}, hits ${summary.by_side.UP.hits}, rate ${summary.by_side.UP.hit_rate_pct ?? "n/a"}%`);
  console.log(`    DOWN fired ${summary.by_side.DOWN.fired}, hits ${summary.by_side.DOWN.hits}, rate ${summary.by_side.DOWN.hit_rate_pct ?? "n/a"}%`);
  console.log(``);
  console.log(`  Note: ${summary.breakeven_note}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
