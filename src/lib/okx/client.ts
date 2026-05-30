/**
 * OKX public-data client — read-only candle fetcher used to feed BNB and
 * HYPE 1-min bars to the arena. Binance is geoblocked from US IPs and
 * Coinbase doesn't list either asset, so OKX is the simplest provider that
 * returns clean 1-min OHLC for both.
 *
 * No auth: only the public `/api/v5/market/candles` endpoint is used.
 *
 * Shape of the response data row:
 *   [ts_ms, open, high, low, close, volBase, volQuote, volQuoteCcy, confirm]
 * (sorted newest first — caller flips to oldest-first to match the rest of
 *  the codebase).
 */

const OKX_BASE = "https://www.okx.com/api/v5";

function fetchTimeoutMs(): number {
  return Number(process.env.OKX_FETCH_TIMEOUT_MS ?? "10000");
}

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url, {
    method: "GET",
    cache: "no-store",
    signal: AbortSignal.timeout(fetchTimeoutMs()),
  });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.json() as Promise<T>;
}

export type OkxCandle = {
  ts_unix: number;     // candle start (epoch seconds)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;      // base-asset volume
  is_complete: boolean;
};

export const okx = {
  /**
   * Fetch 1-min candles for an OKX spot instrument (e.g. "BNB-USDT").
   * Returns oldest-first. `limit` capped to 300 (OKX max).
   */
  publicGetCandles: async (instId: string, opts: { bar?: string; limit?: number } = {}): Promise<OkxCandle[]> => {
    const bar = opts.bar ?? "1m";
    const limit = Math.min(opts.limit ?? 100, 300);
    const url = `${OKX_BASE}/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${limit}`;
    const resp = await get<{ code: string; msg: string; data: string[][] }>(url);
    if (resp.code !== "0") throw new Error(`OKX candles ${instId}: ${resp.msg ?? "non-zero code"}`);
    const rows = (resp.data ?? []).map((r): OkxCandle => ({
      ts_unix: Math.floor(Number(r[0]) / 1000),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
      is_complete: r[8] === "1",
    }));
    // OKX returns newest-first; flip to oldest-first to match coinbase/coindesk.
    rows.sort((a, b) => a.ts_unix - b.ts_unix);
    return rows;
  },
};
