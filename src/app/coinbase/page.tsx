import Link from "next/link";
import { cb } from "@/lib/coinbase/client";
import { authIsAvailable, keyAlg, keyName } from "@/lib/coinbase/auth";
import { cbSafety } from "@/lib/coinbase/execute";

export const dynamic = "force-dynamic";

async function safe<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try { return await fn(); } catch (err) { return { error: (err as Error).message }; }
}

function fmtUsd(n: number | string | undefined): string {
  const v = Number(n ?? 0);
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

export default async function CoinbaseHome() {
  const haveAuth = authIsAvailable();

  const [perms, accounts, txSummary, openOrders, btc] = await Promise.all([
    haveAuth ? safe(() => cb.getKeyPermissions()) : Promise.resolve({ error: "no CDP key configured" }),
    haveAuth ? safe(() => cb.listAccounts({ limit: 50 })) : Promise.resolve({ error: "no CDP key configured" }),
    haveAuth ? safe(() => cb.getTransactionSummary()) : Promise.resolve({ error: "no CDP key configured" }),
    haveAuth ? safe(() => cb.listOrders({ order_status: ["OPEN"], limit: 25 })) : Promise.resolve({ error: "no CDP key configured" }),
    safe(() => cb.publicGetProduct("BTC-USD")),
  ]);

  const accountList = (accounts as any)?.accounts ?? [];
  const totalAvailable = accountList.reduce((acc: number, a: any) => acc + Number(a.available_balance?.value ?? 0), 0);
  const openOrderList = (openOrders as any)?.orders ?? [];

  const mode = cbSafety.mode();
  const dailySpent = cbSafety.dailyExecutedUsd();
  const maxTrade = cbSafety.maxTrade();
  const maxDaily = cbSafety.maxDaily();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Coinbase Advanced Trade</h1>
        <p className="text-zinc-400 mt-1 text-sm">Sister-venue: spot, futures (CFM), perpetuals (INTX). Auth: CDP JWT (ES256/EdDSA).</p>
      </div>

      <section className="grid grid-cols-4 gap-4">
        <div className="card">
          <div className="card-title">Auth</div>
          {haveAuth ? (
            <>
              <div className="stat text-accent-green">{keyAlg()}</div>
              <div className="text-[10px] text-zinc-500 mt-1 break-all">{keyName().slice(0, 64)}…</div>
            </>
          ) : (
            <div className="stat text-accent-red">missing</div>
          )}
        </div>
        <div className="card">
          <div className="card-title">Safety mode</div>
          <div className={`stat ${mode === "LIVE" ? "text-accent-red" : "text-accent-green"}`}>{mode}</div>
          <div className="text-[10px] text-zinc-500 mt-1">{mode === "LIVE" ? "real orders enabled" : "dry-run only (COINBASE_ALLOW_TRADE!=1)"}</div>
        </div>
        <div className="card">
          <div className="card-title">Daily spend</div>
          <div className="stat">{fmtUsd(dailySpent)} <span className="text-zinc-500 text-sm">/ {fmtUsd(maxDaily)}</span></div>
          <div className="text-[10px] text-zinc-500 mt-1">per-trade cap {fmtUsd(maxTrade)}</div>
        </div>
        <div className="card">
          <div className="card-title">BTC-USD spot</div>
          <div className="stat">{(btc as any)?.error ? "—" : fmtUsd((btc as any)?.price)}</div>
          <div className="text-[10px] text-zinc-500 mt-1">live (public market)</div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-6">
        <div className="card">
          <h2 className="card-title">Key permissions</h2>
          {(perms as any)?.error ? (
            <p className="text-xs text-accent-red">{(perms as any).error}</p>
          ) : (
            <dl className="grid grid-cols-3 gap-2 text-xs">
              <Perm label="View" on={(perms as any)?.can_view} />
              <Perm label="Trade" on={(perms as any)?.can_trade} />
              <Perm label="Transfer" on={(perms as any)?.can_transfer} />
              <div className="col-span-3 text-zinc-500 mt-2">
                <span className="text-zinc-400">portfolio_type:</span> {(perms as any)?.portfolio_type ?? "—"}
              </div>
            </dl>
          )}
        </div>

        <div className="card">
          <h2 className="card-title">30d transaction summary</h2>
          {(txSummary as any)?.error ? (
            <p className="text-xs text-accent-red">{(txSummary as any).error}</p>
          ) : (
            <dl className="grid grid-cols-2 gap-2 text-xs">
              <Stat label="Total volume" value={fmtUsd((txSummary as any)?.total_volume)} />
              <Stat label="Total fees" value={fmtUsd((txSummary as any)?.total_fees)} />
              <Stat label="Advanced volume" value={fmtUsd((txSummary as any)?.advanced_trade_only_volume)} />
              <Stat label="Advanced fees" value={fmtUsd((txSummary as any)?.advanced_trade_only_fees)} />
              <Stat label="Maker tier rate" value={(txSummary as any)?.fee_tier?.maker_fee_rate ?? "—"} />
              <Stat label="Taker tier rate" value={(txSummary as any)?.fee_tier?.taker_fee_rate ?? "—"} />
            </dl>
          )}
        </div>
      </section>

      <section className="card">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="card-title m-0">Accounts ({accountList.length})</h2>
          <span className="text-xs text-zinc-500">Total available equivalent: {fmtUsd(totalAvailable)} (sum of raw balances, NOT FX-normalized)</span>
        </div>
        {(accounts as any)?.error ? (
          <p className="text-xs text-accent-red">{(accounts as any).error}</p>
        ) : (
          <table className="list">
            <thead><tr><th>Currency</th><th>Type</th><th className="text-right">Available</th><th className="text-right">Hold</th></tr></thead>
            <tbody>
              {accountList
                .filter((a: any) => Number(a.available_balance?.value ?? 0) > 0 || Number(a.hold?.value ?? 0) > 0)
                .sort((a: any, b: any) => Number(b.available_balance?.value ?? 0) - Number(a.available_balance?.value ?? 0))
                .slice(0, 50)
                .map((a: any) => (
                  <tr key={a.uuid}>
                    <td className="text-zinc-100">{a.currency}</td>
                    <td className="text-zinc-500 text-xs">{a.type?.replace("ACCOUNT_TYPE_", "").toLowerCase()}</td>
                    <td className="text-right tabular-nums">{Number(a.available_balance?.value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 8 })}</td>
                    <td className="text-right tabular-nums text-zinc-500">{Number(a.hold?.value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 8 })}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">Open orders ({openOrderList.length})</h2>
        {(openOrders as any)?.error ? (
          <p className="text-xs text-accent-red">{(openOrders as any).error}</p>
        ) : openOrderList.length === 0 ? (
          <p className="text-xs text-zinc-500">No open orders.</p>
        ) : (
          <table className="list">
            <thead><tr><th>Product</th><th>Side</th><th>Type</th><th className="text-right">Size</th><th className="text-right">Filled</th><th>Status</th></tr></thead>
            <tbody>
              {openOrderList.slice(0, 25).map((o: any) => (
                <tr key={o.order_id}>
                  <td className="text-zinc-100">{o.product_id}</td>
                  <td>{o.side}</td>
                  <td className="text-xs text-zinc-500">{o.order_type ?? "—"}</td>
                  <td className="text-right tabular-nums">{o.filled_size ?? o.size ?? "—"}</td>
                  <td className="text-right tabular-nums text-zinc-500">{o.filled_size ?? "0"}</td>
                  <td><span className="pill-blue">{o.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <nav className="text-xs text-zinc-500 flex gap-4">
        <Link href="/coinbase/products" className="hover:text-zinc-300">→ Products</Link>
        <Link href="/coinbase/orders" className="hover:text-zinc-300">→ Order history</Link>
        <Link href="/api/coinbase/sweep" className="hover:text-zinc-300">→ Last sweep results (JSON)</Link>
      </nav>
    </div>
  );
}

function Perm({ label, on }: { label: string; on?: boolean }) {
  return (
    <div>
      <div className="text-zinc-500">{label}</div>
      <div className={on ? "text-accent-green" : "text-accent-red"}>{on ? "yes" : "no"}</div>
    </div>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-zinc-500">{label}</div>
      <div className="text-zinc-100 tabular-nums">{value}</div>
    </div>
  );
}
