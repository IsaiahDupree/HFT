"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Trade = {
  id: number;
  tick_at: string;
  venue: string;
  market_id: string;
  intent: string;
  side: string;
  price: number;
  size_usd: number;
  realized_pnl_usd: number | null;
  agent_id: number;
  agent_name: string;
  generation: number;
};

const REFRESH_MS = 30_000;
const LIMIT = 12;

/**
 * Sticky-bottom horizontal ticker of the last N paper trades. Refreshes
 * every 30s. Auto-scrolls via CSS keyframe; pauses on hover so you can
 * click into agent detail.
 */
export function TradeTicker() {
  const [trades, setTrades] = useState<Trade[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/arena/recent-trades?limit=${LIMIT}`);
        const data = await r.json();
        if (!cancelled) setTrades(data?.trades ?? []);
      } catch { /* ignore */ }
    };
    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (trades.length === 0) {
    return (
      <div className="fixed bottom-0 left-0 right-0 bg-ink-900 border-t border-ink-800 text-[10px] text-zinc-500 px-6 py-1 z-20">
        TRADES — no fills yet. <span className="text-zinc-600">Random walkers + momentum agents fire as data accumulates.</span>
      </div>
    );
  }

  // Duplicate the list so the marquee loops seamlessly.
  const doubled = [...trades, ...trades];

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-ink-900 border-t border-ink-800 text-[10px] z-20 overflow-hidden">
      <div className="flex items-center px-6 py-1 gap-6">
        <span className="text-zinc-500 font-semibold shrink-0">TRADES ({trades.length})</span>
        <div className="relative flex-1 overflow-hidden">
          <div className="flex gap-8 ticker-track whitespace-nowrap">
            {doubled.map((t, i) => (
              <Link key={`${t.id}-${i}`} href={`/arena/${t.agent_id}`} className="shrink-0 hover:text-zinc-100">
                <span className="text-zinc-500">{new Date(t.tick_at).toLocaleTimeString()}</span>{" "}
                <span className="text-zinc-300">{t.agent_name}</span>{" "}
                <span className={t.side === "BUY" ? "text-accent-green" : "text-accent-red"}>{t.intent}/{t.side}</span>{" "}
                <span className="text-zinc-400">{t.venue.replace("sim-", "")}:{t.market_id.slice(0, 8)}</span>{" "}
                <span className="text-zinc-300 tabular-nums">${t.size_usd.toFixed(2)}</span>
                {t.realized_pnl_usd != null && (
                  <span className={`tabular-nums ${t.realized_pnl_usd >= 0 ? "text-accent-green" : "text-accent-red"}`}>
                    {" "}({t.realized_pnl_usd >= 0 ? "+" : ""}${t.realized_pnl_usd.toFixed(2)})
                  </span>
                )}
                <span className="text-zinc-700"> ◆</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
