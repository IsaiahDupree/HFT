/**
 * Kalshi trade-api/v2 typed HTTP client.
 *
 * Hosts (override via KALSHI_HOST — useful to point at demo):
 *   prod : https://api.elections.kalshi.com   (alias of external-api.kalshi.com)
 *   demo : https://demo-api.kalshi.co         (alias of external-api.demo.kalshi.co)
 *
 * Auth: RSA-PSS request signing per ./sign.ts.
 *
 * Endpoint surface mirrors docs.kalshi.com/llms.txt. The harness in
 * `scripts/test-kalshi-endpoints.ts` is the source of truth for which routes
 * we trust end-to-end.
 */
import { authHeaders } from "./sign";

// Default is production. Prod and demo use SEPARATE keys — point your demo
// runs at KALSHI_HOST=https://demo-api.kalshi.co with a demo-issued key file.
const DEFAULT_HOST = "https://api.elections.kalshi.com";
const BASE_PREFIX = "/trade-api/v2";

function host(): string {
  return (process.env.KALSHI_HOST ?? DEFAULT_HOST).replace(/\/$/, "");
}

type QueryValue = string | number | boolean | string[] | undefined;
type Query = Record<string, QueryValue>;

function buildQs(query?: Query): string {
  if (!query) return "";
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
    else qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

function fetchTimeoutMs(): number {
  return Number(process.env.KALSHI_FETCH_TIMEOUT_MS ?? "10000");
}

export type RateLimitInfo = { limit?: number; remaining?: number; resetUnix?: number };
let _lastRateLimit: RateLimitInfo = {};
export function getLastRateLimit(): RateLimitInfo {
  return { ..._lastRateLimit };
}
function captureRateLimit(headers: Headers) {
  const num = (h: string) => {
    const v = headers.get(h);
    return v == null ? undefined : Number(v);
  };
  _lastRateLimit = {
    limit: num("x-ratelimit-limit"),
    remaining: num("x-ratelimit-remaining"),
    resetUnix: num("x-ratelimit-reset"),
  };
}

async function request<T>(
  method: string,
  path: string,
  opts: { query?: Query; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const qs = buildQs(opts.query);
  const fullPath = `${BASE_PREFIX}${path}`;          // e.g. /trade-api/v2/markets
  const url = `${host()}${fullPath}${qs}`;
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  // Sign the path WITHOUT the querystring — Kalshi explicitly excludes it from the signed message.
  if (opts.auth !== false) {
    Object.assign(headers, authHeaders(method, fullPath));
  }
  const r = await fetch(url, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    cache: "no-store",
    signal: AbortSignal.timeout(fetchTimeoutMs()),
  });
  captureRateLimit(r.headers);
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`${method} ${fullPath} → ${r.status} ${text.slice(0, 240)}`);
  }
  // DELETE on Kalshi typically returns 200/204 with an empty body; tolerate both.
  if (r.status === 204) return undefined as unknown as T;
  const ct = r.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return (await r.text()) as unknown as T;
  return (await r.json()) as T;
}

const publicGet = <T>(path: string, query?: Query) =>
  request<T>("GET", path, { query, auth: false });
const authedGet = <T>(path: string, query?: Query) =>
  request<T>("GET", path, { query, auth: true });
const authedPost = <T>(path: string, body?: unknown, query?: Query) =>
  request<T>("POST", path, { body, query, auth: true });
const authedDelete = <T>(path: string, query?: Query) =>
  request<T>("DELETE", path, { query, auth: true });
const authedPatch = <T>(path: string, body?: unknown, query?: Query) =>
  request<T>("PATCH", path, { body, query, auth: true });

// ---------- Public types (kept loose — surface is wide) ----------
export type KalshiSide = "yes" | "no";
export type KalshiAction = "buy" | "sell";
export type KalshiOrderType = "limit" | "market";

