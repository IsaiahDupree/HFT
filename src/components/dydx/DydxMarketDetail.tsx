"use client";

import { useEffect, useMemo, useState } from "react";

type Level = { price: number; size: number };
type Trade = { side: "BUY" | "SELL"; price: number; size: number; createdAt: string };
type Candle = { startedAt: string; open: number; high: number; low: number; close: number; baseTokenVolume: number };
type MarketInfo = {
  oraclePrice: number; indexPrice: number | null; priceChange24H: number; volume24H: number;
  openInterest: number; nextFundingRate: number; tickSize: number; stepSize: number; status: string;
};

function fmtUsd(n: number, max = 2) {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(2)}k`;
  return `${sign}$${abs.toFixed(max)}`;
}

function fmtAge(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
  return `${Math.floor(ms / 3600000)}h`;
}

export function DydxMarketDetail({ net = "testnet", ticker }: { net?: "testnet" | "mainnet"; ticker: string }) {
  const [data, setData] = useState<{
    market: MarketInfo | null; orderbook: { bids: Level[]; asks: Level[] }; trades: Trade[]; candles: Candle[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`/api/hft/dydx/market/${encodeURIComponent(ticker)}?net=${net}`, { cache: "no-store" });
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        setData({ market: j.market, orderbook: j.orderbook, trades: j.trades, candles: j.candles });
        setUpdatedAt(j.when);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
      }
    }
    setData(null); setError(null);
    load();
    const t = setInterval(load, 2500);
    return () => { cancelled = true; clearInterval(t); };
  }, [net, ticker]);

  const stats = data?.market;
  const maxBid = useMemo(() => Math.max(...(data?.orderbook.bids.slice(0, 10).map((b) => b.size) ?? [0])), [data]);
  const maxAsk = useMemo(() => Math.max(...(data?.orderbook.asks.slice(0, 10).map((a) => a.size) ?? [0])), [data]);
  const maxSize = Math.max(maxBid, maxAsk, 1e-9);

  return (
    <div className="grid grid-cols-12 gap-6">
      <div className="col-span-12 lg:col-span-7 card">
        <div className="flex items-baseline justify-between">
          <div>
            <h3 className="card-title">Orderbook · {ticker}</h3>
            <div className="text-[10px] text-zinc-500">
              {stats ? `oracle ${fmtUsd(stats.oraclePrice, 4)} · 24h vol ${fmtUsd(stats.volume24H, 0)} · ${stats.status}` : "loading…"}
              {updatedAt && ` · upd ${new Date(updatedAt).toLocaleTimeString()}`}
            </div>
          </div>
          {stats && (
            <Sparkline candles={data!.candles} oracle={stats.oraclePrice} />
          )}
        </div>
        {error && <div className="text-xs text-accent-red mt-2">error: {error}</div>}
        {data && (
          <div className="grid grid-cols-2 gap-2 mt-3 text-[11px] tabular-nums">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Bids</div>
              <div className="space-y-[2px]">
                {data.orderbook.bids.slice(0, 10).map((b) => (
                  <Row key={`b-${b.price}`} side="bid" price={b.price} size={b.size} maxSize={maxSize} />
                ))}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Asks</div>
              <div className="space-y-[2px]">
                {data.orderbook.asks.slice(0, 10).map((a) => (
                  <Row key={`a-${a.price}`} side="ask" price={a.price} size={a.size} maxSize={maxSize} />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="col-span-12 lg:col-span-5 card">
        <h3 className="card-title">Recent trades</h3>
        {data?.trades.length ? (
          <div className="space-y-[2px] text-[11px] tabular-nums max-h-[420px] overflow-y-auto">
            {data.trades.map((t, i) => (
              <div key={i} className="flex justify-between">
                <span className={t.side === "BUY" ? "text-accent-green" : "text-accent-red"}>{t.side}</span>
                <span className="text-zinc-200">{t.price.toFixed(4)}</span>
                <span className="text-zinc-400">{t.size}</span>
                <span className="text-[10px] text-zinc-500">{fmtAge(t.createdAt)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[11px] text-zinc-500">no recent trades on {net}</div>
        )}
      </div>
    </div>
  );
}

function Row({ side, price, size, maxSize }: { side: "bid" | "ask"; price: number; size: number; maxSize: number }) {
  const pct = Math.min(100, (size / maxSize) * 100);
  const colour = side === "bid" ? "bg-accent-green/15" : "bg-accent-red/15";
  return (
    <div className="relative flex justify-between px-1">
      <div className={`absolute inset-y-0 right-0 ${colour}`} style={{ width: `${pct}%` }} />
      <span className="relative text-zinc-200">{price.toFixed(4)}</span>
      <span className="relative text-zinc-400">{size}</span>
    </div>
  );
}

function Sparkline({ candles, oracle }: { candles: Candle[]; oracle: number }) {
  if (!candles?.length) return null;
  // Indexer returns newest-first — reverse.
  const series = [...candles].reverse().map((c) => c.close);
  const min = Math.min(...series), max = Math.max(...series);
  const range = max - min || 1;
  const w = 120, h = 32;
  const pts = series.map((v, i) => `${(i / (series.length - 1)) * w},${h - ((v - min) / range) * h}`).join(" ");
  const last = series.at(-1) ?? oracle;
  const first = series[0] ?? oracle;
  const up = last >= first;
  return (
    <svg width={w} height={h} className="text-zinc-500">
      <polyline fill="none" stroke={up ? "rgb(74 222 128)" : "rgb(248 113 113)"} strokeWidth={1.5} points={pts} />
    </svg>
  );
}
