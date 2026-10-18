"use client";

import { useEffect, useState } from "react";

type MmStatus = {
  running: boolean;
  net: string;
  address?: string;
  subaccountNumber?: number;
  market: string;
  cfg?: { halfSpreadBps: number; perSideUsd: number; maxInventoryUsd: number; driftBps: number; skewBpsPerDollar: number; useMicroprice?: boolean; obiToxicityThreshold?: number; obiToxicityMaxMultiplier?: number; spreadAnomalyBps?: number };
  tickMs?: number;
  cycles?: number;
  fillsCount?: number;
  startedAt?: number | null;
  stoppedAt?: number | null;
  resting?: { BUY: { price: number; size: number; clientId: number } | null; SELL: { price: number; size: number; clientId: number } | null };
  pnl?: { position: number; vwap: number; realisedUsd: number; feesUsd: number; unrealisedUsd: number; mark: number };
  lastError?: string | null;
  recentCycles?: Array<{ cycle: number; ts: number; oracle: number; microprice: number | null; fair: number; obi: number; quotedSpreadBps: number | null; widenMult: number; paused: false | "stale-data" | "spread-anomaly"; position: number; inventoryUsd: number; bid: number | null; ask: number | null; skewBps: number; ms: number }>;
  recentFills?: Array<{ side: "BUY" | "SELL"; price: number; size: number; feeUsd: number; ts: number }>;
};

const NUMERIC =
  "w-full bg-ink-950 border border-ink-700 rounded px-2 py-1 text-zinc-100 tabular-nums focus:outline-none focus:border-accent-blue text-xs";

