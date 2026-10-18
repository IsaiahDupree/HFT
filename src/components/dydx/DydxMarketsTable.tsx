"use client";

import { useEffect, useMemo, useState } from "react";

type Market = {
  ticker: string;
  status: string;
  oraclePrice: number;
  indexPrice: number | null;
  priceChange24H: number;
  volume24H: number;
  openInterest: number;
  nextFundingRate: number;
  tickSize: number;
  stepSize: number;
};

type SortKey = "ticker" | "oraclePrice" | "priceChange24H" | "volume24H" | "openInterest" | "nextFundingRate";

function fmtUsd(n: number, max = 2) {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(2)}k`;
  return `${sign}$${abs.toFixed(max)}`;
}

function fmtPct(n: number) {
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
}

function fmtBpsFunding(n: number) {
  // dYdX nextFundingRate is per hour as a fraction. Convert to bps/hour.
  return `${(n * 10000).toFixed(3)} bps/h`;
}

export function DydxMarketsTable({
  net = "testnet",
  selected,
  onSelect,
}: {
  net?: "testnet" | "mainnet";
  selected?: string | null;
  onSelect?: (ticker: string) => void;
}) {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("volume24H");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`/api/hft/dydx/markets?net=${net}`, { cache: "no-store" });
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        setMarkets(j.markets ?? []);
        setUpdatedAt(j.when);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const t = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [net]);

  const sorted = useMemo(() => {
    const arr = [...markets];
    arr.sort((a, b) => {
      const av = a[sortKey] as any;
      const bv = b[sortKey] as any;
      if (av === bv) return 0;
      const cmp = av < bv ? -1 : 1;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [markets, sortKey, sortDir]);

  function toggleSort(k: SortKey) {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir("desc"); }
  }

  return (
    <div className="card overflow-x-auto">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="card-title">Perpetual markets ({net})</h3>
        <div className="text-[10px] text-zinc-500">
          {loading ? "loading…" : `${markets.length} markets · updated ${updatedAt ? new Date(updatedAt).toLocaleTimeString() : "—"}`}
        </div>
      </div>
      {error && <div className="text-xs text-accent-red mb-3">error: {error}</div>}
      <table className="list min-w-[840px]">
        <thead>
          <tr>
            <SortHead k="ticker" cur={sortKey} dir={sortDir} onClick={toggleSort}>Market</SortHead>
            <SortHead k="oraclePrice" cur={sortKey} dir={sortDir} onClick={toggleSort} right>Oracle</SortHead>
            <SortHead k="priceChange24H" cur={sortKey} dir={sortDir} onClick={toggleSort} right>24h Δ</SortHead>
            <SortHead k="volume24H" cur={sortKey} dir={sortDir} onClick={toggleSort} right>24h vol</SortHead>
            <SortHead k="openInterest" cur={sortKey} dir={sortDir} onClick={toggleSort} right>OI</SortHead>
            <SortHead k="nextFundingRate" cur={sortKey} dir={sortDir} onClick={toggleSort} right>Funding</SortHead>
            <th className="text-right">Tick / Step</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((m) => {
            const isSel = m.ticker === selected;
            const oracle = m.oraclePrice;
            const change = oracle ? m.priceChange24H / oracle : 0;
            return (
              <tr
                key={m.ticker}
                onClick={() => onSelect?.(m.ticker)}
                className={`cursor-pointer ${isSel ? "bg-ink-800/80" : ""}`}
              >
                <td>
                  <span className={isSel ? "text-accent-blue" : "text-zinc-100"}>{m.ticker}</span>
                </td>
                <td className="text-right tabular-nums text-zinc-200">{fmtUsd(oracle, 4)}</td>
                <td className={`text-right tabular-nums ${change >= 0 ? "text-accent-green" : "text-accent-red"}`}>
                  {fmtPct(change)}
                </td>
                <td className="text-right tabular-nums text-zinc-300">{fmtUsd(m.volume24H, 0)}</td>
                <td className="text-right tabular-nums text-zinc-300">{fmtUsd(m.openInterest * oracle, 0)}</td>
                <td className={`text-right tabular-nums ${m.nextFundingRate >= 0 ? "text-accent-amber" : "text-accent-blue"}`}>
                  {fmtBpsFunding(m.nextFundingRate)}
                </td>
                <td className="text-right text-[10px] text-zinc-500">{m.tickSize} / {m.stepSize}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SortHead({ k, cur, dir, onClick, right, children }: {
  k: SortKey; cur: SortKey; dir: "asc" | "desc"; onClick: (k: SortKey) => void; right?: boolean; children: React.ReactNode;
}) {
  const active = k === cur;
  return (
    <th
      className={`${right ? "text-right" : ""} cursor-pointer select-none hover:text-zinc-300`}
      onClick={() => onClick(k)}
    >
      {children}{active ? <span className="ml-1 text-[8px] opacity-70">{dir === "asc" ? "▲" : "▼"}</span> : null}
    </th>
  );
}
