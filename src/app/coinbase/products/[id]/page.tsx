import Link from "next/link";
import { cb } from "@/lib/coinbase/client";

export const dynamic = "force-dynamic";

async function safe<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try { return await fn(); } catch (err) { return { error: (err as Error).message }; }
}

export default async function CoinbaseProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [product, book, trades] = await Promise.all([
    safe(() => cb.publicGetProduct(id)),
    safe(() => cb.publicGetProductBook({ product_id: id, limit: 25 })),
    safe(() => cb.publicGetMarketTrades(id, { limit: 25 })),
  ]);
  const p = product as any;
  const bk = (book as any)?.pricebook ?? {};
  const bestBid = Number(bk.bids?.[0]?.price ?? 0);
  const bestAsk = Number(bk.asks?.[0]?.price ?? 0);
  const spread = bestAsk - bestBid;
  const spreadBps = bestBid > 0 ? (spread / bestBid) * 10_000 : 0;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/coinbase/products" className="text-xs text-zinc-500 hover:text-zinc-300">← all products</Link>
        <h1 className="text-2xl font-semibold mt-1">{id}</h1>
        {p?.error && <p className="text-xs text-accent-red">{p.error}</p>}
      </div>

      <section className="grid grid-cols-4 gap-4">
        <Stat label="Price" value={Number(p?.price ?? 0).toLocaleString(undefined, { maximumFractionDigits: 4 })} />
        <Stat label="Best bid" value={bestBid.toLocaleString(undefined, { maximumFractionDigits: 4 })} />
        <Stat label="Best ask" value={bestAsk.toLocaleString(undefined, { maximumFractionDigits: 4 })} />
        <Stat label="Spread (bps)" value={spreadBps.toFixed(1)} />
      </section>

      <section className="grid grid-cols-2 gap-6">
        <div className="card">
          <h2 className="card-title">Orderbook bids (top 25)</h2>
          <table className="list text-xs">
            <thead><tr><th className="text-right">Price</th><th className="text-right">Size</th></tr></thead>
            <tbody>
              {(bk.bids ?? []).slice(0, 25).map((b: any, i: number) => (
                <tr key={i}><td className="text-right text-accent-green tabular-nums">{Number(b.price).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td><td className="text-right tabular-nums">{Number(b.size).toLocaleString(undefined, { maximumFractionDigits: 6 })}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h2 className="card-title">Orderbook asks (top 25)</h2>
          <table className="list text-xs">
            <thead><tr><th className="text-right">Price</th><th className="text-right">Size</th></tr></thead>
            <tbody>
              {(bk.asks ?? []).slice(0, 25).map((a: any, i: number) => (
                <tr key={i}><td className="text-right text-accent-red tabular-nums">{Number(a.price).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td><td className="text-right tabular-nums">{Number(a.size).toLocaleString(undefined, { maximumFractionDigits: 6 })}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">Recent trades (25)</h2>
        {(trades as any)?.error ? (
          <p className="text-xs text-accent-red">{(trades as any).error}</p>
        ) : (
          <table className="list">
            <thead><tr><th>Time</th><th>Side</th><th className="text-right">Price</th><th className="text-right">Size</th></tr></thead>
            <tbody>
              {((trades as any)?.trades ?? []).map((t: any) => (
                <tr key={t.trade_id}>
                  <td className="text-xs text-zinc-500">{new Date(t.time).toLocaleTimeString()}</td>
                  <td className={t.side === "BUY" ? "text-accent-green" : "text-accent-red"}>{t.side}</td>
                  <td className="text-right tabular-nums">{Number(t.price).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                  <td className="text-right tabular-nums">{Number(t.size).toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="card-title">{label}</div>
      <div className="stat">{value}</div>
    </div>
  );
}
