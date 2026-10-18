/**
 * Server component that fetches the live Polymarket portfolio for the
 * configured proxy address and renders it on /arena. This is the source of
 * truth for "real money state" — the capsule columns in our DB carry a mix
 * of sim and live PnL that confuses the operator.
 *
 * Routed through Webshare proxy via polyFetch (Polymarket geoblocks US IPs).
 * Tolerant of fetch failures: returns a small "—" placeholder rather than
 * crashing the page.
 */
import { polyFetch } from "@/lib/polymarket/proxy-routing";

type Position = {
  conditionId: string;
  asset: string;
  title?: string;
  outcome?: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  curPrice: number;
  eventSlug?: string;
};

type Activity = {
  timestamp: number;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  usdcSize: number;
  title?: string;
  transactionHash: string;
};

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const r = await polyFetch(url, { signal: AbortSignal.timeout(6_000) });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export async function LivePortfolioCard({ funderAddress }: { funderAddress: string }) {
  if (!funderAddress) {
    return (
      <section className="card border-zinc-700/40 bg-ink-900/30">
        <h2 className="card-title">Live Polymarket portfolio</h2>
        <p className="text-xs text-zinc-500">POLYMARKET_FUNDER_ADDRESS not configured.</p>
      </section>
    );
  }

  const addr = funderAddress.toLowerCase();
  const [valueResp, positions, activity] = await Promise.all([
    fetchJson<Array<{ user: string; value: number }>>(`https://data-api.polymarket.com/value?user=${addr}`),
    fetchJson<Position[]>(`https://data-api.polymarket.com/positions?user=${addr}&limit=10`),
    fetchJson<Activity[]>(`https://data-api.polymarket.com/activity?user=${addr}&limit=8&type=TRADE`),
  ]);

  const totalValue = valueResp?.[0]?.value ?? 0;
  const openPositions = positions ?? [];
  const totalUnrealized = openPositions.reduce((s, p) => s + (p.cashPnl ?? 0), 0);
  const fills = activity ?? [];

  const fmt = (n: number) => `${n >= 0 ? "" : "−"}$${Math.abs(n).toFixed(2)}`;
  const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

  return (
    <section className="card border-accent-green/30 bg-accent-green/5">
      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-3">
        <h2 className="card-title m-0 text-accent-green">💰 Live Polymarket portfolio</h2>
        <span className="text-[10px] text-zinc-500 tabular-nums">
          proxy {funderAddress.slice(0, 6)}…{funderAddress.slice(-4)} · source: data-api.polymarket.com
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div className="rounded border border-ink-700 bg-ink-900/40 p-2">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wide">Portfolio value</div>
          <div className="text-xl tabular-nums text-zinc-100">${totalValue.toFixed(2)}</div>
        </div>
        <div className="rounded border border-ink-700 bg-ink-900/40 p-2">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wide">Unrealized P/L</div>
          <div className={`text-xl tabular-nums ${totalUnrealized >= 0 ? "text-accent-green" : "text-accent-red"}`}>
            {fmt(totalUnrealized)}
          </div>
        </div>
        <div className="rounded border border-ink-700 bg-ink-900/40 p-2">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wide">Open positions</div>
          <div className="text-xl tabular-nums text-zinc-100">{openPositions.length}</div>
        </div>
        <div className="rounded border border-ink-700 bg-ink-900/40 p-2">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wide">Fills (recent)</div>
          <div className="text-xl tabular-nums text-zinc-100">{fills.length}</div>
        </div>
      </div>

      {openPositions.length > 0 && (
        <div className="mb-3">
          <h3 className="text-xs text-zinc-400 mb-1.5">Open positions</h3>
          <table className="list text-xs">
            <thead>
              <tr>
                <th>Market</th>
                <th>Side</th>
                <th className="text-right">Shares</th>
                <th className="text-right">Avg in</th>
                <th className="text-right">Now</th>
                <th className="text-right">Value</th>
                <th className="text-right">P/L</th>
                <th className="text-right">%</th>
              </tr>
            </thead>
            <tbody>
              {openPositions.map((p) => (
                <tr key={p.conditionId + p.outcome}>
                  <td className="text-zinc-100">{(p.title ?? p.asset).slice(0, 38)}</td>
                  <td className={`text-[10px] px-1 rounded inline-block ${p.outcome === "Up" || p.outcome === "Yes" ? "bg-accent-green/15 text-accent-green" : "bg-accent-red/15 text-accent-red"}`}>{p.outcome}</td>
                  <td className="text-right tabular-nums text-zinc-300">{p.size?.toFixed(2)}</td>
                  <td className="text-right tabular-nums text-zinc-400">${p.avgPrice?.toFixed(3)}</td>
                  <td className="text-right tabular-nums text-zinc-400">${p.curPrice?.toFixed(3)}</td>
                  <td className="text-right tabular-nums text-zinc-200">${p.currentValue?.toFixed(2)}</td>
                  <td className={`text-right tabular-nums ${(p.cashPnl ?? 0) >= 0 ? "text-accent-green" : "text-accent-red"}`}>{fmt(p.cashPnl ?? 0)}</td>
                  <td className={`text-right tabular-nums ${(p.percentPnl ?? 0) >= 0 ? "text-accent-green" : "text-accent-red"}`}>{fmtPct(p.percentPnl ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {fills.length > 0 && (
        <div>
          <h3 className="text-xs text-zinc-400 mb-1.5">Recent fills</h3>
          <table className="list text-xs">
            <thead>
              <tr>
                <th>When</th>
                <th>Side</th>
                <th className="text-right">Shares @ price</th>
                <th className="text-right">USDC</th>
                <th>Market</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {fills.map((a) => {
                const when = new Date(a.timestamp * 1000).toISOString().replace("T", " ").slice(5, 19);
                return (
                  <tr key={a.transactionHash}>
                    <td className="tabular-nums text-zinc-400">{when}</td>
                    <td className={`text-[10px] ${a.side === "BUY" ? "text-accent-green" : "text-accent-red"}`}>{a.side}</td>
                    <td className="text-right tabular-nums text-zinc-300">{a.size?.toFixed(2)} @ ${a.price?.toFixed(4)}</td>
                    <td className="text-right tabular-nums text-zinc-300">${a.usdcSize?.toFixed(2)}</td>
                    <td className="text-zinc-400">{(a.title ?? "").slice(0, 32)}</td>
                    <td>
                      <a className="text-[10px] text-accent-blue hover:underline" target="_blank" rel="noopener noreferrer"
                         href={`https://polygonscan.com/tx/${a.transactionHash}`}>{a.transactionHash.slice(0, 8)}…</a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {openPositions.length === 0 && fills.length === 0 && (
        <p className="text-xs text-zinc-500 italic">No live activity yet. Waiting for the arena tick to fire its next signal.</p>
      )}
    </section>
  );
}
