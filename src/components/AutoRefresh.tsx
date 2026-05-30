"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Drop-in client component that calls router.refresh() on an interval. Has
 * a small top-right pause toggle so the operator can freeze the view while
 * inspecting something. router.refresh() re-runs the server components
 * without scrolling or losing state — much smoother than meta-refresh.
 *
 * Renders NOTHING on the server — only mounts client-side after first effect.
 * This sidesteps all hydration mismatches caused by:
 *   - locale-dependent time formatting (toLocaleTimeString varies)
 *   - browser extensions that rewrite the DOM (dark-mode helpers, ad blockers,
 *     password managers all sometimes inject siblings or wrappers near
 *     fixed-position floating UI)
 *   - hot-reload state drift across structural edits to the parent layout
 *
 * The trade-off is a ~50ms flash where the badge isn't visible on first load.
 * Acceptable for a debug-only badge that doesn't affect functionality.
 */
export function AutoRefresh({ intervalMs = 30_000, label = "auto-refresh" }: { intervalMs?: number; label?: string }) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [lastTick, setLastTick] = useState<Date | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (paused || !mounted) return;
    const id = setInterval(() => {
      router.refresh();
      setLastTick(new Date());
    }, intervalMs);
    return () => clearInterval(id);
  }, [paused, intervalMs, router, mounted]);

  // Don't render anything during SSR or first client render — eliminates all
  // hydration mismatch risk for this component.
  if (!mounted) return null;

  const seconds = Math.round(intervalMs / 1000);
  return (
    <div className="fixed top-20 right-6 z-10 flex items-center gap-2 text-[10px] bg-ink-900 border border-ink-800 rounded px-2 py-1 text-zinc-400">
      <button
        type="button"
        onClick={() => setPaused((p) => !p)}
        className={`px-1 ${paused ? "text-accent-amber" : "text-accent-green"}`}
        title={paused ? "auto-refresh paused — click to resume" : "auto-refresh active — click to pause"}
      >
        {paused ? "▶" : "⏸"}
      </button>
      <span>{paused ? "paused" : `${label} ${seconds}s`}</span>
      {lastTick && !paused && (
        <span className="text-zinc-600">· last {lastTick.toLocaleTimeString()}</span>
      )}
    </div>
  );
}
