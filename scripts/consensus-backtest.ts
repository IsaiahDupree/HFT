/**
 * Consensus-signal backtester runner.
 *
 *   npm run consensus:backtest               # default 30-day window
 *   npm run consensus:backtest -- --days 60 --min 3 --window 60
 *
 * Methodology:
 *   1. Pull each tracked wallet's recent activity (userActivity).
 *   2. Slide a `--window`-minute window across the past `--days` days; at each
 *      step, run detectConsensus() to surface signals.
 *   3. Deduplicate signals by (marketKey, direction, hour-bucket) so a long-
 *      running agreement counts once.
 *   4. Fetch the resolved-market metadata for each unique conditionId.
 *   5. Hand both to `backtestConsensusSignals` and persist the result.
 *
 * Output: per-(slippage tier) PnL across all historical consensus signals,
 * plus a verdict on the platform's central thesis.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { poly } from "../src/lib/polymarket/client.ts";
import { detectConsensus, type ConsensusTrade, type ConsensusSignal } from "../src/lib/wallets/consensus.ts";
import {
  backtestConsensusSignals,
} from "../src/lib/wallets/consensus-backtest.ts";
import {
  parseGammaResolvedMarket, type ResolvedMarket,
} from "../src/lib/wallets/copy-backtest.ts";

const argv = process.argv.slice(2);
function flag(name: string, fallback: number): number {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1]) return Number(argv[i + 1]);
  return fallback;
}

const DAYS = flag("days", 30);
const WINDOW_MIN = flag("window", 60);
const MIN_WALLETS = flag("min", 3);
const MIN_TRUST = flag("trust", 3);
const SIZE_USD = flag("size", 100);
const PER_WALLET_LIMIT = flag("limit", 200);
const STEP_MIN = flag("step", 30); // how often to slide the consensus detector

const handle = db();
const wallets = handle.prepare(
  `SELECT proxy_wallet, strategy_label, claimed_profit_usd
     FROM tracked_wallets WHERE proxy_wallet IS NOT NULL`,
).all() as Array<{ proxy_wallet: string; strategy_label: string | null; claimed_profit_usd: number | null }>;
if (wallets.length === 0) {
  console.log("No tracked wallets — run `npm run seed:tracked-wallets` first.");
  process.exit(0);
}

function trustTier(row: { strategy_label: string | null; claimed_profit_usd: number | null }): number {
  let t = 1;
  if (row.strategy_label?.startsWith("auto-leaderboard")) t += 1;
  if ((row.claimed_profit_usd ?? 0) > 1_000_000) t += 1;
  if ((row.claimed_profit_usd ?? 0) > 5_000_000) t += 1;
  return Math.min(4, t);
}

const runId = new Date().toISOString();
console.log(`consensus:backtest run_id=${runId} days=${DAYS} window=${WINDOW_MIN}min min_wallets=${MIN_WALLETS} step=${STEP_MIN}min`);
console.log(`  wallets: ${wallets.length}, per-wallet limit: ${PER_WALLET_LIMIT}`);

// Step 1+2: gather all trades, build a unified trade list.
const allTrades: ConsensusTrade[] = [];
for (const w of wallets) {
  try {
    const acts = (await poly.userActivity(w.proxy_wallet, { limit: PER_WALLET_LIMIT })) as any[];
    const trades = acts.filter((a) => String(a.type ?? "TRADE").toUpperCase() === "TRADE");
    const tier = trustTier(w);
    for (const t of trades) {
      const tsRaw = Number(t.timestamp);
      if (!Number.isFinite(tsRaw) || tsRaw <= 0) continue;
      const ms = tsRaw > 1e12 ? tsRaw : tsRaw * 1000;
      // direction = the outcome label the wallet bet on. We map it through
      // the consensus detector's bullish/bearish keyword classifier.
      const direction = String(t.outcome ?? (t.side ?? "")).trim() || "Yes";
      allTrades.push({
        proxyWallet: w.proxy_wallet,
        trustTier: tier,
        marketKey: String(t.conditionId ?? ""),
        marketTitle: t.title ?? undefined,
        direction,
        usd: Number(t.usdcSize ?? 0) || (Number(t.size ?? 0) * Number(t.price ?? 0)),
        price: Number(t.price ?? 0),
        ts: new Date(ms).toISOString(),
      });
    }
  } catch (e) {
    console.warn(`  ${w.proxy_wallet}: ${(e as Error).message}`);
  }
}
console.log(`gathered ${allTrades.length} trades across ${wallets.length} wallets`);

// Sort + bound window
allTrades.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
const nowMs = Date.now();
const startMs = nowMs - DAYS * 86400 * 1000;
const inRange = allTrades.filter((t) => {
  const ms = Date.parse(t.ts);
  return ms >= startMs && ms <= nowMs;
});
console.log(`in-range trades (last ${DAYS}d): ${inRange.length}`);

// Step 3: slide consensus detector through history. Each pass produces 0..N
// signals; dedupe by (marketKey, direction, signal-windowStart-hour).
const seenKey = new Set<string>();
const signals: ConsensusSignal[] = [];
for (let start = startMs; start + WINDOW_MIN * 60_000 <= nowMs; start += STEP_MIN * 60_000) {
  const windowEnd = start + WINDOW_MIN * 60_000;
  const slice = inRange.filter((t) => {
    const ms = Date.parse(t.ts);
    return ms >= start && ms <= windowEnd;
  });
  if (slice.length < MIN_WALLETS) continue;
  // detectConsensus expects "trades older than windowMinutes are ignored" — we
  // supply only the slice, so any positive windowMinutes works.
  const sigs = detectConsensus(slice, {
    windowMinutes: WINDOW_MIN, minWallets: MIN_WALLETS, minCombinedTrust: MIN_TRUST,
  });
  for (const sig of sigs) {
    const hourBucket = Math.floor(Date.parse(sig.windowStart) / (3600 * 1000));
    const key = `${sig.marketKey}|${sig.direction.toLowerCase()}|${hourBucket}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    signals.push(sig);
  }
}
console.log(`unique consensus signals: ${signals.length}`);

if (signals.length === 0) {
  console.log("Nothing to backtest. Try lowering --min or increasing --days.");
  process.exit(0);
}

// Step 4: fetch resolved markets for each signal's marketKey.
const conditionIds = Array.from(new Set(signals.map((s) => s.marketKey).filter(Boolean)));
const resolvedByCondition = new Map<string, ResolvedMarket>();
const CHUNK = 25;
for (let i = 0; i < conditionIds.length; i += CHUNK) {
  const slice = conditionIds.slice(i, i + CHUNK);
  try {
    const markets = await poly.marketsByCondition(slice, { closed: true });
    for (const m of markets) {
      const parsed = parseGammaResolvedMarket(m);
      if (parsed) resolvedByCondition.set(parsed.conditionId, parsed);
    }
  } catch (e) {
    console.warn(`  resolved fetch failed chunk ${i}: ${(e as Error).message}`);
  }
  if (i + CHUNK < conditionIds.length) await new Promise((res) => setTimeout(res, 200));
}
console.log(`resolved markets: ${resolvedByCondition.size}/${conditionIds.length}`);

// Step 5: score.
const result = backtestConsensusSignals(signals, resolvedByCondition, {
  sizeUsd: SIZE_USD,
  slippageBpsTiers: [0, 30, 100, 300],
  minDistinctSignals: 5,
});
console.log(`\nresult: ${result.signals_used}/${result.signals_seen} scorable, best slip=${result.best_slippage_bps}bps → $${result.best_pnl_usd.toFixed(2)}`);
console.log(`verdict: ${result.verdict.rating} — ${result.verdict.reason}`);

// Persist.
const insert = handle.prepare(
  `INSERT INTO consensus_backtest_results
     (run_id, slippage_bps, n_signals, n_wins, win_rate, pnl_usd, pnl_pct,
      avg_winner_multiple, size_usd, fee_bps,
      signals_seen, signals_used,
      signals_skipped_unresolved, signals_skipped_indecipherable,
      verdict_rating, verdict_reason, n_distinct_signals, config_json, notes_json)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const config = JSON.stringify({
  days: DAYS, window_min: WINDOW_MIN, min_wallets: MIN_WALLETS,
  min_trust: MIN_TRUST, step_min: STEP_MIN, per_wallet_limit: PER_WALLET_LIMIT,
});
const tx = handle.transaction(() => {
  for (const b of result.buckets) {
    insert.run(
      runId, b.slippage_bps, b.n_signals, b.n_wins, b.win_rate, b.pnl_usd, b.pnl_pct,
      b.avg_winner_multiple, result.size_usd, result.fee_bps,
      result.signals_seen, result.signals_used,
      result.signals_skipped_unresolved, result.signals_skipped_indecipherable,
      result.verdict.rating, result.verdict.reason, result.verdict.n_distinct_signals,
      config,
      result.notes.length > 0 ? JSON.stringify(result.notes) : null,
    );
  }
});
tx();
console.log(`persisted ${result.buckets.length} bucket rows.`);
