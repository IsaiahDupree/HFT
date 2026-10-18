import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { loadRecentCandles, velocity, acceleration } from "@/lib/arena/momentum";
import { computeCrossVenueImpliedProbs } from "@/lib/arena/cross-venue";

export const dynamic = "force-dynamic";

const DEFAULT_PRODUCTS = (process.env.ARENA_SNAPSHOT_CB_PRODUCTS ?? "BTC-USD,ETH-USD,SOL-USD")
  .split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Composed payload for /crypto:
 *  - per Coinbase product: latest mid/bid/ask + 1h/24h % change + 5/15-min velocity
 *    + acceleration + last 60 candle closes for sparkline
 *  - active Polymarket Crypto markets snapshotted in the last hour
 *  - cross-venue insights: BS-implied vs Polymarket-implied for any active pairings
 */
export async function GET() {
  const products = DEFAULT_PRODUCTS;
  const productPanels = products.map((pid) => {
    const candles = loadRecentCandles(pid, 240); // 4 hours of 1-min
    const closes = candles.map((c) => c.close);
    const latest = candles[candles.length - 1];
    const cbSnap = db().prepare(
      `SELECT best_bid, best_ask, midpoint, spread, volume_24h, price_24h_change_pct, captured_at
       FROM coinbase_snapshots WHERE product_id = ? ORDER BY captured_at DESC LIMIT 1`,
    ).get(pid) as { best_bid: number | null; best_ask: number | null; midpoint: number | null; spread: number | null; volume_24h: number | null; price_24h_change_pct: number | null; captured_at: string } | undefined;
    const v5 = velocity(candles, 5);
    const v15 = velocity(candles, 15);
    const v60 = velocity(candles, 60);
    const a5 = acceleration(candles, 5);
    const a15 = acceleration(candles, 15);
    return {
      product_id: pid,
      price: latest?.close ?? cbSnap?.midpoint ?? null,
      best_bid: cbSnap?.best_bid ?? null,
      best_ask: cbSnap?.best_ask ?? null,
      spread: cbSnap?.spread ?? null,
      volume_24h: cbSnap?.volume_24h ?? null,
      change_24h_pct: cbSnap?.price_24h_change_pct ?? null,
      vel_5m_pct: Number.isFinite(v5) ? v5 : null,
      vel_15m_pct: Number.isFinite(v15) ? v15 : null,
      vel_60m_pct: Number.isFinite(v60) ? v60 : null,
      accel_5m_pct: Number.isFinite(a5) ? a5 : null,
      accel_15m_pct: Number.isFinite(a15) ? a15 : null,
      candles_count: closes.length,
      sparkline_closes: closes.slice(-60),
      last_candle_at: latest ? new Date(latest.start_unix * 1000).toISOString() : null,
      last_snapshot_at: cbSnap?.captured_at ?? null,
    };
  });

  // Active Polymarket Crypto markets — use most-recent snapshot per token_id.
  const polyMarkets = db().prepare(
    `SELECT token_id, question, midpoint, spread, volume_24h, MAX(captured_at) AS last_seen
       FROM market_snapshots
       WHERE captured_at >= datetime('now', '-2 hours') AND midpoint IS NOT NULL
       GROUP BY token_id
       ORDER BY volume_24h DESC NULLS LAST, last_seen DESC
       LIMIT 30`,
  ).all() as Array<{ token_id: string; question: string; midpoint: number; spread: number | null; volume_24h: number | null; last_seen: string }>;

  // Cross-venue: BS prob vs Polymarket prob for any active price_threshold pairings.
  const { bsImpliedProb, polyImpliedProb } = computeCrossVenueImpliedProbs(new Date());
  const pairings = db().prepare(
    `SELECT poly_condition_id, poly_question, coinbase_product_id, threshold_value, threshold_direction, expiry_iso
       FROM cross_venue_arbs WHERE active = 1 AND pairing_kind = 'price_threshold'`,
  ).all() as Array<{ poly_condition_id: string; poly_question: string | null; coinbase_product_id: string; threshold_value: number | null; threshold_direction: string | null; expiry_iso: string | null }>;
  const insights = pairings.map((p) => {
    const bsProb = bsImpliedProb.get(p.poly_condition_id) ?? null;
    const pmProb = polyImpliedProb.get(p.poly_condition_id) ?? null;
    return {
      poly_condition_id: p.poly_condition_id,
      poly_question: p.poly_question,
      coinbase_product_id: p.coinbase_product_id,
      threshold_value: p.threshold_value,
      threshold_direction: p.threshold_direction,
      expiry_iso: p.expiry_iso,
      bs_implied_prob: bsProb,
      poly_implied_prob: pmProb,
      spread_pts: bsProb != null && pmProb != null ? (pmProb - bsProb) * 100 : null,
    };
  });

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    coinbase: productPanels,
    polymarket_crypto_markets: polyMarkets,
    cross_venue_insights: insights,
  });
}
