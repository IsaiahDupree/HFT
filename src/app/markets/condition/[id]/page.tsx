import Link from "next/link";
import { poly } from "@/lib/polymarket/client";
import { Sparkline } from "@/components/Sparkline";

export const dynamic = "force-dynamic";

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}

export default async function MarketDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [gamma, holders] = await Promise.all([
    safe(() => poly.marketsByCondition([id])),
    safe(() => poly.topHolders(id, 10)),
  ]);
  const market = Array.isArray(gamma) ? gamma[0] : null;
  if (!market) {
    return <div className="text-zinc-500 text-sm">Market not found for condition {id}.</div>;
  }
  let tokenIds: string[] = [];
  try { tokenIds = JSON.parse(market.clobTokenIds ?? "[]"); } catch {}
  const [books, histories] = await Promise.all([
    Promise.all(tokenIds.map((t) => safe(() => poly.orderbook(t)))),
    Promise.all(tokenIds.map((t) => safe(() => poly.pricesHistory(t, "1d", 60)))),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/markets" className="text-xs text-zinc-500 hover:text-zinc-300">← markets</Link>
        <h1 className="text-2xl font-semibold mt-1">{market.question}</h1>
        <p className="text-sm text-zinc-400 mt-1 max-w-3xl">{market.description?.slice(0, 400)}…</p>
        <div className="flex gap-4 text-xs text-zinc-500 mt-2">
          <span>vol 24h: <span className="text-zinc-300">${Number(market.volume24hr ?? 0).toLocaleString()}</span></span>
          <span>liquidity: <span className="text-zinc-300">${Number(market.liquidity ?? 0).toLocaleString()}</span></span>
          <span>ends: <span className="text-zinc-300">{market.endDate?.slice(0, 10)}</span></span>
        </div>
      </div>

      <section className="grid grid-cols-2 gap-4">
        {books.map((b, i) => {
          const series = (histories[i]?.history ?? []).map((p: any) => p.p as number);
          return (
            <div key={i} className="card">
              <div className="flex items-center justify-between mb-2">
                <h2 className="card-title m-0">Outcome {i + 1}</h2>
                {series.length > 1 && (
                  <Sparkline values={series} width={140} height={36} stroke="#5aa9ff" />
                )}
              </div>
              {!b ? <p className="text-zinc-500 text-xs">No orderbook.</p> : (
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <div className="card-title">Bids</div>
                    <ul className="font-mono">
                      {(b.bids ?? []).slice(0, 8).reverse().map((row: any, j: number) => (
                        <li key={j} className="flex justify-between text-accent-green"><span>{row.price}</span><span>{row.size}</span></li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <div className="card-title">Asks</div>
                    <ul className="font-mono">
                      {(b.asks ?? []).slice(0, 8).map((row: any, j: number) => (
                        <li key={j} className="flex justify-between text-accent-red"><span>{row.price}</span><span>{row.size}</span></li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
              <div className="mt-2 text-[10px] text-zinc-500">{series.length} samples • last {series.length ? series[series.length - 1].toFixed(3) : "—"}</div>
            </div>
          );
        })}
      </section>

      <section className="card">
        <h2 className="card-title">Top holders</h2>
        {!holders || (Array.isArray(holders) && holders.length === 0) ? (
          <p className="text-zinc-500 text-xs">No holder data.</p>
        ) : (
          <table className="list">
            <thead><tr><th>Wallet</th><th>Position</th><th>Size</th></tr></thead>
            <tbody>{(holders as any[]).slice(0, 10).map((h: any, i: number) => (
              <tr key={i}><td className="font-mono text-xs">{h.proxyWallet?.slice(0, 12)}…</td><td>{h.outcome}</td><td className="tabular-nums">{Number(h.amount ?? 0).toFixed(2)}</td></tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </div>
  );
}
