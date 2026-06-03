/**
 * kraken — keyless public OHLC adapter (https://api.kraken.com/0/public/OHLC). A second,
 * independent price source so backtests aren't hostage to a single venue's data, and so the
 * cross-venue check (./cross-venue.ts) can confirm Coinbase candles or flag single-source
 * artifacts. Pure parser + pair/interval mappers + a thin fetch wrapper. No auth, no SDK.
 *
 *   const cands = await fetchKrakenOHLC("BTC-USD", "ONE_DAY");
 */
import { sanitizeCandles, type VenueCandle } from "./venue-candles";

/** Kraken OHLC `interval` is in MINUTES. Map our warehouse granularity strings to it. */
export const KRAKEN_INTERVAL_MIN: Record<string, number> = {
  ONE_MINUTE: 1, FIVE_MINUTE: 5, FIFTEEN_MINUTE: 15, THIRTY_MINUTE: 30,
  ONE_HOUR: 60, FOUR_HOUR: 240, ONE_DAY: 1440, ONE_WEEK: 10080,
};

export function krakenInterval(granularity: string): number {
  // Object.hasOwn (not `[granularity]` + null-check) so inherited keys like "toString" /
  // "constructor" reject cleanly instead of resolving to an Object.prototype member.
  if (!Object.hasOwn(KRAKEN_INTERVAL_MIN, granularity)) {
    throw new Error(`kraken: unsupported granularity ${granularity}`);
  }
  return KRAKEN_INTERVAL_MIN[granularity];
}

// Kraken uses legacy asset codes for a few bases (XBT=Bitcoin, XDG=Dogecoin).
const BASE_ALIAS: Record<string, string> = { BTC: "XBT", DOGE: "XDG" };

/** "BTC-USD" → "XBTUSD" (Kraken's request pair). Accepts "BTC/USD" or "BTC-USD". */
export function krakenPair(product: string): string {
  const [base, quote] = product.toUpperCase().split(/[-/]/);
  if (!base || !quote) throw new Error(`kraken: bad product ${product}`);
  return `${BASE_ALIAS[base] ?? base}${quote}`;
}

type KrakenOHLCResponse = { error?: string[]; result?: Record<string, unknown> };

/**
 * Parse a Kraken OHLC response into normalized candles. Kraken row order is
 * `[time, open, high, low, close, vwap, volume, count]` (true OHLC). The result object keys
 * the data under Kraken's canonical pair name (e.g. "XXBTZUSD") plus a "last" cursor — we
 * take the single non-"last" key. Runs the shared sanitizer (drops bad/dup rows, sorts).
 */
export function parseKrakenOHLC(json: KrakenOHLCResponse): VenueCandle[] {
  if (json.error && json.error.length) throw new Error(`kraken API error: ${json.error.join("; ")}`);
  const result = json.result;
  if (!result) throw new Error("kraken: missing result");
  const key = Object.keys(result).find((k) => k !== "last");
  if (!key) return [];
  const rows = result[key];
  if (!Array.isArray(rows)) throw new Error("kraken: result is not an array");
  const cands: VenueCandle[] = rows.map((r: unknown[]) => ({
    start_unix: Number(r[0]), open: +String(r[1]), high: +String(r[2]),
    low: +String(r[3]), close: +String(r[4]), volume: +String(r[6] ?? 0),
  }));
  return sanitizeCandles(cands);
}

function krakenHost(): string {
  return (process.env.KRAKEN_HOST ?? "https://api.kraken.com").replace(/\/$/, "");
}
function fetchTimeoutMs(): number {
  return Number(process.env.KRAKEN_FETCH_TIMEOUT_MS ?? "10000");
}

/** Fetch + parse Kraken OHLC for a product. Keyless. `since` is an optional unix-seconds floor. */
export async function fetchKrakenOHLC(product: string, granularity: string, opts: { since?: number } = {}): Promise<VenueCandle[]> {
  const params = new URLSearchParams({ pair: krakenPair(product), interval: String(krakenInterval(granularity)) });
  if (opts.since != null) params.set("since", String(opts.since));
  const url = `${krakenHost()}/0/public/OHLC?${params.toString()}`;
  const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(fetchTimeoutMs()) });
  if (!r.ok) throw new Error(`kraken OHLC ${product} → ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return parseKrakenOHLC((await r.json()) as KrakenOHLCResponse);
}
