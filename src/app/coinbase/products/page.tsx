import Link from "next/link";
import { cb } from "@/lib/coinbase/client";

export const dynamic = "force-dynamic";

async function safe<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try { return await fn(); } catch (err) { return { error: (err as Error).message }; }
}

export default async function CoinbaseProductsPage() {
  const list = await safe(() => cb.publicListProducts({ limit: 250 }));
  const products = ((list as any)?.products ?? []) as any[];
  // Show only SPOT (and online ones first), top 60 by 24h volume.
  const spotOnline = products
    .filter((p) => p.product_type === "SPOT" && p.status === "online")
    .sort((a, b) => Number(b.volume_24h ?? 0) - Number(a.volume_24h ?? 0))
    .slice(0, 60);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Coinbase products</h1>
        <p className="text-zinc-400 text-sm mt-1">Top SPOT products by 24h volume. Click for orderbook + cross-venue pairing.</p>
      </div>
      {(list as any)?.error && <p className="text-xs text-accent-red">{(list as any).error}</p>}
      <table className="list">
        <thead><tr><th>Product</th><th>Display</th><th className="text-right">Price</th><th className="text-right">24h %</th><th className="text-right">24h volume</th><th>Status</th></tr></thead>
        <tbody>
          {spotOnline.map((p) => {
            const chg = Number(p.price_percentage_change_24h ?? 0);
            return (
              <tr key={p.product_id}>
                <td><Link className="text-zinc-100 hover:text-accent-blue" href={`/coinbase/products/${encodeURIComponent(p.product_id)}`}>{p.product_id}</Link></td>
                <td className="text-zinc-400">{p.display_name ?? p.product_id}</td>
                <td className="text-right tabular-nums">{Number(p.price ?? 0).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                <td className={`text-right tabular-nums ${chg >= 0 ? "text-accent-green" : "text-accent-red"}`}>{chg.toFixed(2)}%</td>
                <td className="text-right tabular-nums text-zinc-400">{Number(p.volume_24h ?? 0).toLocaleString()}</td>
                <td><span className="pill-green">{p.status}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
