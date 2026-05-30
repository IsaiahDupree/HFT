/**
 * Backtest the poly_short_binary_directional strategy.
 *
 * For each resolved binary in `poly_binaries` (settled=1, outcome_yes IS NOT NULL)
 * we replay what the strategy would have done at entry time using:
 *   - The actual Coinbase/OKX 1-min candles (windowed by cutoffUnix)
 *   - The actual Polymarket YES midpoint recorded around entry time
 *   - The known outcome to compute realized PnL
 *
 * Outputs aggregate stats (win-rate, PnL, edge-per-trade) overall and per
 * asset. Optional parameter sweep across vel_window / vel_entry / pre_cutoff
 * combinations to compare configurations.
 *
 * Usage:
 *   npx tsx scripts/backtest-binaries.ts                 # default genome
 *   npx tsx scripts/backtest-binaries.ts --sweep         # parameter sweep
 *   npx tsx scripts/backtest-binaries.ts --since 7d      # last 7 days only
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { loadRecentCandles, loadRecentCandlesFromCoindesk, velocity } from "../src/lib/arena/momentum.ts";
import { assetToFeed, type BinaryAsset } from "../src/lib/arena/short-binaries.ts";

type ResolvedBinary = {
  token_id: string;
  asset: string;
  duration_kind: string;
  expiry_iso: string;
  outcome_yes: 0 | 1;
};

type GenomeParams = {
  vel_window_min: number;
  vel_entry_pct: number;
  pre_cutoff_min: number;
  max_window_min: number;
  max_yes_price_for_buy: number;
  min_yes_price_for_sell: number;
  entry_size_usd: number;
};

const DEFAULTS: GenomeParams = {
  vel_window_min: 3,
  vel_entry_pct: 0.0005,
  pre_cutoff_min: 3,
  max_window_min: 16,
  max_yes_price_for_buy: 0.70,
  min_yes_price_for_sell: 0.30,
  entry_size_usd: 5,
};

function loadResolvedBinaries(sinceIso: string | null): ResolvedBinary[] {
  const clauses = ["settled = 1", "outcome_yes IS NOT NULL"];
  const params: Record<string, string> = {};
  if (sinceIso) { clauses.push("expiry_iso >= @sinceIso"); params.sinceIso = sinceIso; }
  return db().prepare(
    `SELECT token_id, asset, duration_kind, expiry_iso, outcome_yes
       FROM poly_binaries WHERE ${clauses.join(" AND ")}
       ORDER BY expiry_iso ASC`,
  ).all(params) as ResolvedBinary[];
}

/** Look up the snapshot midpoint closest to (but not after) the entry time. */
function yesMidAtTime(tokenId: string, isoTs: string): number | null {
  const row = db().prepare(
    `SELECT midpoint FROM market_snapshots
      WHERE token_id = ? AND captured_at <= ? AND midpoint IS NOT NULL
      ORDER BY captured_at DESC LIMIT 1`,
  ).get(tokenId, isoTs) as { midpoint: number } | undefined;
  return row?.midpoint ?? null;
}

type SimResult = {
  fired: boolean;
  side?: "BUY" | "SELL";
  entry_price?: number;
  velocity?: number;
  pnl_usd?: number;
  outcome_yes?: 0 | 1;
  skip_reason?: string;
};

