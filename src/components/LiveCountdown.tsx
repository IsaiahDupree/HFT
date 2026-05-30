"use client";

import { useEffect, useState } from "react";

/**
 * Client-side countdown updated every 1s. Two display variants:
 *   variant="big"     → Polymarket-style "Mins / Secs" big digits (centerpiece)
 *   variant="inline"  → compact "MM:SS" in a single line
 *
 * Window math: the target tick is the next multiple of `intervalMin` minutes
 * (UTC). When it crosses, the countdown auto-rolls to the next window — no
 * page reload needed.
 */
export function LiveCountdown({ intervalMin = 5, variant = "big" }: { intervalMin?: number; variant?: "big" | "inline" }) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!now) {
    return variant === "big"
      ? <div data-testid="live-countdown" className="font-mono text-3xl tabular-nums text-zinc-300">
          <span data-testid="live-countdown-mins">––</span>:<span data-testid="live-countdown-secs">––</span>
        </div>
      : <span className="font-mono tabular-nums" data-testid="live-countdown-inline">––:––</span>;
  }
  const minuteOffset = now.getUTCMinutes() % intervalMin;
  const totalSecondsLeft = (intervalMin - minuteOffset) * 60 - now.getUTCSeconds();
  const mins = Math.max(0, Math.floor(totalSecondsLeft / 60));
  const secs = Math.max(0, totalSecondsLeft % 60);
  const mm = String(mins).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  const danger = totalSecondsLeft <= 30;

  if (variant === "inline") {
    return <span className={`font-mono tabular-nums ${danger ? "text-accent-red" : "text-zinc-200"}`}>{mm}:{ss}</span>;
  }

  return (
    <div className="inline-flex items-baseline gap-1" data-testid="live-countdown">
      <span data-testid="live-countdown-mins" className={`font-mono text-4xl tabular-nums leading-none ${danger ? "text-accent-red" : "text-zinc-100"}`}>{mm}</span>
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">mins</span>
      <span data-testid="live-countdown-secs" className={`font-mono text-4xl tabular-nums leading-none ml-2 ${danger ? "text-accent-red" : "text-zinc-100"}`}>{ss}</span>
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">secs</span>
    </div>
  );
}

/**
 * Window range label like "5:15-5:20PM ET" — the polymarket title format.
 * Re-renders every second so it flips at minute boundaries.
 */
export function WindowRangeLabel({ intervalMin = 5 }: { intervalMin?: number }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!now) return <span className="text-zinc-500">…</span>;
  const m = now.getMinutes();
  const startMin = m - (m % intervalMin);
  const start = new Date(now);
  start.setMinutes(startMin, 0, 0);
  const end = new Date(start);
  end.setMinutes(start.getMinutes() + intervalMin);
  const fmt = (d: Date) => {
    let h = d.getHours();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${mm}${ampm}`;
  };
  const dateLbl = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return <span className="text-xs text-zinc-400">{dateLbl}, {fmt(start)}-{fmt(end)}</span>;
}
