"use client";

import { useMemo, useState } from "react";
import { VENUES, roundTripFeeBps, type Venue } from "@/lib/hft/venues";
import { computeEdge } from "@/lib/hft/edge";

const NUMERIC_INPUT =
  "w-full bg-ink-950 border border-ink-700 rounded px-2 py-1 text-zinc-100 tabular-nums focus:outline-none focus:border-accent-blue";

function fmtUsd(n: number) {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}k`;
  return `${sign}$${abs.toFixed(2)}`;
}

function fmtBps(n: number) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)} bps`;
}

export function HftCalculator() {
  const [notionalUsd, setNotionalUsd] = useState(2500);
  const [expectedEdgeBps, setExpectedEdgeBps] = useState(8);
  const [side, setSide] = useState<"maker" | "taker">("maker");
  const [spreadBps, setSpreadBps] = useState(4);
  const [slippageBps, setSlippageBps] = useState(1);
  const [latencyPenaltyBps, setLatencyPenaltyBps] = useState(1);
  const [adverseSelectionBps, setAdverseSelectionBps] = useState(2);
  const [fillsPerDay, setFillsPerDay] = useState(200);
  const [fillRate, setFillRate] = useState(0.4);

  const rows = useMemo(() => {
    return VENUES.map((v) => ({
      venue: v,
      result: computeEdge(v, {
        notionalUsd,
        expectedEdgeBps,
        side,
        spreadBps,
        slippageBps,
        latencyPenaltyBps,
        adverseSelectionBps,
        fillsPerDay,
        fillRate,
      }),
    })).sort((a, b) => b.result.expectedDailyUsd - a.result.expectedDailyUsd);
  }, [notionalUsd, expectedEdgeBps, side, spreadBps, slippageBps, latencyPenaltyBps, adverseSelectionBps, fillsPerDay, fillRate]);

  const winner = rows[0];

  return (
    <div className="grid grid-cols-12 gap-6">
      {/* Inputs */}
      <div className="col-span-12 lg:col-span-4 card space-y-4">
        <h3 className="card-title">Inputs</h3>
        <FieldRow label="Notional per trade (USD)">
          <input
            className={NUMERIC_INPUT}
            type="number"
            value={notionalUsd}
            min={1}
            onChange={(e) => setNotionalUsd(Number(e.target.value))}
          />
        </FieldRow>

        <FieldRow label="Expected edge (bps)">
          <input
            className={NUMERIC_INPUT}
            type="number"
            value={expectedEdgeBps}
            step={0.5}
            onChange={(e) => setExpectedEdgeBps(Number(e.target.value))}
          />
        </FieldRow>

        <FieldRow label="Order side">
          <div className="flex gap-2">
            {(["maker", "taker"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSide(s)}
                className={`px-3 py-1 rounded border text-xs uppercase tracking-wider ${
                  side === s
                    ? "bg-accent-blue/20 border-accent-blue text-accent-blue"
                    : "border-ink-700 text-zinc-400 hover:text-zinc-100"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </FieldRow>

        <FieldRow label="Spread (bps)" hint="Only counted on taker side">
          <input
            className={NUMERIC_INPUT}
            type="number"
            value={spreadBps}
            step={0.5}
            onChange={(e) => setSpreadBps(Number(e.target.value))}
          />
        </FieldRow>

        <FieldRow label="Slippage (bps)">
          <input
            className={NUMERIC_INPUT}
            type="number"
            value={slippageBps}
            step={0.25}
            onChange={(e) => setSlippageBps(Number(e.target.value))}
          />
        </FieldRow>

        <FieldRow label="Latency penalty (bps)">
          <input
            className={NUMERIC_INPUT}
            type="number"
            value={latencyPenaltyBps}
            step={0.25}
            onChange={(e) => setLatencyPenaltyBps(Number(e.target.value))}
          />
        </FieldRow>

        <FieldRow label="Adverse selection (bps)">
          <input
            className={NUMERIC_INPUT}
            type="number"
            value={adverseSelectionBps}
            step={0.5}
            onChange={(e) => setAdverseSelectionBps(Number(e.target.value))}
          />
        </FieldRow>

        <FieldRow label="Orders placed / day">
          <input
            className={NUMERIC_INPUT}
            type="number"
            value={fillsPerDay}
            min={1}
            onChange={(e) => setFillsPerDay(Number(e.target.value))}
          />
        </FieldRow>

        <FieldRow label="Fill rate (0..1)">
          <input
            className={NUMERIC_INPUT}
            type="number"
            value={fillRate}
            min={0}
            max={1}
            step={0.05}
            onChange={(e) => setFillRate(Number(e.target.value))}
          />
        </FieldRow>

        <div className="text-[10px] text-zinc-500 leading-snug pt-2 border-t border-ink-800">
          Costs add up: <span className="text-zinc-300">fees + spread (taker only) + slippage + latency + adverse selection</span>. Trade only when expected edge clears the bar.
        </div>
      </div>

      {/* Winner spotlight + ranked table */}
      <div className="col-span-12 lg:col-span-8 space-y-4">
        {winner && (
          <div className="card">
            <div className="flex items-baseline justify-between">
              <h3 className="card-title">Top venue at these inputs</h3>
              <span className={winner.result.passes ? "pill-green" : "pill-red"}>
                {winner.result.passes ? "edge clears costs" : "below breakeven"}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-4 gap-4">
              <Stat label="Venue" value={winner.venue.name} small />
              <Stat label="Net edge / fill" value={fmtBps(winner.result.netEdgeBps)} />
              <Stat label="Expected / day" value={fmtUsd(winner.result.expectedDailyUsd)} highlight={winner.result.passes ? "green" : "red"} />
              <Stat label="Expected / year" value={fmtUsd(winner.result.expectedAnnualUsd)} highlight={winner.result.passes ? "green" : "red"} />
            </div>
          </div>
        )}

        <div className="card">
          <h3 className="card-title">Ranked venues</h3>
          <table className="list">
            <thead>
              <tr>
                <th>Venue</th>
                <th className="text-right">Fee (bps)</th>
                <th className="text-right">Cost (bps)</th>
                <th className="text-right">Net edge</th>
                <th className="text-right">$/fill</th>
                <th className="text-right">$/day</th>
                <th className="text-right">$/year</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ venue, result }) => (
                <tr key={venue.id}>
                  <td>
                    <div className="text-zinc-100">{venue.name}</div>
                    <div className="text-[10px] text-zinc-500">{venue.chain}</div>
                  </td>
                  <td className="text-right tabular-nums">{roundTripFeeBps(venue, side).toFixed(2)}</td>
                  <td className="text-right tabular-nums text-zinc-400">{result.costBps.toFixed(2)}</td>
                  <td className={`text-right tabular-nums ${result.netEdgeBps >= 0 ? "text-accent-green" : "text-accent-red"}`}>
                    {fmtBps(result.netEdgeBps)}
                  </td>
                  <td className={`text-right tabular-nums ${result.perFillUsd >= 0 ? "text-zinc-100" : "text-accent-red"}`}>
                    {fmtUsd(result.perFillUsd)}
                  </td>
                  <td className={`text-right tabular-nums ${result.expectedDailyUsd >= 0 ? "text-accent-green" : "text-accent-red"}`}>
                    {fmtUsd(result.expectedDailyUsd)}
                  </td>
                  <td className={`text-right tabular-nums ${result.expectedAnnualUsd >= 0 ? "text-accent-green" : "text-accent-red"}`}>
                    {fmtUsd(result.expectedAnnualUsd)}
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

function FieldRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[10px] text-zinc-600 mt-1">{hint}</span>}
    </label>
  );
}

function Stat({ label, value, highlight, small }: { label: string; value: string; highlight?: "green" | "red"; small?: boolean }) {
  const cls = highlight === "green" ? "text-accent-green" : highlight === "red" ? "text-accent-red" : "text-zinc-100";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`tabular-nums font-semibold ${cls} ${small ? "text-sm" : "text-xl"}`}>{value}</div>
    </div>
  );
}