/** Simulate the strategy on one binary. Returns the trade record (or skip). */
function simulateOne(bin: ResolvedBinary, params: GenomeParams): SimResult {
  const asset = bin.asset as BinaryAsset;
  const feed = assetToFeed(asset);
  if (!feed) return { fired: false, skip_reason: "no_feed" };

  const expiryMs = new Date(bin.expiry_iso).getTime();
  // Synthetic "entry time" — when the strategy would have decided. We pick
  // halfway between pre_cutoff and max_window so the velocity is informative
  // but we're still ahead of the CLOB cutoff.
  const entryMinBeforeExpiry = Math.max(params.pre_cutoff_min, Math.min(params.max_window_min - 1, 4));
  const entryMs = expiryMs - entryMinBeforeExpiry * 60_000;
  const entryIso = new Date(entryMs).toISOString();

  // Velocity from candles.
  const cutoffUnix = Math.floor(entryMs / 1000);
  const lookbackMin = Math.max(params.vel_window_min * 3 + 3, 10);
  const candles = feed.exchange === "coinbase"
    ? loadRecentCandles(feed.instrument, lookbackMin, { cutoffUnix })
    : loadRecentCandlesFromCoindesk("okx", feed.instrument, lookbackMin, { cutoffUnix });
  if (candles.length < params.vel_window_min + 1) return { fired: false, skip_reason: "no_candles" };

  const v = velocity(candles, params.vel_window_min);
  if (!Number.isFinite(v)) return { fired: false, skip_reason: "nan_velocity" };
  if (Math.abs(v) < params.vel_entry_pct) return { fired: false, skip_reason: "below_threshold" };

  const mid = yesMidAtTime(bin.token_id, entryIso);
  if (mid == null) return { fired: false, skip_reason: "no_snapshot_mid" };

  const side: "BUY" | "SELL" = v > 0 ? "BUY" : "SELL";
  if (side === "BUY" && mid > params.max_yes_price_for_buy) return { fired: false, skip_reason: "yes_too_high" };
  if (side === "SELL" && mid < params.min_yes_price_for_sell) return { fired: false, skip_reason: "yes_too_low" };

  // Settle at the actual outcome.
  // BUY  YES: pay `mid`, receive 1.0 if YES wins else 0.0. PnL = size * (out - mid) / mid
  // SELL YES (= long NO equivalence): pay (1 - mid), receive 1.0 if NO wins else 0.0.
  //   PnL = size * ((1 - out) - (1 - mid)) / (1 - mid) = size * (mid - out) / (1 - mid)
  const out = bin.outcome_yes;
  let pnl: number;
  if (side === "BUY") {
    pnl = params.entry_size_usd * (out - mid) / mid;
  } else {
    pnl = params.entry_size_usd * (mid - out) / (1 - mid);
  }
  return { fired: true, side, entry_price: mid, velocity: v, pnl_usd: pnl, outcome_yes: out };
}

type Aggregate = { n: number; wins: number; pnl: number; total_size: number };

function runBacktest(binaries: ResolvedBinary[], params: GenomeParams): {
  total: Aggregate; by_asset: Map<string, Aggregate>; by_side: Map<string, Aggregate>;
  skip_counts: Record<string, number>;
} {
  const total: Aggregate = { n: 0, wins: 0, pnl: 0, total_size: 0 };
  const byAsset = new Map<string, Aggregate>();
  const bySide = new Map<string, Aggregate>();
  const skipCounts: Record<string, number> = {};

  for (const bin of binaries) {
    const result = simulateOne(bin, params);
    if (!result.fired) {
      const r = result.skip_reason ?? "unknown";
      skipCounts[r] = (skipCounts[r] ?? 0) + 1;
      continue;
    }
    const pnl = result.pnl_usd ?? 0;
    const isWin = pnl > 0;
    total.n += 1; total.wins += isWin ? 1 : 0; total.pnl += pnl; total.total_size += params.entry_size_usd;
    const a = byAsset.get(bin.asset) ?? { n: 0, wins: 0, pnl: 0, total_size: 0 };
    a.n += 1; a.wins += isWin ? 1 : 0; a.pnl += pnl; a.total_size += params.entry_size_usd;
    byAsset.set(bin.asset, a);
    const s = bySide.get(result.side!) ?? { n: 0, wins: 0, pnl: 0, total_size: 0 };
    s.n += 1; s.wins += isWin ? 1 : 0; s.pnl += pnl; s.total_size += params.entry_size_usd;
    bySide.set(result.side!, s);
  }
  return { total, by_asset: byAsset, by_side: bySide, skip_counts: skipCounts };
}

