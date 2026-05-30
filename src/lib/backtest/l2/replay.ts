/**
 * Replay adapter — load a captured JSONL stream of MarketEvents (one JSON object
 * per line, written by scripts/capture-l2.ts) and feed it to the L2 backtester.
 * Deterministic: events are sorted by (ts, then file order).
 */
import { readFileSync } from "node:fs";
import type { MarketEvent } from "./engine";

export function loadCaptureJsonl(path: string): MarketEvent[] {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  const events: MarketEvent[] = [];
  for (const l of lines) {
    try {
      const ev = JSON.parse(l) as MarketEvent;
      if (ev && typeof ev.ts === "number" && (ev.kind === "book" || ev.kind === "trade")) events.push(ev);
    } catch { /* skip malformed line */ }
  }
  // stable sort by ts (preserve original order for equal ts)
  return events.map((e, i) => ({ e, i })).sort((a, b) => (a.e.ts - b.e.ts) || (a.i - b.i)).map((x) => x.e);
}
