import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { loadSnapshotsForToken, runBacktest, thresholdMeanReversion } from "../src/lib/backtest/engine.ts";
import { insertEvolutionEvent } from "../src/lib/db/queries.ts";

/**
 * CLI: backtest a strategy_version over collected market_snapshots.
 *
 * Usage:
 *   npx tsx scripts/backtest.ts --version 12 --token <token_id>
 *   npx tsx scripts/backtest.ts --version 12 --token <token_id> --buy 0.40 --sell 0.55 --size 50
 *
 * Writes a row to performance_metrics(window='backtest') AND logs a 'backtest'
 * event to evolution_log with the full result payload.
 */

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const versionId = Number(arg("version") ?? 0);
const tokenId = arg("token");
const buyBelow = Number(arg("buy", "0.40"));
const sellAbove = Number(arg("sell", "0.55"));
const size = Number(arg("size", "50"));

if (!versionId || !tokenId) {
  console.error("usage: tsx scripts/backtest.ts --version <id> --token <token_id> [--buy 0.40] [--sell 0.55] [--size 50]");
  process.exit(2);
}

const version = db()
  .prepare("SELECT id, strategy_id, version, stage FROM strategy_versions WHERE id = ?")
  .get(versionId) as { id: number; strategy_id: number; version: number; stage: string } | undefined;
if (!version) {
  console.error(`version ${versionId} not found`);
  process.exit(2);
}

const snaps = loadSnapshotsForToken(tokenId);
if (snaps.length === 0) {
  console.error(`no market_snapshots for token ${tokenId}`);
  process.exit(2);
}

const result = runBacktest(snaps, thresholdMeanReversion({ buyBelow, sellAbove, sizeShares: size }));
console.log(JSON.stringify({
  versionId, tokenId, snapshots: snaps.length,
  buyBelow, sellAbove, size,
  pnlUsd: result.pnlUsd.toFixed(2),
  pnlPct: (result.pnlPct * 100).toFixed(2) + "%",
  trades: result.tradesCount,
  winRate: (result.winRate * 100).toFixed(1) + "%",
  maxDD: (result.maxDrawdownPct * 100).toFixed(2) + "%",
  score: result.score.toFixed(2),
}, null, 2));

db()
  .prepare(
    `INSERT INTO performance_metrics
       (strategy_version_id, window, trades_count, win_rate, total_pnl_usd, sharpe, max_drawdown_usd)
     VALUES (?, 'backtest', ?, ?, ?, NULL, ?)
     ON CONFLICT(strategy_version_id, window)
     DO UPDATE SET trades_count=excluded.trades_count,
                   win_rate=excluded.win_rate,
                   total_pnl_usd=excluded.total_pnl_usd,
                   max_drawdown_usd=excluded.max_drawdown_usd,
                   computed_at=datetime('now')`,
  )
  .run(versionId, result.tradesCount, result.winRate, result.pnlUsd, result.maxDrawdownUsd);

insertEvolutionEvent({
  strategy_id: version.strategy_id,
  to_version_id: version.id,
  event_type: "backtest",
  summary: `backtest v${version.version} on ${tokenId}: pnl=$${result.pnlUsd.toFixed(2)} (${(result.pnlPct * 100).toFixed(1)}%) score=${result.score.toFixed(1)}`,
  payload_json: JSON.stringify({
    versionId, tokenId, params: { buyBelow, sellAbove, size },
    snapshots: snaps.length, result,
  }),
});