export type KalshiMarket = {
  ticker: string;
  event_ticker?: string;
  series_ticker?: string;
  market_type?: string;
  title?: string;
  subtitle?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  open_time?: string;
  close_time?: string;
  status?: "unopened" | "open" | "closed" | "settled";
  yes_bid?: number; yes_ask?: number; no_bid?: number; no_ask?: number;
  last_price?: number;
  volume?: number; open_interest?: number;
  result?: string;
  expiration_time?: string;
  liquidity?: number;
  [k: string]: unknown;
};

/**
 * Kalshi returns the orderbook wrapped in `orderbook_fp` ("floating price"),
 * with `yes_dollars` / `no_dollars` arrays of `[price_string, size_string]`
 * — strings, in dollars, not the legacy `[price_cents, count]` shape.
 * (Verified live against prod 2026-05-26 on KXBTC15M.)
 */
export type KalshiOrderbookFp = {
  yes_dollars: Array<[string, string]>;
  no_dollars: Array<[string, string]>;
};
export type KalshiOrderbookResponse = { orderbook_fp: KalshiOrderbookFp };

export type KalshiOrderRequest = {
  ticker: string;
  action: KalshiAction;
  side: KalshiSide;
  type: KalshiOrderType;
  count: number;
  /** Required for `type: "limit"`. Integer 1–99 (cents). */
  yes_price?: number;
  /** Alternative pricing for NO-side limits. Integer 1–99 (cents). */
  no_price?: number;
  /** Required: client-side unique idempotency key. */
  client_order_id: string;
  /** Optional self-trade-prevention behaviour. */
  buy_max_cost?: number;
  sell_position_floor?: number;
  expiration_ts?: number;
  post_only?: boolean;
};

