/**
 * Wallet performance stats joined against market category — gates the
 * wallet_copy_filtered genome per the Lunar article's Mental Bug #4:
 *
 *   "A wallet has 91% win rate on crypto and 15% on politics. Copying
 *    everything = net negative. Filter by category. Copy only dominance."
 *
 * We don't have resolved outcomes here (would need a separate resolution
 * pipeline), so "win rate" is approximated as fraction of fills whose
 * implied_price moved in the wallet's favor between entry and the most
 * recent market_snapshot for the same token. Approximate but directional.
 *
 * Spec: `docs/prds/lunar-inspired-arena-strategies.md` §6.3.R3 + IMPLEMENTATION
 * Phase 4.
 */
import { db } from "@/lib/db/client";

export type WalletCategoryStats = {
  wallet: string;
  category: string;
  trades_count: number;
  /** Fraction of trades currently in profit per latest snapshot (0..1).
   *  Approximate — counts "trade made money so far" rather than "trade resolved
   *  profitable." Good enough as a wallet-quality proxy in a given category. */
  win_rate: number;
  /** Total volume in USD across the window. */
  volume_usd: number;
};

const WALLET_STATS_SQL = `
  WITH wallet_trades AS (
    SELECT
      f.wallet,
      f.token_id,
      f.implied_price AS entry_price,
      f.implied_usd  AS notional,
      f.created_at,
      -- which side did the wallet take? if side_of_wallet=maker, they were on maker_side;
      -- else they were on the opposite. Encoded as: 1=BUY-YES, 0=SELL-YES.
      CASE
        WHEN f.side_of_wallet = 'maker' AND f.maker_side = 'BUY' THEN 1
        WHEN f.side_of_wallet = 'maker' AND f.maker_side = 'SELL' THEN 0
        WHEN f.side_of_wallet = 'taker' AND f.maker_side = 'BUY' THEN 0
        WHEN f.side_of_wallet = 'taker' AND f.maker_side = 'SELL' THEN 1
      END AS wallet_buy_yes
    FROM wallet_fills f
    WHERE f.wallet = ?
      AND f.created_at >= datetime('now', '-' || ? || ' days')
  ),
  latest_snap AS (
    SELECT token_id, MAX(captured_at) AS last_at
      FROM market_snapshots GROUP BY token_id
  ),
  joined AS (
    SELECT
      wt.*,
      ms.midpoint AS latest_price,
      ms.category
    FROM wallet_trades wt
    LEFT JOIN latest_snap ls ON ls.token_id = wt.token_id
    LEFT JOIN market_snapshots ms ON ms.token_id = wt.token_id AND ms.captured_at = ls.last_at
  )
  SELECT
    category,
    COUNT(*) AS trades_count,
    SUM(notional) AS volume_usd,
    AVG(CASE
      WHEN latest_price IS NULL THEN NULL
      WHEN wallet_buy_yes = 1 AND latest_price > entry_price THEN 1.0
      WHEN wallet_buy_yes = 0 AND latest_price < entry_price THEN 1.0
      ELSE 0.0
    END) AS win_rate
  FROM joined
  WHERE category IS NOT NULL
  GROUP BY category
`;

/**
 * Returns per-category stats for a wallet over the last N days. Empty array
 * when the wallet has no fills or no fills join to a categorized market.
 */
export function walletStatsByCategory(walletAddress: string, days = 30): WalletCategoryStats[] {
  const rows = db().prepare(WALLET_STATS_SQL).all(walletAddress, days) as Array<{
    category: string; trades_count: number; volume_usd: number; win_rate: number | null;
  }>;
  return rows.map((r) => ({
    wallet: walletAddress,
    category: r.category,
    trades_count: r.trades_count,
    win_rate: r.win_rate ?? 0,
    volume_usd: r.volume_usd ?? 0,
  }));
}

/**
 * Single-category lookup. Returns null when the wallet has no fills in that
 * category — caller treats as "no signal, hold."
 */
export function walletWinRateByCategory(walletAddress: string, category: string, days = 30): WalletCategoryStats | null {
  const all = walletStatsByCategory(walletAddress, days);
  return all.find((s) => s.category === category) ?? null;
}

/**
 * Read the wallet's most recent fills inside a delay window. Used by the
 * `wallet_copy_filtered` genome — we copy trades that happened in the last
 * `delay_min` minutes. Filter by category at the join level so we only get
 * fills in the genome's target category.
 */
export type RecentFill = {
  token_id: string;
  side: "BUY" | "SELL";       // wallet's side (BUY-YES = BUY, SELL-YES = SELL)
  price: number;
  size_usd: number;
  category: string | null;
  filled_at: string;
};

export function recentFillsForWalletInCategory(walletAddress: string, category: string, maxAgeMin: number): RecentFill[] {
  const rows = db().prepare(`
    WITH latest_snap AS (
      SELECT token_id, MAX(captured_at) AS last_at FROM market_snapshots GROUP BY token_id
    )
    SELECT
      f.token_id,
      CASE
        WHEN f.side_of_wallet = 'maker' AND f.maker_side = 'BUY' THEN 'BUY'
        WHEN f.side_of_wallet = 'maker' AND f.maker_side = 'SELL' THEN 'SELL'
        WHEN f.side_of_wallet = 'taker' AND f.maker_side = 'BUY' THEN 'SELL'
        WHEN f.side_of_wallet = 'taker' AND f.maker_side = 'SELL' THEN 'BUY'
      END AS side,
      f.implied_price AS price,
      f.implied_usd  AS size_usd,
      ms.category,
      f.created_at AS filled_at
    FROM wallet_fills f
    LEFT JOIN latest_snap ls ON ls.token_id = f.token_id
    LEFT JOIN market_snapshots ms ON ms.token_id = f.token_id AND ms.captured_at = ls.last_at
    WHERE f.wallet = ?
      AND ms.category = ?
      AND f.created_at >= datetime('now', '-' || ? || ' minutes')
    ORDER BY f.created_at DESC
    LIMIT 20
  `).all(walletAddress, category, maxAgeMin) as RecentFill[];
  return rows;
}
