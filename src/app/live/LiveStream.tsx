"use client";

import { useEffect, useRef, useState } from "react";
import { subscribeMarket, type MarketWsMessage } from "@/lib/polymarket/ws";

type Seed = { tokenId: string; question: string; outcome: string };
type RowState = {
  tokenId: string;
  question: string;
  outcome: string;
  bestBid: string;
  bestAsk: string;
  lastPrice: string;
  bidSize: string;
  askSize: string;
  updates: number;
  lastUpdateMs: number;
};

export function LiveStream({ seeds }: { seeds: Seed[] }) {
  const [status, setStatus] = useState<"connecting" | "open" | "closed" | "error">("connecting");
  const [rows, setRows] = useState<Record<string, RowState>>(() =>
    Object.fromEntries(
      seeds.map((s) => [s.tokenId, { ...s, bestBid: "—", bestAsk: "—", lastPrice: "—", bidSize: "—", askSize: "—", updates: 0, lastUpdateMs: 0 }]),
    ),
  );
  const stateRef = useRef(rows);

  useEffect(() => {
    if (seeds.length === 0) return;
    const ids = seeds.map((s) => s.tokenId);

    const apply = (id: string, patch: Partial<RowState>) => {
      const prev = stateRef.current[id];
      if (!prev) return;
      const next = { ...prev, ...patch, updates: prev.updates + 1, lastUpdateMs: Date.now() };
      stateRef.current = { ...stateRef.current, [id]: next };
      setRows(stateRef.current);
    };

    const stop = subscribeMarket({
      assetIds: ids,
      customFeatures: true,
      onStatus: setStatus,
      onMessage: (msg: MarketWsMessage) => {
        const id = (msg.asset_id ?? msg.market ?? "") as string;
        if (!id || !stateRef.current[id]) return;
        const top = (side: "bid" | "ask"): { p: string; s: string } => {
          if (side === "bid") {
            const list = msg.bids ?? [];
            const best = list.length > 0 ? list[list.length - 1] : null;
            return { p: best?.price ?? "—", s: best?.size ?? "—" };
          }
          const list = msg.asks ?? [];
          const best = list.length > 0 ? list[0] : null;
          return { p: best?.price ?? "—", s: best?.size ?? "—" };
        };
        if (msg.event_type === "book" || msg.bids || msg.asks) {
          const bid = top("bid");
          const ask = top("ask");
          apply(id, { bestBid: bid.p, bestAsk: ask.p, bidSize: bid.s, askSize: ask.s });
        } else if (msg.event_type === "price_change" && Array.isArray(msg.changes)) {
          // simplistic: just record we saw an incremental change
          apply(id, {});
        } else if (msg.event_type === "best_bid_ask") {
          apply(id, { bestBid: (msg.best_bid as string) ?? stateRef.current[id].bestBid, bestAsk: (msg.best_ask as string) ?? stateRef.current[id].bestAsk });
        } else if (msg.event_type === "last_trade_price") {
          apply(id, { lastPrice: (msg.price as string) ?? stateRef.current[id].lastPrice });
        }
      },
    });
    return stop;
  }, [seeds]);

  return (
    <div className="card">
      <div className="flex items-center gap-3 text-xs text-zinc-500 mb-3">
        <span className={`pill-${status === "open" ? "green" : status === "connecting" ? "amber" : "red"}`}>{status}</span>
        <span>{seeds.length} subscribed token{seeds.length === 1 ? "" : "s"}</span>
      </div>
      <table className="list">
        <thead>
          <tr>
            <th>Market</th>
            <th>Outcome</th>
            <th>Bid</th>
            <th>Bid sz</th>
            <th>Ask</th>
            <th>Ask sz</th>
            <th>Last</th>
            <th>Updates</th>
            <th>Last upd</th>
          </tr>
        </thead>
        <tbody>
          {Object.values(rows).map((r) => (
            <tr key={r.tokenId}>
              <td className="max-w-md truncate">{r.question}</td>
              <td>{r.outcome}</td>
              <td className="text-accent-green tabular-nums">{r.bestBid}</td>
              <td className="text-zinc-400 tabular-nums">{r.bidSize}</td>
              <td className="text-accent-red tabular-nums">{r.bestAsk}</td>
              <td className="text-zinc-400 tabular-nums">{r.askSize}</td>
              <td className="tabular-nums">{r.lastPrice}</td>
              <td className="tabular-nums text-zinc-400">{r.updates}</td>
              <td className="tabular-nums text-xs text-zinc-500">{r.lastUpdateMs ? `${((Date.now() - r.lastUpdateMs) / 1000).toFixed(1)}s ago` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
