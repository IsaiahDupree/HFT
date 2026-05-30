/**
 * CoinDesk Data API (data-api.coindesk.com, the rebranded CryptoCompare
 * surface). Used to backfill years of 1-min OHLCV per instrument into
 * `coindesk_candles` so arena strategies have real backtest depth without
 * waiting for live Coinbase snapshots to accumulate.
 *
 * Auth: API key works both as `Authorization: Apikey <key>` header and as
 * `api_key` query param. We use the query param form because it survives
 * proxies + simplifies caching. Key is loaded from `COINDESK_API_KEY` env.
 *
 * Pagination: the historical-minutes endpoint returns up to 2000 bars per
 * call, ordered newest-first when `to_ts` is set. To walk back to coin
 * origination, we keep stepping `to_ts` backwards by (returned bar count ×
 * 60s) until the response is empty.
 */

const DEFAULT_HOST = "https://data-api.coindesk.com";
const LEGACY_HOST = "https://min-api.cryptocompare.com";

function host(): string {
  return (process.env.COINDESK_HOST ?? DEFAULT_HOST).replace(/\/$/, "");
}
function apiKey(): string {
  const k = process.env.COINDESK_API_KEY ?? "";
  if (!k) throw new Error("COINDESK_API_KEY is not set in env");
  return k;
}

type Query = Record<string, string | number | boolean | undefined>;

function buildUrl(base: string, path: string, query: Query): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    qs.set(k, String(v));
  }
  // Auth via query so cache/CDN friendly + matches the docs' default examples.
  qs.set("api_key", apiKey());
  return `${base}${path}?${qs.toString()}`;
}

/** Per-request timeout. CoinDesk usually responds in <2s; 15s is generous
 *  because some historical-backfill endpoints stream large payloads. Override
 *  via COINDESK_FETCH_TIMEOUT_MS. Audit fix F2. */
function fetchTimeoutMs(): number {
  return Number(process.env.COINDESK_FETCH_TIMEOUT_MS ?? "15000");
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, {
    method: "GET", cache: "no-store",
    signal: AbortSignal.timeout(fetchTimeoutMs()),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`coindesk GET → ${r.status} ${text.slice(0, 240)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`coindesk GET → 200 but unparseable JSON: ${text.slice(0, 240)}`);
  }
}

// ----------------------------------------------------------------- types

/** One row of OHLCV from /spot/v1/historical/minutes (and hours/days). */
export type CoinDeskCandle = {
  UNIT: "MINUTE" | "HOUR" | "DAY";
  TIMESTAMP: number;            // epoch seconds (start of the bar)
  MARKET: string;               // exchange name (lowercase, e.g. "coinbase")
  INSTRUMENT: string;           // e.g. "BTC-USD"
  MAPPED_INSTRUMENT?: string;
  BASE: string;                 // e.g. "BTC"
  QUOTE: string;                // e.g. "USD"
  OPEN: number;
  HIGH: number;
  LOW: number;
  CLOSE: number;
  VOLUME: number;               // base-asset volume
  QUOTE_VOLUME: number;         // quote-asset volume (USD for *-USD pairs)
  TOTAL_TRADES?: number;
  FIRST_TRADE_TIMESTAMP?: number;
  LAST_TRADE_TIMESTAMP?: number;
};

export type HistoricalOpts = {
  market?: string;              // default "coinbase"
  instrument: string;           // required, e.g. "BTC-USD"
  limit?: number;               // default 168; max 2000 per call
  to_ts?: number;               // walk backwards from this unix-second
  aggregate?: number;           // bucket size in units (1..30); default 1
  fill?: boolean;               // fill empty bars; default true
};

// ----------------------------------------------------------------- methods

export const coindesk = {
  host,

  /** Current snapshot price across multiple quotes. Returns `{ <QUOTE>: <price> }`. */
  price: async (base: string, quotes: string[] = ["USD"]) => {
    // Legacy host still serves this and it's lighter than the v1 spot snapshot.
    const url = `${LEGACY_HOST}/data/price?fsym=${encodeURIComponent(base)}&tsyms=${quotes.join(",")}&api_key=${apiKey()}`;
    return getJson<Record<string, number>>(url);
  },

  /** List active markets (exchanges). */
  listMarkets: () =>
    getJson<{ Data: Record<string, { ID: number; EXCHANGE_INTERNAL_NAME: string; EXCHANGE_STATUS: string; NAME: string; LAUNCH_DATE?: number; HAS_SPOT_TRADING?: boolean; HAS_FUTURES_TRADING?: boolean }> }>(
      buildUrl(host(), "/spot/v1/markets", { instrument_status: "ACTIVE" }),
    ),

  /** List instruments for a market. */
  listInstruments: (market = "coinbase", limit = 200) =>
    getJson<{ Data: Record<string, { INSTRUMENTS?: Record<string, any> }> }>(
      buildUrl(host(), "/spot/v1/markets/instruments", { market, instrument_status: "ACTIVE", limit }),
    ),

  /** Historical 1-min OHLCV. Default 168 bars (~2.8h); max 2000 per call. */
  historicalMinutes: (opts: HistoricalOpts) =>
    getJson<{ Data: CoinDeskCandle[]; Err?: any }>(
      buildUrl(host(), "/spot/v1/historical/minutes", {
        market: opts.market ?? "coinbase",
        instrument: opts.instrument,
        limit: opts.limit ?? 168,
        to_ts: opts.to_ts,
        aggregate: opts.aggregate ?? 1,
        fill: opts.fill !== false,
      }),
    ),

  /** Historical 1-hour OHLCV — useful for longer-window backtests. */
  historicalHours: (opts: HistoricalOpts) =>
    getJson<{ Data: CoinDeskCandle[]; Err?: any }>(
      buildUrl(host(), "/spot/v1/historical/hours", {
        market: opts.market ?? "coinbase",
        instrument: opts.instrument,
        limit: opts.limit ?? 168,
        to_ts: opts.to_ts,
        aggregate: opts.aggregate ?? 1,
        fill: opts.fill !== false,
      }),
    ),

  /** Historical daily OHLCV. */
  historicalDays: (opts: HistoricalOpts) =>
    getJson<{ Data: CoinDeskCandle[]; Err?: any }>(
      buildUrl(host(), "/spot/v1/historical/days", {
        market: opts.market ?? "coinbase",
        instrument: opts.instrument,
        limit: opts.limit ?? 30,
        to_ts: opts.to_ts,
        aggregate: opts.aggregate ?? 1,
        fill: opts.fill !== false,
      }),
    ),
};

export type CoinDesk = typeof coindesk;