function fmtUsd(n: number, max = 2) {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(2)}k`;
  return `${sign}$${abs.toFixed(max)}`;
}

export function DydxMmPanel({ net = "testnet", market }: { net?: "testnet" | "mainnet"; market: string }) {
  const [status, setStatus] = useState<MmStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Editable config — defaults match the script.
  const [halfSpreadBps, setHalfSpread] = useState(15);
  const [perSideUsd, setPerSide] = useState(25);
  const [maxInventoryUsd, setMaxInv] = useState(100);
  const [driftBps, setDrift] = useState(5);
  const [skewBpsPerDollar, setSkew] = useState(0.1);
  const [tickMs, setTickMs] = useState(6000);
  const [useMicroprice, setUseMicroprice] = useState(true);
  const [obiToxicityThreshold, setObiToxThresh] = useState(0.4);
  const [obiToxicityMaxMultiplier, setObiToxMax] = useState(2);
  const [spreadAnomalyBps, setSpreadAnomaly] = useState(200);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`/api/hft/dydx/mm?net=${net}&market=${encodeURIComponent(market)}`, { cache: "no-store" });
        const j = await r.json();
        if (!cancelled) setStatus(j);
      } catch {}
    }
    load();
    const t = setInterval(load, 2000);
    return () => { cancelled = true; clearInterval(t); };
  }, [net, market]);

  async function action(kind: "start" | "stop") {
    setBusy(true); setError(null);
    try {
      const body = kind === "start"
        ? { action: "start", net, market, tickMs, cfg: { halfSpreadBps, perSideUsd, maxInventoryUsd, driftBps, skewBpsPerDollar, useMicroprice, obiToxicityThreshold, obiToxicityMaxMultiplier, spreadAnomalyBps } }
        : { action: "stop", net, market, reason: "ui" };
      const r = await fetch("/api/hft/dydx/mm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setStatus(j);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const running = !!status?.running;
  const pnl = status?.pnl;
  const totalPnl = pnl ? pnl.realisedUsd + pnl.unrealisedUsd : 0;

  return (
    <div className="card">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <h3 className="card-title">Market maker · {market}</h3>
          <div className="text-[10px] text-zinc-500">
            {running ? (
              <>running · {status?.cycles ?? 0} cycles · started {status?.startedAt ? new Date(status.startedAt).toLocaleTimeString() : "—"}</>
            ) : (
              <>idle</>
            )}
          </div>
        </div>
        {running ? (
          <button
            className="px-3 py-1 text-xs rounded border border-accent-red/40 bg-accent-red/15 text-accent-red hover:bg-accent-red/25 disabled:opacity-50"
            disabled={busy}
            onClick={() => action("stop")}
          >
            {busy ? "stopping…" : "Stop"}
          </button>
        ) : (
          <button
            className="px-3 py-1 text-xs rounded border border-accent-green/40 bg-accent-green/15 text-accent-green hover:bg-accent-green/25 disabled:opacity-50"
            disabled={busy}
            onClick={() => action("start")}
          >
            {busy ? "starting…" : "Start"}
          </button>
        )}
      </div>

      {error && <div className="text-xs text-accent-red mb-2">error: {error}</div>}

      {/* Config editor (disabled while running). */}
      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <Field label="Half-spread (bps)"><input type="number" min={1} max={500} step={1} disabled={running} value={halfSpreadBps} onChange={(e) => setHalfSpread(+e.target.value)} className={NUMERIC} /></Field>
        <Field label="Per side ($)"><input type="number" min={1} max={1000} step={1} disabled={running} value={perSideUsd} onChange={(e) => setPerSide(+e.target.value)} className={NUMERIC} /></Field>
        <Field label="Max inv ($)"><input type="number" min={0} max={10000} step={1} disabled={running} value={maxInventoryUsd} onChange={(e) => setMaxInv(+e.target.value)} className={NUMERIC} /></Field>
        <Field label="Drift (bps)"><input type="number" min={1} max={500} step={1} disabled={running} value={driftBps} onChange={(e) => setDrift(+e.target.value)} className={NUMERIC} /></Field>
        <Field label="Skew (bps/$)"><input type="number" min={0} max={5} step={0.05} disabled={running} value={skewBpsPerDollar} onChange={(e) => setSkew(+e.target.value)} className={NUMERIC} /></Field>
        <Field label="Tick (ms)"><input type="number" min={1000} max={60000} step={500} disabled={running} value={tickMs} onChange={(e) => setTickMs(+e.target.value)} className={NUMERIC} /></Field>
      </div>

      {/* Microstructure config */}
      <div className="grid grid-cols-4 gap-2 mt-2 text-[11px]">
        <label className="flex items-center gap-2 text-zinc-300">
          <input type="checkbox" disabled={running} checked={useMicroprice} onChange={(e) => setUseMicroprice(e.target.checked)} />
          <span>Microprice fair</span>
        </label>
        <Field label="OBI threshold"><input type="number" min={0} max={1} step={0.05} disabled={running} value={obiToxicityThreshold} onChange={(e) => setObiToxThresh(+e.target.value)} className={NUMERIC} /></Field>
        <Field label="OBI max widen ×"><input type="number" min={1} max={10} step={0.1} disabled={running} value={obiToxicityMaxMultiplier} onChange={(e) => setObiToxMax(+e.target.value)} className={NUMERIC} /></Field>
        <Field label="Spread halt (bps)"><input type="number" min={0} max={5000} step={10} disabled={running} value={spreadAnomalyBps} onChange={(e) => setSpreadAnomaly(+e.target.value)} className={NUMERIC} /></Field>
      </div>

      {pnl && (
        <div className="grid grid-cols-4 gap-2 mt-3 text-xs">
          <Metric label="Position" value={pnl.position.toFixed(4)} />
          <Metric label="VWAP" value={pnl.vwap ? pnl.vwap.toFixed(2) : "—"} />
          <Metric label="Realised" value={fmtUsd(pnl.realisedUsd)} accent={pnl.realisedUsd >= 0 ? "green" : "red"} />
          <Metric label="Unrealised" value={fmtUsd(pnl.unrealisedUsd)} accent={pnl.unrealisedUsd >= 0 ? "green" : "red"} />
        </div>
      )}

      {/* Live signals from the most recent cycle. */}
      {status?.recentCycles && status.recentCycles.length > 0 && (() => {
        const last = status.recentCycles.at(-1)!;
        return (
          <div className="grid grid-cols-5 gap-2 mt-3 text-xs">
            <Metric label="Oracle" value={last.oracle ? last.oracle.toFixed(4) : "—"} />
            <Metric
              label="Microprice"
              value={last.microprice !== null ? last.microprice.toFixed(4) : "—"}
              accent={last.microprice && last.oracle && Math.abs(last.microprice - last.oracle) / last.oracle > 0.0005 ? "amber" : undefined}
            />
            <Metric
              label="OBI"
              value={last.obi.toFixed(3)}
              accent={last.obi > 0.2 ? "green" : last.obi < -0.2 ? "red" : undefined}
            />
            <Metric
              label="Quoted spread"
              value={last.quotedSpreadBps !== null ? `${last.quotedSpreadBps.toFixed(1)} bps` : "—"}
              accent={last.quotedSpreadBps && last.quotedSpreadBps > 50 ? "amber" : undefined}
            />
            <Metric
              label={last.paused ? `Paused (${last.paused})` : last.widenMult > 1 ? `Widen ${last.widenMult.toFixed(2)}×` : "Live"}
              value={last.paused ? "halted" : last.widenMult > 1 ? "toxic" : "ok"}
              accent={last.paused ? "red" : last.widenMult > 1 ? "amber" : "green"}
            />
          </div>
        );
      })()}

      {status?.resting && (
        <div className="grid grid-cols-2 gap-2 mt-3 text-[11px] tabular-nums">
          <div className="border border-ink-700 rounded p-2">
            <div className="text-[10px] uppercase tracking-wider text-accent-green">resting BID</div>
            {status.resting.BUY ? (
              <div className="text-zinc-200">{status.resting.BUY.size} @ {status.resting.BUY.price.toFixed(4)}</div>
            ) : (
              <div className="text-zinc-500">—</div>
            )}
          </div>
          <div className="border border-ink-700 rounded p-2">
            <div className="text-[10px] uppercase tracking-wider text-accent-red">resting ASK</div>
            {status.resting.SELL ? (
              <div className="text-zinc-200">{status.resting.SELL.size} @ {status.resting.SELL.price.toFixed(4)}</div>
            ) : (
              <div className="text-zinc-500">—</div>
            )}
          </div>
        </div>
      )}

      {(status?.recentCycles?.length ?? 0) > 0 && (
        <div className="mt-4">
          <div className="card-title">Recent cycles ({status!.recentCycles!.length})</div>
          <div className="space-y-[2px] text-[10px] tabular-nums max-h-40 overflow-y-auto">
            {status!.recentCycles!.slice(-20).reverse().map((c) => (
              <div key={c.cycle} className="flex justify-between">
                <span className="text-zinc-500">#{c.cycle}</span>
                <span className="text-zinc-300">{c.oracle.toFixed(4)}</span>
                <span className="text-accent-green">{c.bid?.toFixed(4) ?? "—"}</span>
                <span className="text-accent-red">{c.ask?.toFixed(4) ?? "—"}</span>
                <span className="text-zinc-500">{c.ms}ms</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(status?.recentFills?.length ?? 0) > 0 && (
        <div className="mt-4">
          <div className="card-title">Fills ({status!.recentFills!.length})</div>
          <div className="space-y-[2px] text-[10px] tabular-nums max-h-32 overflow-y-auto">
            {status!.recentFills!.slice(-20).reverse().map((f, i) => (
              <div key={i} className="flex justify-between">
                <span className={f.side === "BUY" ? "text-accent-green" : "text-accent-red"}>{f.side}</span>
                <span className="text-zinc-200">{f.size}@{f.price.toFixed(4)}</span>
                <span className="text-zinc-500">fee {fmtUsd(f.feeUsd)}</span>
                <span className="text-[10px] text-zinc-500">{new Date(f.ts).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {status?.lastError && (
        <div className="mt-3 text-[10px] text-accent-amber">last err: {status.lastError}</div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[9px] uppercase tracking-wider text-zinc-500 mb-1">{label}</div>
      {children}
    </label>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: "green" | "amber" | "red" }) {
  const cls = accent === "green" ? "text-accent-green" : accent === "red" ? "text-accent-red" : "text-zinc-100";
  return (
    <div className="border border-ink-700 rounded p-2">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${cls}`}>{value}</div>
    </div>
  );
}
