/**
 * Copy-trade backtester runner. Two scoring modes:
 *
 *   1. midpoint   — copy at +lag, hold for H minutes, mark to market against
 *                   the per-token midpoint history (requires active price data)
 *   2. resolved   — settle each copy against the binary outcome of resolved
 *                   markets (works even when price-history is empty)
 *
 *   npm run copy:backtest                           # all tracked wallets
 *   npm run copy:backtest -- --wallet 0x...         # one wallet
 *   npm run copy:backtest -- --skip-midpoint        # resolved-only (fastest)
 *
 * Trade source: `poly.userActivity` (includes TRADE + REDEEM events) rather
 * than `userTrades` — REDEEM rows give us the wallet's actual exit/settlement
 * times. We filter `type==='TRADE'` for the backtest inputs.
 *
 * Read-only against external APIs · write-only against the local DB.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { poly } from "../src/lib/polymarket/client.ts";
import {
  backtestCopyTrades, backtestResolvedOutcomes,
  parseGammaResolvedMarket, type PriceHistorySeries, type ResolvedMarket,
} from "../src/lib/wallets/copy-backtest.ts";
import type { RawTrade } from "../src/lib/wallets/fingerprint.ts";

const argv = process.argv.slice(2);
function flag(name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] ?? null : null;
}
function hasFlag(name: string): boolean {
  return argv.includes(`--${name}`);
}

const onlyWallet = flag("wallet");
const tradeLimit = Number(flag("limit") ?? "300");
const sizeUsd = Number(flag("size") ?? "100");
const slippageBps = Number(flag("slippage-bps") ?? "30");
const lagsSec = (flag("lags") ?? "10,60,300,900").split(",").map((s) => Number(s.trim()));
const holdMinutes = (flag("holds") ?? "60,240,1440").split(",").map((s) => Number(s.trim()));
const slippageTiers = (flag("resolved-slippages") ?? "0,30,100,300").split(",").map((s) => Number(s.trim()));
const skipMidpoint = hasFlag("skip-midpoint");
const skipResolved = hasFlag("skip-resolved");

const handle = db();
const wallets = onlyWallet
  ? handle.prepare("SELECT id, handle, proxy_wallet FROM tracked_wallets WHERE proxy_wallet = ? OR handle = ?").all(onlyWallet, onlyWallet)
  : handle.prepare("SELECT id, handle, proxy_wallet FROM tracked_wallets WHERE proxy_wallet IS NOT NULL").all();

if (wallets.length === 0) {
  console.log("No tracked wallets to backtest. Run `npm run seed:tracked-wallets` first or pass --wallet 0x…");
  process.exit(0);
}

const runId = new Date().toISOString();
console.log(`copy:backtest run_id=${runId} wallets=${wallets.length}`);
console.log(`  midpoint: ${skipMidpoint ? "SKIP" : `lags=[${lagsSec}] holds=[${holdMinutes}] slip=${slippageBps}bps`}`);
console.log(`  resolved: ${skipResolved ? "SKIP" : `slipTiers=[${slippageTiers}]`}`);
console.log(`  size=$${sizeUsd}`);

const insertMidpoint = handle.prepare(
  `INSERT INTO copy_backtest_results
     (run_id, wallet_address, wallet_handle, lag_sec, hold_min,
      n_trades, n_wins, win_rate, pnl_usd, pnl_pct,
      avg_drift_bps, avg_hold_realized_pct,
      size_usd, slippage_bps, fee_bps, trades_seen, trades_used, notes_json)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const insertResolved = handle.prepare(
  `INSERT INTO copy_backtest_resolved
     (run_id, wallet_address, wallet_handle, slippage_bps,
      n_trades, n_wins, win_rate, pnl_usd, pnl_pct, avg_winner_multiple,
      size_usd, fee_bps, trades_seen, trades_used,
      trades_skipped_unresolved, trades_skipped_no_token_match,
      trades_after_dedup, distinct_markets_used, verdict_rating, verdict_reason,
      notes_json)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

for (const w of wallets as Array<{ id: number; handle: string; proxy_wallet: string }>) {
  const address = w.proxy_wallet;
  try {
    console.log(`\n  → ${w.handle} (${address})`);
    // userActivity returns TRADE + REDEEM events together; filter to trades for
    // the backtester inputs. The REDEEM rows are kept in `acts` so we can later
    // surface "real wallet exit time" in the UI (separate work).
    const acts = (await poly.userActivity(address, { limit: tradeLimit })) as Array<RawTrade & { type?: string }>;
    const trades = acts.filter((a) => String(a.type ?? "TRADE").toUpperCase() === "TRADE");
    const redemptions = acts.filter((a) => String(a.type ?? "").toUpperCase().includes("REDEEM"));
    console.log(`    activity: ${acts.length} (${trades.length} trades, ${redemptions.length} redemptions)`);
    if (trades.length === 0) continue;

    // === Resolved-outcome scoring ===
    if (!skipResolved) {
      const conditionIds = Array.from(new Set(trades.map((t) => String(t.conditionId ?? "")).filter(Boolean)));
      const resolvedByCondition = new Map<string, ResolvedMarket>();
      // Gamma /markets refuses chunks bigger than ~50 condition_ids reliably.
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
          console.warn(`    resolved fetch failed for chunk ${i}-${i + slice.length}: ${(e as Error).message}`);
        }
        if (i + CHUNK < conditionIds.length) await new Promise((res) => setTimeout(res, 200));
      }
      console.log(`    resolved markets found: ${resolvedByCondition.size}/${conditionIds.length}`);

      const resolved = backtestResolvedOutcomes(address, trades, resolvedByCondition, {
        slippageBpsTiers: slippageTiers, sizeUsd,
      });
      console.log(`    resolved: used=${resolved.trades_used} unresolved=${resolved.trades_skipped_unresolved} · best slip=${resolved.best_slippage_bps}bps → $${resolved.best_pnl_usd.toFixed(2)}`);

      const tx = handle.transaction(() => {
        for (const b of resolved.buckets) {
          insertResolved.run(
            runId, address, w.handle, b.slippage_bps,
            b.n_trades, b.n_wins, b.win_rate, b.pnl_usd, b.pnl_pct, b.avg_winner_multiple,
            resolved.size_usd, resolved.fee_bps,
            resolved.trades_seen, resolved.trades_used,
            resolved.trades_skipped_unresolved, resolved.trades_skipped_no_token_match,
            resolved.trades_after_dedup, resolved.distinct_markets_used,
            resolved.verdict.rating, resolved.verdict.reason,
            resolved.notes.length > 0 ? JSON.stringify(resolved.notes) : null,
          );
        }
      });
      tx();
      console.log(`    verdict: ${resolved.verdict.rating} (${resolved.verdict.reason})`);
    }

    // === Midpoint scoring (price-history based) ===
    if (!skipMidpoint) {
      const tokens = Array.from(new Set(trades.map((t) => String(t.asset ?? "")).filter(Boolean)));
      const seriesByToken = new Map<string, PriceHistorySeries>();
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        try {
          const r = await poly.pricesHistory(token, "max", 1);
          if (r?.history?.length >= 2) seriesByToken.set(token, { tokenId: token, points: r.history });
        } catch {}
        if (i > 0 && i % 5 === 0) await new Promise((res) => setTimeout(res, 200));
      }
      console.log(`    midpoint price series: ${seriesByToken.size}/${tokens.length} tokens`);

      // Build the redemption map: conditionId → unix-seconds of when the
      // wallet redeemed that market. Powers the natural-hold bucket.
      const redemptionByCondition = new Map<string, number>();
      for (const r of redemptions) {
        const c = String((r as any).conditionId ?? "");
        const ts = Number((r as any).timestamp);
        if (c && Number.isFinite(ts)) redemptionByCondition.set(c, ts);
      }
      if (redemptionByCondition.size > 0) {
        console.log(`    redemption exits available for ${redemptionByCondition.size} conditions`);
      }

      const result = backtestCopyTrades(address, trades, seriesByToken, {
        lagsSec, holdMinutes, sizeUsd, slippageBps,
        redemptionByCondition: redemptionByCondition.size > 0 ? redemptionByCondition : undefined,
      });
      console.log(`    midpoint: used=${result.trades_used} · best (lag=${result.best_lag_sec}s, hold=${result.best_hold_min}min) → $${result.best_pnl_usd.toFixed(2)}`);

      const tx = handle.transaction(() => {
        for (const b of result.buckets) {
          insertMidpoint.run(
            runId, address, w.handle, b.lag_sec, b.hold_min,
            b.n_trades, b.n_wins, b.win_rate, b.pnl_usd, b.pnl_pct,
            b.avg_drift_bps, b.avg_hold_realized_pct,
            result.size_usd, result.slippage_bps, result.fee_bps,
            result.trades_seen, result.trades_used,
            result.notes.length > 0 ? JSON.stringify(result.notes) : null,
          );
        }
      });
      tx();
    }
  } catch (e) {
    console.error(`    failed: ${(e as Error).message}`);
  }
}

console.log("\ndone.");
