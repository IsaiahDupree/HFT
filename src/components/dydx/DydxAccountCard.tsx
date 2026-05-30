"use client";

import { useEffect, useState } from "react";

type Position = { market: string; side: "LONG" | "SHORT"; size: number; entryPrice: number; unrealizedPnl: number; realizedPnl: number };
type Order = { id: string; clientId: number; ticker: string; side: "BUY" | "SELL"; type: string; price: number; size: number; status: string; timeInForce: string };
type Fill = { market: string; side: "BUY" | "SELL"; price: number; size: number; fee: number; liquidity: string; createdAt: string };
type Account = {
  net: string; address: string; subaccountNumber: number; equity: number; freeCollateral: number;
  positions: Position[]; orders: Order[]; fills: Fill[];
};

function fmtUsd(n: number, max = 2) {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(2)}k`;
  return `${sign}$${abs.toFixed(max)}`;
}

export function DydxAccountCard({ net = "testnet" }: { net?: "testnet" | "mainnet" }) {
  const [acct, setAcct] = useState<Account | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`/api/hft/dydx/account?net=${net}`, { cache: "no-store" });
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        setAcct(j); setUpdatedAt(j.when); setError(null);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message); setAcct(null);
      }
    }
    load();
    const t = setInterval(load, 4000);
    return () => { cancelled = true; clearInterval(t); };
  }, [net]);

  const openOrders = acct?.orders.filter((o) => o.status === "OPEN" || o.status === "BEST_EFFORT_OPENED") ?? [];

  return (
    <div className="card">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="card-title">Account · {net}</h3>
        <div className="text-[10px] text-zinc-500">{updatedAt ? new Date(updatedAt).toLocaleTimeString() : "—"}</div>
      </div>

      {error && (
        <div className="text-xs text-accent-amber">
          {error.includes("Missing mnemonic") ? (
            <>No wallet configured. Run <code className="text-zinc-200">npm run dydx:wallet-init</code> and add the mnemonic to .env.local, then <code className="text-zinc-200">npm run dydx:faucet</code>.</>
          ) : (
            <>error: {error}</>
          )}
        </div>
      )}

      {acct && (
        <>
          <div className="text-[10px] text-zinc-500 break-all mb-3">{acct.address} · sub#{acct.subaccountNumber}</div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Metric label="Equity" value={fmtUsd(acct.equity)} accent="green" />
            <Metric label="Free collateral" value={fmtUsd(acct.freeCollateral)} />
          </div>

          <div className="mt-4">
            <div className="card-title">Positions ({acct.positions.length})</div>
            {acct.positions.length === 0 ? (
              <div className="text-[11px] text-zinc-500">flat</div>
            ) : (
              <div className="space-y-1">
                {acct.positions.map((p) => (
                  <div key={p.market} className="flex justify-between text-[11px] tabular-nums">
                    <span className="text-zinc-200">{p.market}</span>
                    <span className={p.side === "LONG" ? "text-accent-green" : "text-accent-red"}>{p.side}</span>
                    <span className="text-zinc-300">{p.size}</span>
                    <span className="text-zinc-400">@{p.entryPrice.toFixed(4)}</span>
                    <span className={p.unrealizedPnl >= 0 ? "text-accent-green" : "text-accent-red"}>{fmtUsd(p.unrealizedPnl)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-4">
            <div className="card-title">Open orders ({openOrders.length})</div>
            {openOrders.length === 0 ? (
              <div className="text-[11px] text-zinc-500">none</div>
            ) : (
              <div className="space-y-1 max-h-44 overflow-y-auto">
                {openOrders.slice(0, 12).map((o) => (
                  <div key={o.id} className="flex justify-between text-[11px] tabular-nums">
                    <span className="text-zinc-200">{o.ticker}</span>
                    <span className={o.side === "BUY" ? "text-accent-green" : "text-accent-red"}>{o.side}</span>
                    <span className="text-zinc-300">{o.size}@{o.price.toFixed(4)}</span>
                    <span className="text-[10px] text-zinc-500">{o.timeInForce}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-4">
            <div className="card-title">Recent fills ({acct.fills.length})</div>
            {acct.fills.length === 0 ? (
              <div className="text-[11px] text-zinc-500">none</div>
            ) : (
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {acct.fills.slice(0, 12).map((f, i) => (
                  <div key={i} className="flex justify-between text-[11px] tabular-nums">
                    <span className="text-zinc-200">{f.market}</span>
                    <span className={f.side === "BUY" ? "text-accent-green" : "text-accent-red"}>{f.side}</span>
                    <span className="text-zinc-300">{f.size}@{f.price.toFixed(4)}</span>
                    <span className="text-[10px] text-zinc-500">{f.liquidity}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: "green" | "amber" | "red" }) {
  const cls = accent === "green" ? "text-accent-green" : accent === "amber" ? "text-accent-amber" : accent === "red" ? "text-accent-red" : "text-zinc-100";
  return (
    <div className="border border-ink-700 rounded p-2">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${cls}`}>{value}</div>
    </div>
  );
}
