"use client";

import { useEffect, useRef, useState } from "react";

type Fill = {
  exchange: "ctf" | "neg-risk";
  txHash: string;
  blockNumber: number;
  orderHash: string;
  maker: string;
  taker: string;
  side: "BUY" | "SELL";
  tokenId: string;
  fee: string;
  receivedAt: number;
  price?: { tokenId: string; pricePerShare: number; sizeShares: number; makerSide: "BUY" | "SELL" } | null;
};

const MAX_FILLS = 200;

export function OnChainStream() {
  const [status, setStatus] = useState<string>("idle");
  const [fills, setFills] = useState<Fill[]>([]);
  const [stats, setStats] = useState({ count: 0, ctf: 0, negRisk: 0, lastTs: 0, startedAt: 0 });
  const startedRef = useRef(0);

  useEffect(() => {
    const es = new EventSource("/api/onchain/stream");
    startedRef.current = Date.now();
    es.addEventListener("status", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data);
        setStatus(d.status);
      } catch {}
    });
    es.addEventListener("fill", (e) => {
      try {
        const fill: Fill = JSON.parse((e as MessageEvent).data);
        setFills((prev) => [fill, ...prev].slice(0, MAX_FILLS));
        setStats((prev) => ({
          count: prev.count + 1,
          ctf: prev.ctf + (fill.exchange === "ctf" ? 1 : 0),
          negRisk: prev.negRisk + (fill.exchange === "neg-risk" ? 1 : 0),
          lastTs: fill.receivedAt,
          startedAt: prev.startedAt || Date.now(),
        }));
      } catch {}
    });
    es.addEventListener("heartbeat", () => {});
    es.onerror = () => setStatus("error");
    return () => es.close();
  }, []);

  const elapsed = stats.startedAt ? (Date.now() - stats.startedAt) / 1000 : 0;
  const rate = elapsed > 0 ? stats.count / elapsed : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-5 gap-3">
        <Stat label="SSE status" value={status} accent={status === "open" ? "green" : status === "error" ? "red" : "amber"} />
        <Stat label="Total fills" value={stats.count.toString()} />
        <Stat label="CTF v2" value={stats.ctf.toString()} />
        <Stat label="Neg Risk" value={stats.negRisk.toString()} />
        <Stat label="Rate" value={`${rate.toFixed(1)}/s`} />
      </div>

      <div className="card">
        <h2 className="card-title">Live fills ({fills.length} shown, max {MAX_FILLS})</h2>
        {fills.length === 0 ? (
          <p className="text-zinc-500 text-xs">Waiting for first fill — confirm connection above is `open`.</p>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>Time</th>
                <th>Exch</th>
                <th>Token</th>
                <th>Maker side</th>
                <th>Shares</th>
                <th>Price</th>
                <th>Notional</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {fills.map((f) => (
                <tr key={f.txHash + "-" + f.orderHash}>
                  <td className="text-xs text-zinc-400">{new Date(f.receivedAt).toISOString().slice(11, 23)}</td>
                  <td>
                    <span className={`pill-${f.exchange === "neg-risk" ? "amber" : "blue"}`}>{f.exchange === "ctf" ? "ctf-v2" : "neg-risk"}</span>
                  </td>
                  <td className="font-mono text-[10px] text-zinc-400">{f.price?.tokenId.slice(0, 12)}…</td>
                  <td className={f.side === "BUY" ? "text-accent-green" : "text-accent-red"}>{f.side}</td>
                  <td className="tabular-nums">{f.price?.sizeShares.toFixed(2) ?? "—"}</td>
                  <td className="tabular-nums">{f.price ? `$${f.price.pricePerShare.toFixed(4)}` : "—"}</td>
                  <td className="tabular-nums text-zinc-300">{f.price ? `$${(f.price.sizeShares * f.price.pricePerShare).toFixed(2)}` : "—"}</td>
                  <td>
                    <a className="font-mono text-[10px] text-accent-blue hover:underline" href={`https://polygonscan.com/tx/${f.txHash}`} target="_blank" rel="noopener noreferrer">{f.txHash.slice(0, 10)}…</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">Why this matters</h2>
        <p className="text-xs text-zinc-400 leading-relaxed">
          The CLOB websocket reports book-state updates; the on-chain <code>OrderFilled</code> feed reports
          settled transactions. They arrive at different times — on-chain fills are reflected in the CLOB book
          ~100–500ms later. Watching this feed directly is one notch closer to the on-chain truth than the
          CLOB ws, and the price impact is visible here before the public midpoint moves.
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: "red" | "amber" | "green" }) {
  const cls = accent === "red" ? "text-accent-red" : accent === "amber" ? "text-accent-amber" : accent === "green" ? "text-accent-green" : "";
  return <div className="card"><div className="card-title">{label}</div><div className={`stat ${cls}`}>{value}</div></div>;
}
