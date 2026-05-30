import Link from "next/link";

export type SimilarMarket = {
  productId: string;        // "ETH-USD"
  upProbability: number | null;
};

/**
 * Sidebar list of "similar markets" — the other coins' Up% at a glance.
 * Each item links to its own deep-dive page. Mirrors the right-side widget
 * on the Polymarket market-detail page.
 */
export function SimilarMarketsPanel({ markets, currentSymbol }: { markets: SimilarMarket[]; currentSymbol: string }) {
  const NAMES: Record<string, string> = {
    "BTC-USD": "Bitcoin",
    "ETH-USD": "Ethereum",
    "SOL-USD": "Solana",
    "XRP-USD": "XRP",
    "DOGE-USD": "Dogecoin",
  };
  return (
    <div className="card">
      <h3 className="card-title">Similar markets</h3>
      <ul className="space-y-2">
        {markets.filter((m) => m.productId !== currentSymbol).map((m) => {
          const sym = m.productId.split("-")[0];
          const pct = m.upProbability != null ? `${Math.round(m.upProbability * 100)}%` : "—";
          return (
            <li key={m.productId}>
              <Link href={`/crypto/${m.productId}`} className="row-link flex items-baseline justify-between">
                <span className="text-zinc-200 text-sm">
                  <span className="font-semibold">{NAMES[m.productId] ?? sym}</span> Up or Down — 5 Min
                </span>
                <span className="text-right">
                  <span className="block text-sm font-mono tabular-nums text-zinc-100">{pct}</span>
                  <span className="block text-[10px] uppercase tracking-wider text-accent-green">Up</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
