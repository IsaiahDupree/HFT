"use client";

import { useMemo, useState } from "react";
import { POLY_BTC_STRATEGIES, evalPolyBtc, type PolyBtcStrategy } from "@/lib/hft/polymarket-btc";

const NUMERIC_INPUT =
  "w-full bg-ink-950 border border-ink-700 rounded px-2 py-1 text-zinc-100 tabular-nums focus:outline-none focus:border-accent-blue";

function fmtUsd(n: number) {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}k`;
  return `${sign}$${abs.toFixed(2)}`;
}

export function PolyBtcMatrix() {
  const [notionalUsd, setNotionalUsd] = useState(500);
  const [fillsMultiplier, setFillsMultiplier] = useState(1.0);
  const [edgeMultiplier, setEdgeMultiplier] = useState(1.0);

  const rows = useMemo(() => {
    return POLY_BTC_STRATEGIES.map((s: PolyBtcStrategy) => {
      const adjusted = { ...s.defaultInputs };
      // Edge multiplier scales the operator's belief over the market price.
      const delta = adjusted.trueProb - adjusted.marketYesPrice;
      adjusted.trueProb = adjusted.marketYesPrice + delta * edgeMultiplier;
      const fillsPerDay = s.fillsPerDayDefault * fillsMultiplier;
      const result = evalPolyBtc({ ...adjusted, notionalUsd, fillsPerDay });
      return { strategy: s, result, fillsPerDay };
    }).sort((a, b) => b.result.expectedDailyUsd - a.result.expectedDailyUsd);
  }, [notionalUsd, fillsMultiplier, edgeMultiplier]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <label className="block">
          <span className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Notional per fill (USD)</span>
          <input className={NUMERIC_INPUT} type="number" min={1} value={notionalUsd} onChange={(e) => setNotionalUsd(Number(e.target.value))} />
        </label>
        <label className="block">
          <span className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Fill-rate multiplier (1.0 = per-strategy defaults)</span>
          <input className={NUMERIC_INPUT} type="number" min={0} step={0.1} value={fillsMultiplier} onChange={(e) => setFillsMultiplier(Number(e.target.value))} />
        </label>
        <label className="block">
          <span className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Edge confidence (0.5 = ½ of model edge, 1.5 = 50% more)</span>
          <input className={NUMERIC_INPUT} type="number" min={0} step={0.05} value={edgeMultiplier} onChange={(e) => setEdgeMultiplier(Number(e.target.value))} />
        </label>
      </div>

      <table className="list">
        <thead>
          <tr>
            <th>Strategy</th>
            <th>Horizon</th>
            <th>Side / order</th>
            <th className="text-right">Implied vs true</th>
            <th className="text-right">Edge (bps)</th>
            <th className="text-right">Net edge (bps)</th>
            <th className="text-right">Fills/day</th>
            <th className="text-right">$/fill</th>
            <th className="text-right">$/day</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ strategy, result, fillsPerDay }) => {
            const i = strategy.defaultInputs;
            return (
              <tr key={strategy.id}>
                <td>
                  <div className="text-zinc-100">{strategy.name}</div>
                  <div className="text-[10px] text-zinc-500 leading-snug max-w-md">{strategy.thesis}</div>
                </td>
                <td className="text-zinc-300">{strategy.horizon}</td>
                <td>
                  <span className="pill-blue">{i.side}</span>
                  <span className="ml-1 pill-amber">{i.order}</span>
                </td>
                <td className="text-right tabular-nums text-zinc-400">
                  {i.marketYesPrice.toFixed(2)} → {i.trueProb.toFixed(2)}
                </td>
                <td className="text-right tabular-nums text-zinc-300">{result.edgeBps.toFixed(1)}</td>
                <td className={`text-right tabular-nums ${result.netEdgeBps >= 0 ? "text-accent-green" : "text-accent-red"}`}>
                  {result.netEdgeBps.toFixed(1)}
                </td>
                <td className="text-right tabular-nums text-zinc-400">{fillsPerDay.toFixed(1)}</td>
                <td className={`text-right tabular-nums ${result.evPerFillUsd >= 0 ? "text-zinc-100" : "text-accent-red"}`}>
                  {fmtUsd(result.evPerFillUsd)}
                </td>
                <td className={`text-right tabular-nums ${result.expectedDailyUsd >= 0 ? "text-accent-green" : "text-accent-red"}`}>
                  {fmtUsd(result.expectedDailyUsd)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="text-[10px] text-zinc-500 leading-snug pt-2 border-t border-ink-800">
        Polymarket takers pay 100 bps on crypto markets; makers pay 0 bps and earn a 20 bps rebate when their order is matched. Adverse selection and event risk are modelled per strategy.
      </div>
    </div>
  );
}
