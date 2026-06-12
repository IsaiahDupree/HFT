/**
 * pmxt — TypeScript consumer for the PMXT L2 JSONL extracts produced by
 * scripts/pmxt_extract.py (PMXT raw archive -> per-token chronological top-N
 * book-update stream; see docs/research/PMXT-LOADER.md).
 *
 * Line formats (ts = epoch ms UTC, ladders best-first):
 *   {"type":"book","ts":...,"bids":[[px,sz],...],"asks":[[px,sz],...]}
 *   {"type":"trade","ts":...,"price":px,"size":sz,"aggressor":"BUY"|"SELL"}
 *
 * Bridges:
 *   toMarketEvents()  -> the snapshot replayer / maker-fill calibrator
 *                        (MarketEvent, ts in SECONDS — that engine's clock)
 *   toQueueEvents()   -> the queue-position fill model (queue-fill.ts),
 *                        keeping epoch-ms timestamps
 */
import { createReadStream } from "node:fs";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

import type { MarketEvent } from "./l2/engine";
import { levelSizeAt, tradeHitsQuote, type QueueEvent, type RestingQuote } from "./queue-fill";

/** [price, size] ladder row, best-first (bids desc px, asks asc px). */
export type Ladder = ReadonlyArray<readonly [number, number]>;

export type PmxtBook = { type: "book"; ts: number; bids: Ladder; asks: Ladder };
export type PmxtTrade = { type: "trade"; ts: number; price: number; size: number; aggressor: "BUY" | "SELL" };
export type PmxtEvent = PmxtBook | PmxtTrade;

/** Parse one JSONL line; throws on malformed input (bad extracts must not pass silently). */
export function parsePmxtLine(line: string): PmxtEvent {
  const o = JSON.parse(line);
  if (o.type !== "book" && o.type !== "trade") throw new Error(`pmxt: unknown event type ${String(o.type)}`);
  return o as PmxtEvent;
}

/** Whole-file sync load — fine for single-market extracts (tens of MB). */
export function loadPmxtJsonl(path: string): PmxtEvent[] {
  const out: PmxtEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length) out.push(parsePmxtLine(line));
  }
  return out;
}

/** Streaming load for multi-hour / multi-market files. */
export async function* streamPmxtJsonl(path: string): AsyncGenerator<PmxtEvent> {
  const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim().length) yield parsePmxtLine(line);
  }
}

/**
 * Convert to the snapshot engine's MarketEvent stream (ts in SECONDS).
 * One-sided books (warmup before the first snapshot, post-resolution collapse)
 * carry no usable touch — they are skipped, never invented.
 */
export function toMarketEvents(events: readonly PmxtEvent[]): MarketEvent[] {
  const out: MarketEvent[] = [];
  for (const e of events) {
    if (e.type === "trade") {
      out.push({ ts: e.ts / 1000, kind: "trade", price: e.price, size: e.size, aggressor: e.aggressor });
    } else if (e.bids.length && e.asks.length) {
      out.push({
        ts: e.ts / 1000,
        kind: "book",
        bidPx: e.bids[0][0],
        bidSz: e.bids[0][1],
        askPx: e.asks[0][0],
        askSz: e.asks[0][1],
      });
    }
  }
  return out;
}

/**
 * Project the stream onto one resting quote for the queue-fill model: every
 * book update becomes the visible size at OUR price on OUR side; trades that
 * could touch our quote pass through; everything else is dropped. Timestamps
 * stay in epoch ms — use the same clock for quote.postedTs.
 */
export function toQueueEvents(events: readonly PmxtEvent[], quote: RestingQuote): QueueEvent[] {
  const out: QueueEvent[] = [];
  for (const e of events) {
    if (e.type === "book") {
      const ladder = quote.side === "bid" ? e.bids : e.asks;
      out.push({ ts: e.ts, kind: "level", size: levelSizeAt(ladder, quote.price) });
    } else {
      const t = { ts: e.ts, kind: "trade" as const, price: e.price, size: e.size, aggressor: e.aggressor };
      if (tradeHitsQuote(quote, t)) out.push(t);
    }
  }
  return out;
}
