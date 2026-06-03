import { describe, it, expect } from "vitest";
import { snapshotFromWindow } from "@/lib/arena/context";
import type { Snapshot, SnapshotWindow } from "@/lib/arena/types";

const snap = (price: number, captured_at: string, over: Partial<Snapshot> = {}): Snapshot =>
  ({ venue: "sim-coinbase", market_id: "BTC-USD", price, captured_at, ...over });
const mkWin = (history: Snapshot[]): SnapshotWindow => ({ history, latest: history[history.length - 1] });
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe("snapshotFromWindow — shared sim/live snapshot mapper (F2 parity)", () => {
  it("carries midPrice + latest bid/ask", () => {
    const w = mkWin([snap(100, "2026-01-01T00:00:00Z", { bid: 99.5, ask: 100.5 })]);
    const s = snapshotFromWindow(w, 100.25);
    expect(s.midPrice).toBe(100.25);             // the passed mid, not the snapshot price
    expect(s.bestBid).toBe(99.5);
    expect(s.bestAsk).toBe(100.5);
  });

  it("maps history → {ts(unix), price} ticks, oldest→newest", () => {
    const w = mkWin([
      snap(100, "2026-01-01T00:00:00Z"),
      snap(101, "2026-01-01T00:05:00Z"),
      snap(102, "2026-01-01T00:10:00Z"),
    ]);
    const t = snapshotFromWindow(w, 101).ticks!;
    expect(t).toHaveLength(3);
    expect(t.map((x) => x.price)).toEqual([100, 101, 102]);
    expect(t[0].ts).toBe(unix("2026-01-01T00:00:00Z"));
    expect(t[2].ts).toBe(unix("2026-01-01T00:10:00Z"));
  });

  it("caps the tick history at the most-recent 100", () => {
    const hist = Array.from({ length: 150 }, (_, i) => snap(100 + i, `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00Z`));
    const t = snapshotFromWindow(mkWin(hist), 100).ticks!;
    expect(t).toHaveLength(100);
    expect(t[t.length - 1].price).toBe(100 + 149); // newest kept
    expect(t[0].price).toBe(100 + 50);             // first 50 dropped
  });

  it("an unparseable captured_at maps to ts 0 (never NaN)", () => {
    const t = snapshotFromWindow(mkWin([snap(100, "not-a-date")]), 100).ticks!;
    expect(t[0].ts).toBe(0);
    expect(Number.isNaN(t[0].ts)).toBe(false);
  });

  it("a latest without bid/ask yields undefined bid/ask (no crash)", () => {
    const s = snapshotFromWindow(mkWin([snap(100, "2026-01-01T00:00:00Z")]), 100);
    expect(s.bestBid).toBeUndefined();
    expect(s.bestAsk).toBeUndefined();
  });

  it("is deterministic", () => {
    const w = mkWin([snap(100, "2026-01-01T00:00:00Z", { bid: 99, ask: 101 }), snap(102, "2026-01-01T00:05:00Z")]);
    expect(snapshotFromWindow(w, 101)).toEqual(snapshotFromWindow(w, 101));
  });
});
