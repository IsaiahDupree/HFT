/**
 * OKX public client tests.
 *
 * Verifies:
 *   - response shape is parsed correctly ([ts_ms, o, h, l, c, vol, ...])
 *   - candles are flipped to oldest-first (OKX returns newest-first)
 *   - ts_ms is converted to ts_unix
 *   - is_complete is read from the 9th element ("1" → true)
 *   - non-zero error code throws
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

describe("okx.publicGetCandles", () => {
  it("parses the OKX kline shape and reverses to oldest-first", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: "0",
        msg: "",
        // OKX returns NEWEST first
        data: [
          ["1779795300000", "662.8", "663.0", "662.5", "662.9", "0.5", "331.45", "331.45", "0"],
          ["1779795240000", "663.1", "663.2", "662.4", "662.7", "25.0", "16575.0", "16575.0", "1"],
          ["1779795180000", "663.5", "663.6", "663.0", "663.1", "30.0", "19890.0", "19890.0", "1"],
        ],
      }),
    } as Response));

    const { okx } = await import("@/lib/okx/client");
    const candles = await okx.publicGetCandles("BNB-USDT", { bar: "1m", limit: 3 });

    expect(candles).toHaveLength(3);
    // Oldest-first now
    expect(candles[0].ts_unix).toBe(1779795180);
    expect(candles[1].ts_unix).toBe(1779795240);
    expect(candles[2].ts_unix).toBe(1779795300);
    // OHLC parsed as numbers
    expect(candles[0].open).toBe(663.5);
    expect(candles[0].close).toBe(663.1);
    expect(candles[0].volume).toBe(30);
    // is_complete from element 8
    expect(candles[2].is_complete).toBe(false);  // "0"
    expect(candles[1].is_complete).toBe(true);   // "1"
  });

  it("throws on non-zero code", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ code: "50011", msg: "Rate limited", data: [] }),
    } as Response));
    const { okx } = await import("@/lib/okx/client");
    await expect(okx.publicGetCandles("BNB-USDT")).rejects.toThrow(/OKX candles BNB-USDT/);
  });

  it("throws on HTTP error", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as Response));
    const { okx } = await import("@/lib/okx/client");
    await expect(okx.publicGetCandles("BNB-USDT")).rejects.toThrow(/503/);
  });

  it("caps `limit` at 300 (OKX max)", async () => {
    const captured: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      captured.push(String(url));
      return { ok: true, json: async () => ({ code: "0", msg: "", data: [] }) } as Response;
    });
    const { okx } = await import("@/lib/okx/client");
    await okx.publicGetCandles("BNB-USDT", { limit: 1000 });
    expect(captured[0]).toMatch(/limit=300/);
  });
});