export const kalshi = {
  host,
  basePrefix: () => BASE_PREFIX,
  lastRateLimit: getLastRateLimit,

  // ---------- Exchange ----------
  exchangeStatus: () => publicGet<{ exchange_active: boolean; trading_active: boolean }>("/exchange/status"),
  exchangeSchedule: () => publicGet<any>("/exchange/schedule"),
  exchangeAnnouncements: () => publicGet<any>("/exchange/announcements"),

  // ---------- Series / Events ----------
  listSeries: (opts: { category?: string; tags?: string; include_product_metadata?: boolean } = {}) =>
    publicGet<{ series: any[] }>("/series", opts as Query),
  getSeries: (ticker: string) =>
    publicGet<{ series: any }>(`/series/${encodeURIComponent(ticker)}`),

  listEvents: (opts: {
    limit?: number;
    cursor?: string;
    status?: "unopened" | "open" | "closed" | "settled";
    series_ticker?: string;
    with_nested_markets?: boolean;
  } = {}) => publicGet<{ events: any[]; cursor?: string }>("/events", opts as Query),
  getEvent: (ticker: string, opts: { with_nested_markets?: boolean } = {}) =>
    publicGet<{ event: any; markets?: KalshiMarket[] }>(`/events/${encodeURIComponent(ticker)}`, opts as Query),
  getEventCandlesticks: (ticker: string, opts: { start_ts: number; end_ts: number; period_interval: number }) =>
    publicGet<{ candlesticks: any[] }>(`/events/${encodeURIComponent(ticker)}/candlesticks`, opts as Query),

  // ---------- Markets ----------
  listMarkets: (opts: {
    limit?: number;
    cursor?: string;
    event_ticker?: string;
    series_ticker?: string;
    max_close_ts?: number;
    min_close_ts?: number;
    status?: "unopened" | "open" | "closed" | "settled";
    tickers?: string;            // comma-separated
  } = {}) => publicGet<{ markets: KalshiMarket[]; cursor?: string }>("/markets", opts as Query),
  getMarket: (ticker: string) =>
    publicGet<{ market: KalshiMarket }>(`/markets/${encodeURIComponent(ticker)}`),
  getMarketOrderbook: (ticker: string, opts: { depth?: number } = {}) =>
    publicGet<KalshiOrderbookResponse>(`/markets/${encodeURIComponent(ticker)}/orderbook`, opts as Query),
  getMarketCandlesticks: (ticker: string, opts: { start_ts: number; end_ts: number; period_interval: number }) =>
    publicGet<{ candlesticks: any[] }>(`/markets/${encodeURIComponent(ticker)}/candlesticks`, opts as Query),
  /**
   * Per-market trades. The Kalshi REST path is `/markets/trades?ticker=...`
   * (not `/markets/{ticker}/trades`, which 404s — verified 2026-05-26).
   */
  getMarketTrades: (ticker: string, opts: { limit?: number; cursor?: string; min_ts?: number; max_ts?: number } = {}) =>
    publicGet<{ trades: any[]; cursor?: string }>("/markets/trades", { ticker, ...opts } as Query),
  listTrades: (opts: { limit?: number; cursor?: string; ticker?: string; min_ts?: number; max_ts?: number } = {}) =>
    publicGet<{ trades: any[]; cursor?: string }>("/markets/trades", opts as Query),

  // ---------- Portfolio (authenticated) ----------
  /** `balance` is in cents (integer); `balance_dollars` is the same value as a dollar-string. */
  getBalance: () => authedGet<{
    balance: number;
    balance_dollars?: string;
    balance_breakdown?: Array<{ balance: string; exchange_index: number }>;
    portfolio_value?: number;
    updated_ts?: number;
  }>("/portfolio/balance"),
  getPositions: (opts: { limit?: number; cursor?: string; settlement_status?: "all" | "settled" | "unsettled"; ticker?: string; event_ticker?: string } = {}) =>
    authedGet<{ market_positions: any[]; event_positions?: any[]; cursor?: string }>("/portfolio/positions", opts as Query),
  getFills: (opts: { ticker?: string; order_id?: string; limit?: number; cursor?: string; min_ts?: number; max_ts?: number } = {}) =>
    authedGet<{ fills: any[]; cursor?: string }>("/portfolio/fills", opts as Query),
  getSettlements: (opts: { limit?: number; cursor?: string; min_ts?: number; max_ts?: number } = {}) =>
    authedGet<{ settlements: any[]; cursor?: string }>("/portfolio/settlements", opts as Query),

  // ---------- Orders (authenticated) ----------
  listOrders: (opts: {
    ticker?: string;
    event_ticker?: string;
    status?: "resting" | "canceled" | "executed";
    limit?: number;
    cursor?: string;
    min_ts?: number;
    max_ts?: number;
  } = {}) => authedGet<{ orders: any[]; cursor?: string }>("/portfolio/orders", opts as Query),
  getOrder: (orderId: string) =>
    authedGet<{ order: any }>(`/portfolio/orders/${encodeURIComponent(orderId)}`),
  createOrder: (body: KalshiOrderRequest) =>
    authedPost<{ order: any }>("/portfolio/orders", body),
  cancelOrder: (orderId: string) =>
    authedDelete<{ order: any; reduced_by?: number }>(`/portfolio/orders/${encodeURIComponent(orderId)}`),
  amendOrder: (orderId: string, body: { price?: number; count?: number; client_order_id: string }) =>
    authedPatch<{ order: any }>(`/portfolio/orders/${encodeURIComponent(orderId)}/amend`, body),
  batchCreateOrders: (body: { orders: KalshiOrderRequest[] }) =>
    authedPost<{ orders: any[] }>("/portfolio/orders/batched", body),
  batchCancelOrders: (body: { ids: string[] }) =>
    authedDelete<{ orders: any[] }>("/portfolio/orders/batched"),

  // ---------- API keys management (rarely used at runtime) ----------
  listApiKeys: () => authedGet<{ api_keys: any[] }>("/api_keys"),
};

export type KalshiClient = typeof kalshi;
