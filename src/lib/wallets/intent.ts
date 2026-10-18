/**
 * Wallet intent classifier — short-window inference of what a wallet is
 * doing RIGHT NOW. Complements fingerprint (long-run strategy) and
 * consensus (cross-wallet agreement).
 *
 * Labels:
 *   - accumulation:    ≥85% BUY on ≤2 markets, building exposure
 *   - distribution:    ≥85% SELL on ≤2 markets, reducing exposure
 *   - basket_rotation: ≥3 distinct markets in window — the @0xb55fa pattern
 *   - scalp:           single market with both BUY and SELL inside window
 *   - news_fade:       large trade against extreme price (>0.85 or <0.15)
 *   - idle:            no trades in window
 *   - mixed:           no dominant signal
 *
 * Pure function. Caller supplies trades + window. No DB, no HTTP.
 *
 * Use cases:
 *   - operator UI ("what's this wallet up to right now?")
 *   - consensus weighting (a "basket_rotation" agreement is weaker than 5
 *     independent "accumulation" agreements on the same market)
 *   - alerts ("tracked wallet just switched from accumulation to distribution")
 */

export type IntentTrade = {
  marketKey: string;
  side: "BUY" | "SELL";
  outcome?: string;
  price: number;
  usd: number;
  ts: string;
};

export type IntentLabel =
  | "accumulation"
  | "distribution"
  | "basket_rotation"
  | "scalp"
  | "news_fade"
  | "idle"
  | "mixed";

export type WalletIntent = {
  label: IntentLabel;
  confidence: number;
  reasons: string[];
  windowMinutes: number;
  tradesObserved: number;
  distinctMarkets: number;
  buyShare: number;
  sellShare: number;
  totalUsd: number;
};

export type IntentOptions = {
  windowMinutes?: number;
  /** Override "now" for testability. */
  nowMs?: number;
};

export function classifyIntent(trades: IntentTrade[], opts: IntentOptions = {}): WalletIntent {
  const windowMinutes = opts.windowMinutes ?? 60;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = nowMs - windowMinutes * 60_000;

  const recent = trades.filter((t) => {
    const ms = Date.parse(t.ts);
    return Number.isFinite(ms) && ms >= cutoff;
  });

  if (recent.length === 0) {
    return {
      label: "idle",
      confidence: 1,
      reasons: ["no trades in window"],
      windowMinutes,
      tradesObserved: 0,
      distinctMarkets: 0,
      buyShare: 0,
      sellShare: 0,
      totalUsd: 0,
    };
  }

  const totalUsd = recent.reduce((s, t) => s + t.usd, 0);
  const buyCount = recent.filter((t) => t.side === "BUY").length;
  const sellCount = recent.filter((t) => t.side === "SELL").length;
  const buyShare = buyCount / recent.length;
  const sellShare = sellCount / recent.length;
  const distinctMarkets = new Set(recent.map((t) => t.marketKey)).size;
  const base = {
    windowMinutes,
    tradesObserved: recent.length,
    distinctMarkets,
    buyShare,
    sellShare,
    totalUsd,
  };

  if (recent.length < 3) {
    return {
      label: "mixed",
      confidence: 0.3,
      reasons: [`only ${recent.length} trade(s) in window — too few to classify`],
      ...base,
    };
  }

  // Basket rotation has highest priority — distinguishes correlated-basket bots
  // from a wallet that happens to be accumulating across several markets.
  if (distinctMarkets >= 3 && recent.length >= 5) {
    return {
      label: "basket_rotation",
      confidence: 0.85,
      reasons: [
        `${distinctMarkets} distinct markets in ${windowMinutes}min`,
        `${recent.length} trades, total $${totalUsd.toFixed(0)}`,
      ],
      ...base,
    };
  }

  if (buyShare >= 0.85 && distinctMarkets <= 2 && recent.length >= 4) {
    return {
      label: "accumulation",
      confidence: 0.85,
      reasons: [
        `${(buyShare * 100).toFixed(0)}% buys on ${distinctMarkets} market(s)`,
        `total deployed $${totalUsd.toFixed(0)}`,
      ],
      ...base,
    };
  }

  if (sellShare >= 0.85 && distinctMarkets <= 2 && recent.length >= 3) {
    return {
      label: "distribution",
      confidence: 0.85,
      reasons: [
        `${(sellShare * 100).toFixed(0)}% sells on ${distinctMarkets} market(s)`,
        `total released $${totalUsd.toFixed(0)}`,
      ],
      ...base,
    };
  }

  if (distinctMarkets === 1 && buyShare >= 0.25 && sellShare >= 0.25) {
    return {
      label: "scalp",
      confidence: 0.7,
      reasons: [`single market with ${buyCount} BUY + ${sellCount} SELL in ${windowMinutes}min`],
      ...base,
    };
  }

  // News-fade detector: one trade clearly dominates the others (≥5× next-biggest)
  // and is at an extreme price. Using "next-biggest" instead of "avg" avoids the
  // pathological case where the big trade itself inflates the avg.
  const sortedUsd = [...recent].map((t) => t.usd).sort((a, b) => b - a);
  const biggestUsd = sortedUsd[0] ?? 0;
  const secondBiggestUsd = sortedUsd[1] ?? 0;
  const largeExtreme = recent.find(
    (t) =>
      t.usd === biggestUsd &&
      t.usd >= 1000 &&
      t.usd >= Math.max(100, secondBiggestUsd * 5) &&
      (t.price <= 0.15 || t.price >= 0.85),
  );
  if (largeExtreme) {
    return {
      label: "news_fade",
      confidence: 0.6,
      reasons: [
        `large $${largeExtreme.usd.toFixed(0)} ${largeExtreme.side} at extreme price ${largeExtreme.price.toFixed(2)}`,
      ],
      ...base,
    };
  }

  return {
    label: "mixed",
    confidence: 0.4,
    reasons: [
      `${recent.length} trades across ${distinctMarkets} markets; buy ${(buyShare * 100).toFixed(0)}% / sell ${(sellShare * 100).toFixed(0)}%; no dominant pattern`,
    ],
    ...base,
  };
}
