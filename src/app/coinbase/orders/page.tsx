import Link from "next/link";
import { cb } from "@/lib/coinbase/client";
import { authIsAvailable } from "@/lib/coinbase/auth";

export const dynamic = "force-dynamic";

async function safe<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try { return await fn(); } catch (err) { return { error: (err as Error).message }; }
}

export default async function CoinbaseOrdersPage() {
  if (!authIsAvailable()) {
    return <p className="text-xs text-accent-red">No CDP key configured. See README → Coinbase setup.</p>;
  }
  const [open, filled, cancelled, fills] = await Promise.all([
    safe(() => cb.listOrders({ order_status: ["OPEN"], limit: 25 })),
    safe(() => cb.listOrders({ order_status: ["FILLED"], limit: 25 })),
    safe(() => cb.listOrders({ order_status: ["CANCELLED"], limit: 10 })),
    safe(() => cb.listFills({ limit: 25 })),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/coinbase" className="text-xs text-zinc-500 hover:text-zinc-300">← coinbase overview</Link>
        <h1 className="text-2xl font-semibold mt-1">Coinbase orders &amp; fills</h1>
      </div>

      <OrderSection title="Open" data={open} />
      <OrderSection title="Filled (last 25)" data={filled} />
      <OrderSection title="Cancelled (last 10)" data={cancelled} />

      <section className="card">
        <h2 className="card-title">Fills (last 25)</h2>
        {(fills as any)?.error ? (
          <p className="text-xs text-accent-red">{(fills as any).error}</p>
        ) : (
          <table className="list">
            <thead><tr><th>Time</th><th>Product</th><th>Side</th><th className="text-right">Size</th><th className="text-right">Price</th><th className="text-right">Fee</th><th>Liq</th></tr></thead>
            <tbody>
              {(((fills as any)?.fills ?? []) as any[]).slice(0, 25).map((f) => (
                <tr key={f.entry_id ?? f.trade_id}>
                  <td className="text-xs text-zinc-500">{f.trade_time ? new Date(f.trade_time).toLocaleString() : "—"}</td>
                  <td className="text-zinc-100">{f.product_id}</td>
                  <td className={f.side === "BUY" ? "text-accent-green" : "text-accent-red"}>{f.side}</td>
                  <td className="text-right tabular-nums">{Number(f.size ?? 0).toLocaleString(undefined, { maximumFractionDigits: 8 })}</td>
                  <td className="text-right tabular-nums">{Number(f.price ?? 0).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                  <td className="text-right tabular-nums text-zinc-500">{Number(f.commission ?? 0).toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                  <td className="text-xs text-zinc-500">{f.liquidity_indicator === "M" ? "maker" : f.liquidity_indicator === "T" ? "taker" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function OrderSection({ title, data }: { title: string; data: any }) {
  const orders = (data?.orders ?? []) as any[];
  return (
    <section className="card">
      <h2 className="card-title">{title} ({orders.length})</h2>
      {data?.error ? (
        <p className="text-xs text-accent-red">{data.error}</p>
      ) : orders.length === 0 ? (
        <p className="text-xs text-zinc-500">None.</p>
      ) : (
        <table className="list">
          <thead><tr><th>Created</th><th>Product</th><th>Side</th><th>Type</th><th className="text-right">Size</th><th className="text-right">Filled</th><th className="text-right">Avg price</th><th>Status</th></tr></thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.order_id}>
                <td className="text-xs text-zinc-500">{o.created_time ? new Date(o.created_time).toLocaleString() : "—"}</td>
                <td className="text-zinc-100">{o.product_id}</td>
                <td className={o.side === "BUY" ? "text-accent-green" : "text-accent-red"}>{o.side}</td>
                <td className="text-xs text-zinc-500">{o.order_type ?? "—"}</td>
                <td className="text-right tabular-nums">{o.size ?? "—"}</td>
                <td className="text-right tabular-nums">{o.filled_size ?? "0"}</td>
                <td className="text-right tabular-nums">{o.average_filled_price ?? "—"}</td>
                <td><span className={o.status === "OPEN" ? "pill-blue" : o.status === "FILLED" ? "pill-green" : "pill-amber"}>{o.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
