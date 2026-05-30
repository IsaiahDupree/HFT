"use client";

import { useEffect, useState } from "react";

/**
 * Polymarket-style digit roller: each digit is a fixed-height window onto a
 * vertical 0-9 column that translateY-animates when the value changes.
 * Pass a `value` string (e.g. "77295.69") and we render each character —
 * digits get the roller treatment, separators ($,.,) stay static.
 *
 * Use for live-changing prices where you want a satisfying visual "tick"
 * rather than a value that just swaps in place.
 */
export function DigitRoller({ value, prefix = "$", className = "" }: { value: string; prefix?: string; className?: string }) {
  return (
    <span className={`inline-flex items-center font-mono tabular-nums ${className}`} data-testid="digit-roller">
      {prefix && <span className="mr-1">{prefix}</span>}
      {value.split("").map((ch, i) => {
        if (/\d/.test(ch)) return <Digit key={i} d={Number(ch)} />;
        return <span key={i} className="mx-0.5">{ch}</span>;
      })}
    </span>
  );
}

function Digit({ d }: { d: number }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  // The reel is `1em × 10` tall; translateY by `-d` em to show digit d.
  // While unmounted, snap (no transition) to avoid the SSR→hydration jolt.
  const translate = `translateY(-${d}em)`;
  return (
    <span className="relative inline-block overflow-hidden" style={{ height: "1em", width: "0.6em" }} aria-label={`${d}`}>
      <span
        className="absolute top-0 left-0 right-0 flex flex-col leading-[1em]"
        style={{ transform: translate, transition: mounted ? "transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)" : "none" }}
      >
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => <span key={n}>{n}</span>)}
      </span>
    </span>
  );
}
