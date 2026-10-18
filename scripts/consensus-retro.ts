/**
 * Retroactive consensus backtester.
 *
 *   npm run consensus:retro              # 2-wallet, trust≥2, $100 copy
 *   npm run consensus:retro -- --min 3 --trust 4 --size 200
 *
 * Pulls each tracked wallet's `/closed-positions` (resolved markets where the
 * wallet had stakes), groups by (conditionId, outcomeIndex), emits a signal
 * whenever ≥`--min` wallets agreed on the same side, and scores the implied
 * copy-bet against the resolved outcome (curPrice ∈ {0,1}).
 *
 * Bypasses the active-market bias that left `consensus:backtest` at
 * insufficient_data: every signal here is *already* settled.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import {
  detectRetroactiveConsensus, scoreRetroactiveSignals,
  type ClosedPositionInput,
} from "../src/lib/wallets/retroactive-consensus.ts";

const argv = process.argv.slice(2);
function flag(name: string, fallback: number): number {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1]) return Number(argv[i + 1]);
  return fallback;
}

const MIN_WALLETS = flag("min", 2);
const MIN_TRUST = flag("trust", 2);
const MIN_USD = flag("usd", 0);
const SIZE_USD = flag("size", 100);
const PER_WALLET_LIMIT = flag("limit", 200);

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
console.log(`consensus:retro run_id=${runId} wallets=${wallets.length} min=${MIN_WALLETS} trust=${MIN_TRUST} size=$${SIZE_USD}`);

// Fetch closed positions per wallet.
const allClosed: ClosedPositionInput[] = [];
for (const w of wallets) {
  try {
    const url = `https://data-api.polymarket.com/closed-positions?user=${w.proxy_wallet}&limit=${PER_WALLET_LIMIT}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`  ${w.proxy_wallet}: HTTP ${res.status}`);
      continue;
    }
    const rows = (await res.json()) as any[];
    const tier = trustTier(w);
    for (const r of rows) {
      const cond = String(r.conditionId ?? "");
      const outIdx = Number(r.outcomeIndex);
      const avgPx = Number(r.avgPrice);
      const curPx = Number(r.curPrice);
      const totBought = Number(r.totalBought);
      if (!cond || !Number.isFinite(outIdx)) continue;
      allClosed.push({
        proxyWallet: w.proxy_wallet,
        trustTier: tier,
        conditionId: cond,
        outcomeIndex: outIdx,
        outcome: typeof r.outcome === "string" ? r.outcome : undefined,
        avgPrice: avgPx,
        curPrice: curPx,
        totalBought: totBought,
        realizedPnl: Number(r.realizedPnl ?? 0),
        title: typeof r.title === "string" ? r.title : undefined,
      });
    }
  } catch (e) {
    console.warn(`  ${w.proxy_wallet}: ${(e as Error).message}`);
  }
}
console.log(`gathered ${allClosed.length} closed-position rows across ${wallets.length} wallets`);

const signals = detectRetroactiveConsensus(allClosed, {
  minWallets: MIN_WALLETS, minCombinedTrust: MIN_TRUST, minCombinedUsd: MIN_USD,
});
console.log(`detected ${signals.length} retroactive consensus signals (${signals.filter((s) => s.won).length} winning, ${signals.filter((s) => !s.won).length} losing)`);

const result = scoreRetroactiveSignals(signals, {
  sizeUsd: SIZE_USD, slippageBpsTiers: [0, 30, 100, 300], minDistinctSignals: 5,
});
console.log(`\nverdict: ${result.verdict.rating} — ${result.verdict.reason}`);
console.log(`best slip=${result.best_slippage_bps}bps → $${result.best_pnl_usd.toFixed(2)}`);
console.log(`buckets:`);
for (const b of result.buckets) {
  console.log(`  slip=${b.slippage_bps}bps n=${b.n_signals} wins=${b.n_wins} win%=${(b.win_rate * 100).toFixed(0)} pnl=$${b.pnl_usd.toFixed(2)} pnl%=${(b.pnl_pct * 100).toFixed(1)}`);
}

// Persist signals + buckets.
const insertSig = handle.prepare(
  `INSERT INTO retroactive_consensus_signals
     (run_id, condition_id, market_title, outcome_index, outcome,
      won, wallet_count, combined_trust, combined_usd, consensus_avg_price, wallets_json)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const insertBucket = handle.prepare(
  `INSERT INTO retroactive_consensus_buckets
     (run_id, slippage_bps, n_signals, n_wins, win_rate, pnl_usd, pnl_pct,
      avg_winner_multiple, size_usd,
      verdict_rating, verdict_reason, n_distinct_signals, config_json)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

const config = JSON.stringify({
  min_wallets: MIN_WALLETS, min_trust: MIN_TRUST, min_usd: MIN_USD,
  per_wallet_limit: PER_WALLET_LIMIT, wallets_scanned: wallets.length,
});

const tx = handle.transaction(() => {
  for (const sig of signals) {
    insertSig.run(
      runId, sig.conditionId, sig.marketTitle ?? null, sig.outcomeIndex, sig.outcome ?? null,
      sig.won ? 1 : 0, sig.walletCount, sig.combinedTrust, sig.combinedUsd, sig.consensusAvgPrice,
      JSON.stringify(sig.wallets),
    );
  }
  for (const b of result.buckets) {
    insertBucket.run(
      runId, b.slippage_bps, b.n_signals, b.n_wins, b.win_rate, b.pnl_usd, b.pnl_pct,
      b.avg_winner_multiple, result.size_usd,
      result.verdict.rating, result.verdict.reason, result.verdict.n_distinct_signals,
      config,
    );
  }
});
tx();
console.log(`\npersisted ${signals.length} signals + ${result.buckets.length} bucket rows.`);
