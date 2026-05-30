"use client";

import { useMemo, useState } from "react";
import { rankStrategies, rankPolyBtcStrategies } from "@/lib/hft/strategies";

const NUMERIC_INPUT =
  "w-full bg-ink-950 border border-ink-700 rounded px-2 py-1 text-zinc-100 tabular-nums focus:outline-none focus:border-accent-blue";

function fmtUsd(n: number) {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}k`;
  return `${sign}$${abs.toFixed(2)}`;
}

export function StrategyRanker() {
  const [notionalUsd, setNotionalUsd] = useState(2500);
  const [edgeMultiplier, setEdgeMultiplier] = useState(1.0);
  const [polyNotional, setPolyNotional] = useState(500);
  const [polyFillsMultiplier, setPolyFillsMultiplier] = useState(1.0);

  const hftRows = useMemo(() => rankStrategies(notionalUsd, edgeMultiplier), [notionalUsd, edgeMultiplier]);
  const polyRows = useMemo(() => rankPolyBtcStrategies(polyNotional, polyFillsMultiplier), [polyNotional, polyFillsMultiplier]);

  const top = hftRows[0];
  const topPoly = polyRows[0];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-12 gap-6">
        <div className="col-span-12 md:col-span-6 card space-y-3">
          <h3 className="card-title">HFT venue strategies — inputs</h3>
          <label className="block">
            <span className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Notional per fill (USD)</span>
            <input className={NUMERIC_INPUT} type="number" min={1} value={notionalUsd} onChange={(e) => setNotionalUsd(Number(e.target.value))} />
          </label>
          <label className="block">
            <span className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Edge confidence multiplier</span>
            <input className={NUMERIC_INPUT} type="number" min={0} step={0.05} value={edgeMultiplier} onChange={(e) => setEdgeMultiplier(Number(e.target.value))} />
          </label>
          {top && (
            <div className="text-xs text-zinc-300 pt-2 border-t border-ink-800">
              Top fit: <span className="text-accent-green">{top.strategy.name}</span> on <span className="text-zinc-100">{top.venue.name}</span> — {fmtUsd(top.result.expectedDailyUsd)}/day after costs.
            </div>
          )}
        </div>

        <div className="col-span-12 md:col-span-6 card space-y-3">
          <h3 className="card-title">Polymarket BTC binaries — inputs</h3>
          <label className="block">
            <span className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Notional per fill (USD)</span>
            <input className={NUMERIC_INPUT} type="number" min={1} value={polyNotional} onChange={(e) => setPolyNotional(Number(e.target.value))} />
          </label>
          <label className="block">
            <span className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Fill-rate multiplier (1.0 = per-strategy defaults)</span>
            <input className={NUMERIC_INPUT} type="number" min={0} step={0.1} value={polyFillsMultiplier} onChange={(e) => setPolyFillsMultiplier(Number(e.target.value))} />
          </label>
          {topPoly && (
            <div className="text-xs text-zinc-300 pt-2 border-t border-ink-800">
              Top fit: <span className="text-accent-green">{topPoly.name}</span> — {fmtUsd(topPoly.result.expectedDailyUsd)}/day, net edge {topPoly.result.netEdgeBps.toFixed(0)} bps.
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6">
        <div className="col-span-12 lg:col-span-7 card">
          <h3 className="card-title">HFT venue strategies — ranked</h3>
          <table className="list">
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Venue</th>
                <th className="text-right">Net edge</th>
                <th className="text-right">$/day</th>
                <th className="text-right">$/year</th>
              </tr>
            </thead>
            <tbody>
              {hftRows.map(({ strategy, venue, result }) => (
                <tr key={strategy.id}>
                  <td>
                    <div className="text-zinc-100">{strategy.name}</div>
                    <div className="text-[10px] text-zinc-500 leading-snug max-w-sm">{strategy.description}</div>
                  </td>
                  <td className="text-zinc-300">
                    <div>{venue.name}</div>
                    <div className="text-[10px] text-zinc-500">{venue.chain}</div>
                  </td>
                  <td className={`text-right tabular-nums ${result.netEdgeBps >= 0 ? "text-accent-green" : "text-accent-red"}`}>
                    {result.netEdgeBps.toFixed(1)} bps
                  </td>
                  <td className={`text-right tabular-nums ${result.expectedDailyUsd >= 0 ? "text-accent-green" : "text-accent-red"}`}>
                    {fmtUsd(result.expectedDailyUsd)}
                  </td>
                  <td className={`text-right tabular-nums ${result.expectedAnnualUsd >= 0 ? "text-zinc-100" : "text-accent-red"}`}>
                    {fmtUsd(result.expectedAnnualUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="col-span-12 lg:col-span-5 card">
          <h3 className="card-title">Polymarket BTC binaries — ranked</h3>
          <table className="list">
            <thead>
              <tr>
                <th>Strategy</th>
                <th className="text-right">Net edge</th>
                <th className="text-right">$/day</th>
              </tr>
            </thead>
            <tbody>
              {polyRows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <div className="text-zinc-100">{row.name}</div>
                    <div className="text-[10px] text-zinc-500">{row.horizon}</div>
                  </td>
                  <td className={`text-right tabular-nums ${row.result.netEdgeBps >= 0 ? "text-accent-green" : "text-accent-red"}`}>
                    {row.result.netEdgeBps.toFixed(0)} bps
                  </td>
                  <td className={`text-right tabular-nums ${row.result.expectedDailyUsd >= 0 ? "text-accent-green" : "text-accent-red"}`}>
                    {fmtUsd(row.result.expectedDailyUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
