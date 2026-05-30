import Link from "next/link";
import { db } from "@/lib/db/client";
import { poly } from "@/lib/polymarket/client";

export const dynamic = "force-dynamic";
export const revalidate = 60;

type Row = {
  id: number;
  handle: string;
  proxy_wallet: string | null;
  strategy_label: string | null;
  claimed_profit_usd: number | null;
  last_resolved: string | null;
};

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}

export default async function TrackedPage() {
  const rows = db().prepare("SELECT * FROM tracked_wallets ORDER BY COALESCE(claimed_profit_usd, 0) DESC").all() as Row[];

  // For each resolved wallet, pull a quick live snapshot of recent trades + portfolio value.
  const enriched = await Promise.all(rows.map(async (r) => {
    if (!r.proxy_wallet) return { ...r, value: null as any, trades: [] as any[] };
    const [value, trades] = await Promise.all([
      safe(() => poly.userValue(r.proxy_wallet!)),
      safe(() => poly.userTrades(r.proxy_wallet!, { limit: 3 })),
    ]);
    return { ...r, value, trades: trades ?? [] };
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Tracked wallets</h1>
        <p className="text-zinc-400 text-sm mt-1">
          15 wallets from the <Link className="text-accent-blue" href="/research">0x_Discover Polymarket arb article</Link>,
          resolved to their on-chain proxy wallets via Gamma leaderboard. <strong>Observe-only</strong> — the article
          documents why naive copy-trading nets negative.
        </p>
      </div>

      <div className="card overflow-x-auto">
        <table className="list">
          <thead>
            <tr>
              <th>Handle</th>
              <th>Strategy (claimed)</th>
              <th>Claimed PnL</th>
              <th>Live portfolio</th>
              <th>Recent</th>
              <th>Proxy wallet</th>
            </tr>
          </thead>
          <tbody>
            {enriched.map((r) => (
              <tr key={r.id}>
                <td className="text-zinc-100">{r.handle}</td>
                <td className="text-xs text-zinc-400 max-w-xs">{r.strategy_label}</td>
                <td className="tabular-nums text-accent-green">${(r.claimed_profit_usd ?? 0).toLocaleString()}</td>
                <td className="tabular-nums">{r.value && (r.value as any).value !== undefined ? `$${Number((r.value as any).value).toLocaleString()}` : "—"}</td>
                <td className="text-xs text-zinc-400">
                  {r.trades.length > 0
                    ? r.trades.slice(0, 2).map((t: any, i: number) => (
                        <div key={i} className="whitespace-nowrap">
                          {t.side} {t.outcome} @{Number(t.price ?? 0).toFixed(2)}
                        </div>
                      ))
                    : r.proxy_wallet ? "(no recent trades)" : "(unresolved)"}
                </td>
                <td>
                  {r.proxy_wallet ? (
                    <div className="flex flex-col gap-0.5">
                      <Link
                        href={`/wallets/${r.proxy_wallet}`}
                        className="font-mono text-xs text-accent-blue hover:underline"
                        title="open fingerprint view"
                      >
                        {r.proxy_wallet.slice(0, 8)}…{r.proxy_wallet.slice(-4)}
                      </Link>
                      <a
                        className="text-[10px] text-zinc-500 hover:text-zinc-300"
                        href={`https://polygonscan.com/address/${r.proxy_wallet}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        polygonscan ↗
                      </a>
                    </div>
                  ) : <span className="text-xs text-zinc-500">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 className="card-title">Why observe-only?</h2>
        <p className="text-xs text-zinc-400 leading-relaxed">
          Per the source article: by the time a fast wallet's trade is visible on-chain (block N+1), the
          arbitrage they captured is gone — your fill price will be worse than theirs and you'll provide exit
          liquidity. The point of tracking these is to <strong>learn from them</strong>: cross-reference their
          entries with our own price-history feeds, see which categories they concentrate in, and what hold
          durations correlate with their wins. That's the input to a real evaluator.
        </p>
      </div>
    </div>
  );
}