function fmtAgg(a: Aggregate): string {
  if (a.n === 0) return "n=0";
  const wr = (a.wins / a.n * 100).toFixed(1);
  const pnlPct = (a.pnl / a.total_size * 100).toFixed(2);
  return `n=${String(a.n).padStart(3)} wins=${String(a.wins).padStart(3)} (${wr}%) pnl=$${a.pnl.toFixed(2)} (${pnlPct}% of $${a.total_size.toFixed(0)} risked)`;
}

function parseSinceArg(): string | null {
  const idx = process.argv.indexOf("--since");
  if (idx === -1) return null;
  const v = process.argv[idx + 1] ?? "";
  const m = v.match(/^(\d+)([dh])$/);
  if (!m) return null;
  const amount = Number(m[1]);
  const unit = m[2];
  const ms = unit === "d" ? amount * 86_400_000 : amount * 3_600_000;
  return new Date(Date.now() - ms).toISOString();
}

(() => {
  const sinceIso = parseSinceArg();
  const sweep = process.argv.includes("--sweep");
  const binaries = loadResolvedBinaries(sinceIso);
  console.log(`Loaded ${binaries.length} resolved binaries${sinceIso ? ` since ${sinceIso}` : ""}`);
  if (binaries.length === 0) {
    console.log("No data — run the snapshot worker for a while so binaries accumulate and resolve, then re-run.");
    process.exit(0);
  }

  if (!sweep) {
    const r = runBacktest(binaries, DEFAULTS);
    console.log("\n=== Default params ===");
    console.log("params:", DEFAULTS);
    console.log("total:        ", fmtAgg(r.total));
    console.log("by asset:");
    for (const [asset, agg] of [...r.by_asset.entries()].sort()) console.log(`  ${asset.padEnd(6)}`, fmtAgg(agg));
    console.log("by side:");
    for (const [side, agg] of r.by_side) console.log(`  ${side.padEnd(6)}`, fmtAgg(agg));
    console.log("skips:", r.skip_counts);
    return;
  }

  // Parameter sweep
  console.log("\n=== Parameter sweep ===");
  const grid: Array<Partial<GenomeParams>> = [];
  for (const vwm of [2, 3, 5]) {
    for (const ve of [0.0003, 0.0005, 0.001, 0.002]) {
      for (const pcm of [2, 3]) {
        grid.push({ vel_window_min: vwm, vel_entry_pct: ve, pre_cutoff_min: pcm });
      }
    }
  }
  const rows = grid.map((override) => {
    const params = { ...DEFAULTS, ...override };
    const r = runBacktest(binaries, params);
    return { params, total: r.total };
  });
  rows.sort((a, b) => b.total.pnl - a.total.pnl);
  console.log(
    "vel_window".padEnd(11), "vel_entry".padEnd(11), "pre_cut".padEnd(8),
    "n".padEnd(5), "wins".padEnd(6), "WR%".padEnd(7), "pnl_$".padEnd(10), "edge_%".padEnd(8),
  );
  for (const row of rows) {
    const a = row.total;
    if (a.n === 0) continue;
    const wr = (a.wins / a.n * 100).toFixed(1);
    const edgePct = (a.pnl / a.total_size * 100).toFixed(2);
    console.log(
      String(row.params.vel_window_min).padEnd(11),
      String((row.params.vel_entry_pct! * 100).toFixed(3) + "%").padEnd(11),
      String(row.params.pre_cutoff_min).padEnd(8),
      String(a.n).padEnd(5),
      String(a.wins).padEnd(6),
      `${wr}%`.padEnd(7),
      `$${a.pnl.toFixed(2)}`.padEnd(10),
      `${edgePct}%`.padEnd(8),
    );
  }
})();
