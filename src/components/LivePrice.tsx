"use client";

import { useEffect, useState } from "react";
import { DigitRoller } from "./DigitRoller";

/**
 * Polls /api/crypto/dashboard for the given symbol's live price every N
 * seconds and renders it through the digit roller. Pure presentation;
 * doesn't write to state anywhere else.
 */
export function LivePrice({ productId, intervalMs = 5_000, className = "" }: { productId: string; intervalMs?: number; className?: string }) {
  const [price, setPrice] = useState<number | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/crypto/dashboard", { cache: "no-store" });
        const data = await r.json();
        const panel = (data?.coinbase ?? []).find((p: { product_id: string }) => p.product_id === productId);
        if (!cancelled && panel?.price != null) {
          setPrice(panel.price);
          setStale(false);
        }
      } catch {
        if (!cancelled) setStale(true);
      }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [productId, intervalMs]);

  if (price == null) {
    return <span className={`font-mono ${className} text-zinc-500`}>$––,––</span>;
  }
  // 2-decimal display for prices >= 1; 4-decimal for sub-dollar (DOGE, XRP).
  const formatted = price >= 1
    ? price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : price.toFixed(4);
  return (
    <span className={stale ? "opacity-50" : ""}>
      <DigitRoller value={formatted} prefix="$" className={className} />
    </span>
  );
}
