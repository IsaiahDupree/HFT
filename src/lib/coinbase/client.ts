/**
 * Coinbase Advanced Trade typed HTTP client.
 *
 * Base: https://api.coinbase.com/api/v3/brokerage (override via COINBASE_HOST).
 * Auth: short-lived JWT per request (see ./auth.ts).
 *
 * Endpoint inventory mirrored from the official Python SDK + docs.cdp.coinbase.com
 * (see docs/coinbase/ for the source URLs). The harness in
 * `scripts/test-coinbase-endpoints.ts` is the source of truth for which routes
 * / params / responses we trust end-to-end.
 *
 * Surface:
 *   • Accounts, Products (auth), Public market data, Orders, Portfolios,
 *     Convert, Fees, Payment methods, Key permissions, CFM (futures), INTX (perps)
 */
import { authHeader } from "./auth";

const DEFAULT_HOST = "api.coinbase.com";
const BASE_PREFIX = "/api/v3/brokerage";

function host(): string {
  return (process.env.COINBASE_HOST ?? `https://${DEFAULT_HOST}`).replace(/\/$/, "");
}
function hostName(): string {
  // The `uri` JWT claim needs the bare host (no scheme), regardless of how COINBASE_HOST is set.
  return host().replace(/^https?:\/\//, "");
}

type QueryValue = string | number | boolean | string[] | undefined;
type Query = Record<string, QueryValue>;

function buildPath(path: string, query?: Query): string {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
    else qs.set(k, String(v));
  }
  const str = qs.toString();
  return str ? `${path}?${str}` : path;
}

export type RateLimitInfo = {
  limit?: number;
  remaining?: number;
  resetUnix?: number;
};

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
    limit: num("x-ratelimit-limit") ?? num("X-RateLimit-Limit"),
    remaining: num("x-ratelimit-remaining") ?? num("X-RateLimit-Remaining"),
    resetUnix: num("x-ratelimit-reset") ?? num("X-RateLimit-Reset"),
  };
}

/** Per-request timeout. Coinbase API normally answers in <1s; 10s is generous.
 *  Override via COINBASE_FETCH_TIMEOUT_MS. Audit fix F2. */
function fetchTimeoutMs(): number {
  return Number(process.env.COINBASE_FETCH_TIMEOUT_MS ?? "10000");
}

async function request<T>(method: string, path: string, opts: { query?: Query; body?: unknown; auth?: boolean; sandboxScenario?: string } = {}): Promise<T> {
  const fullPath = buildPath(`${BASE_PREFIX}${path}`, opts.query);
  const url = `${host()}${fullPath}`;
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  // Only sign when caller explicitly opts in OR when route is non-public.
  if (opts.auth !== false) {
    headers.Authorization = await authHeader(method, fullPath, hostName());
  }
  if (opts.sandboxScenario) headers["X-Sandbox"] = opts.sandboxScenario;
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
  // Some endpoints (DELETE-like batch_cancel) return JSON; orders/preview returns JSON; all are JSON.
  return r.json() as Promise<T>;
}

// Public helpers: bypass auth.
function publicGet<T>(path: string, query?: Query): Promise<T> {
  return request<T>("GET", path, { query, auth: false });
}
function authedGet<T>(path: string, query?: Query): Promise<T> {
  return request<T>("GET", path, { query, auth: true });
}
function authedPost<T>(path: string, body?: unknown, query?: Query): Promise<T> {
  return request<T>("POST", path, { query, body, auth: true });
}
function authedPut<T>(path: string, body?: unknown, query?: Query): Promise<T> {
  return request<T>("PUT", path, { query, body, auth: true });
}
function authedDelete<T>(path: string, query?: Query): Promise<T> {
  return request<T>("DELETE", path, { query, auth: true });
}

export type CandleGranularity =
  | "UNKNOWN_GRANULARITY" | "ONE_MINUTE" | "FIVE_MINUTE" | "FIFTEEN_MINUTE"
  | "THIRTY_MINUTE" | "ONE_HOUR" | "TWO_HOUR" | "SIX_HOUR" | "ONE_DAY";

export type OrderSide = "BUY" | "SELL";

export const cb = {
  host,
  hostName,
  lastRateLimit: getLastRateLimit,

  // --- Server time (public, no auth) ---
  time: () => publicGet<{ iso: string; epochSeconds: string; epochMillis: string }>("/time"),

  // --- Accounts (auth) ---
  listAccounts: (opts: { limit?: number; cursor?: string; retail_portfolio_id?: string } = {}) =>
    authedGet<{ accounts: any[]; has_next: boolean; cursor: string; size: number }>("/accounts", opts),
  getAccount: (accountUuid: string) =>
    authedGet<{ account: any }>(`/accounts/${encodeURIComponent(accountUuid)}`),

  // --- Products (auth) ---
  listProducts: (opts: { limit?: number; offset?: number; product_type?: "SPOT" | "FUTURE"; product_ids?: string[]; contract_expiry_type?: "EXPIRING" | "PERPETUAL"; expiring_contract_status?: string; get_tradability_status?: boolean; get_all_products?: boolean } = {}) =>
    authedGet<{ products: any[]; num_products: number }>("/products", opts),
  getProduct: (productId: string, opts: { get_tradability_status?: boolean } = {}) =>
    authedGet<any>(`/products/${encodeURIComponent(productId)}`, opts),
  getProductCandles: (productId: string, opts: { start: string; end: string; granularity: CandleGranularity; limit?: number }) =>
    authedGet<{ candles: Array<{ start: string; low: string; high: string; open: string; close: string; volume: string }> }>(
      `/products/${encodeURIComponent(productId)}/candles`,
      opts as Query,
    ),
  getMarketTrades: (productId: string, opts: { limit: number; start?: string; end?: string }) =>
    authedGet<{ trades: any[]; best_bid: string; best_ask: string }>(
      `/products/${encodeURIComponent(productId)}/ticker`,
      opts as Query,
    ),
  getProductBook: (opts: { product_id: string; limit?: number; aggregation_price_increment?: string }) =>
    authedGet<{ pricebook: { product_id: string; bids: Array<{ price: string; size: string }>; asks: Array<{ price: string; size: string }>; time: string } }>("/product_book", opts as Query),
  getBestBidAsk: (opts: { product_ids?: string[] } = {}) =>
    authedGet<{ pricebooks: Array<{ product_id: string; bids: any[]; asks: any[]; time: string }> }>("/best_bid_ask", opts),

  // --- Public market data (no auth — sandbox not supported) ---
  publicListProducts: (opts: { limit?: number; offset?: number; product_type?: string; product_ids?: string[] } = {}) =>
    publicGet<{ products: any[]; num_products: number }>("/market/products", opts),
  publicGetProduct: (productId: string) =>
    publicGet<any>(`/market/products/${encodeURIComponent(productId)}`),
  publicGetProductCandles: (productId: string, opts: { start: string; end: string; granularity: CandleGranularity; limit?: number }) =>
    publicGet<{ candles: any[] }>(`/market/products/${encodeURIComponent(productId)}/candles`, opts as Query),
  publicGetMarketTrades: (productId: string, opts: { limit: number; start?: string; end?: string }) =>
    publicGet<{ trades: any[]; best_bid: string; best_ask: string }>(
      `/market/products/${encodeURIComponent(productId)}/ticker`,
      opts as Query,
    ),
  publicGetProductBook: (opts: { product_id: string; limit?: number; aggregation_price_increment?: string }) =>
    publicGet<{ pricebook: any }>("/market/product_book", opts as Query),

  // --- Orders (auth; mutating endpoints) ---
  /**
   * Create an order. `order_configuration` is one of:
   *   market_market_ioc, limit_limit_gtc, limit_limit_gtd, limit_limit_fok,
   *   stop_limit_stop_limit_gtc, stop_limit_stop_limit_gtd,
   *   trigger_bracket_gtc, trigger_bracket_gtd, sor_limit_ioc
   * Caller must construct the right discriminator shape — kept loose to avoid lock-in.
   */
  createOrder: (body: {
    client_order_id: string;
    product_id: string;
    side: OrderSide;
    order_configuration: Record<string, unknown>;
    self_trade_prevention_id?: string;
    leverage?: string;
    margin_type?: "CROSS" | "ISOLATED";
    retail_portfolio_id?: string;
    preview_id?: string;
  }) => authedPost<{ success: boolean; failure_reason?: string; order_id?: string; success_response?: any; error_response?: any; order_configuration?: any }>("/orders", body),
  previewOrder: (body: Record<string, unknown>) =>
    authedPost<any>("/orders/preview", body),
  batchCancelOrders: (body: { order_ids: string[] }) =>
    authedPost<{ results: Array<{ success: boolean; failure_reason?: string; order_id: string }> }>("/orders/batch_cancel", body),
  editOrder: (body: { order_id: string; price?: string; size?: string }) =>
    authedPost<{ success: boolean; errors?: any[] }>("/orders/edit", body),
  editOrderPreview: (body: { order_id: string; price?: string; size?: string }) =>
    authedPost<any>("/orders/edit_preview", body),
  closePosition: (body: { client_order_id: string; product_id: string; size?: string; retail_portfolio_id?: string }) =>
    authedPost<{ success: boolean; success_response?: any; error_response?: any }>("/orders/close_position", body),
  listOrders: (opts: { product_id?: string; order_status?: string[]; limit?: number; start_date?: string; end_date?: string; user_native_currency?: string; order_type?: string; order_side?: OrderSide; cursor?: string; product_type?: string; order_placement_source?: string; contract_expiry_type?: string; asset_filters?: string[]; retail_portfolio_id?: string; time_in_forces?: string[] } = {}) =>
    authedGet<{ orders: any[]; sequence: string; has_next: boolean; cursor: string }>("/orders/historical/batch", opts),
  getOrder: (orderId: string) =>
    authedGet<{ order: any }>(`/orders/historical/${encodeURIComponent(orderId)}`),
  listFills: (opts: { order_id?: string; product_id?: string; start_sequence_timestamp?: string; end_sequence_timestamp?: string; limit?: number; cursor?: string } = {}) =>
    authedGet<{ fills: any[]; cursor: string }>("/orders/historical/fills", opts),

  // --- Portfolios (auth) ---
  listPortfolios: (opts: { portfolio_type?: "DEFAULT" | "CONSUMER" | "INTX" } = {}) =>
    authedGet<{ portfolios: any[] }>("/portfolios", opts),
  createPortfolio: (body: { name: string }) =>
    authedPost<{ portfolio: any }>("/portfolios", body),
  getPortfolioBreakdown: (portfolioUuid: string, opts: { currency?: string } = {}) =>
    authedGet<{ breakdown: any }>(`/portfolios/${encodeURIComponent(portfolioUuid)}`, opts),
  editPortfolio: (portfolioUuid: string, body: { name: string }) =>
    authedPut<{ portfolio: any }>(`/portfolios/${encodeURIComponent(portfolioUuid)}`, body),
  deletePortfolio: (portfolioUuid: string) =>
    authedDelete<Record<string, never>>(`/portfolios/${encodeURIComponent(portfolioUuid)}`),
  movePortfolioFunds: (body: { source_portfolio_uuid: string; target_portfolio_uuid: string; funds: { value: string; currency: string } }) =>
    authedPost<{ source_portfolio_uuid: string; target_portfolio_uuid: string }>("/portfolios/move_funds", body),

  // --- Convert (auth) ---
  createConvertQuote: (body: { from_account: string; to_account: string; amount: string; trade_incentive_metadata?: any; user_incentive_id?: string; code_val?: string }) =>
    authedPost<{ trade: any }>("/convert/quote", body),
  getConvertTrade: (tradeId: string, opts: { from_account: string; to_account: string }) =>
    authedGet<{ trade: any }>(`/convert/trade/${encodeURIComponent(tradeId)}`, opts),
  commitConvertTrade: (tradeId: string, body: { from_account: string; to_account: string }) =>
    authedPost<{ trade: any }>(`/convert/trade/${encodeURIComponent(tradeId)}`, body),

  // --- Fees / transaction summary (auth) ---
  getTransactionSummary: (opts: { start_date?: string; end_date?: string; user_native_currency?: string; product_type?: string; contract_expiry_type?: string; product_venue?: string } = {}) =>
    authedGet<{ total_volume: number; total_fees: number; fee_tier: any; margin_rate?: any; goods_and_services_tax?: any; advanced_trade_only_volume: number; advanced_trade_only_fees: number; coinbase_pro_volume: number; coinbase_pro_fees: number; total_balance?: any }>("/transaction_summary", opts),

  // --- Payment methods (auth) ---
  listPaymentMethods: () =>
    authedGet<{ payment_methods: any[] }>("/payment_methods"),
  getPaymentMethod: (paymentMethodId: string) =>
    authedGet<{ payment_method: any }>(`/payment_methods/${encodeURIComponent(paymentMethodId)}`),

  // --- Key permissions (Data API, auth) ---
  getKeyPermissions: () =>
    authedGet<{ can_view: boolean; can_trade: boolean; can_transfer: boolean; portfolio_uuid: string; portfolio_type: string }>("/key_permissions"),

  // --- Futures (CFM, auth, US-only entitlement required) ---
  cfmBalanceSummary: () =>
    authedGet<{ balance_summary: any }>("/cfm/balance_summary"),
  cfmListPositions: () =>
    authedGet<{ positions: any[] }>("/cfm/positions"),
  cfmGetPosition: (productId: string) =>
    authedGet<{ position: any }>(`/cfm/positions/${encodeURIComponent(productId)}`),
  cfmScheduleSweep: (body: { usd_amount: string }) =>
    authedPost<{ success: boolean }>("/cfm/sweeps/schedule", body),
  cfmListSweeps: () =>
    authedGet<{ sweeps: any[] }>("/cfm/sweeps"),
  cfmCancelSweeps: () =>
    authedDelete<{ success: boolean }>("/cfm/sweeps"),
  cfmGetIntradayMarginSetting: () =>
    authedGet<{ setting: string }>("/cfm/intraday/margin_setting"),
  cfmSetIntradayMarginSetting: (body: { setting: string }) =>
    authedPost<{ success: boolean }>("/cfm/intraday/margin_setting", body),
  cfmGetCurrentMarginWindow: (opts: { margin_profile_type?: string } = {}) =>
    authedGet<{ margin_window: any; is_intraday_margin_killswitch_enabled: boolean; is_intraday_margin_enrollment_killswitch_enabled: boolean }>("/cfm/intraday/current_margin_window", opts),

  // --- Perpetuals (INTX, auth, non-US/eligible) ---
  intxAllocate: (body: { portfolio_uuid: string; symbol: string; amount: string; currency: string }) =>
    authedPost<Record<string, never>>("/intx/allocate", body),
  intxGetPortfolioSummary: (portfolioUuid: string) =>
    authedGet<{ portfolio_balances: any }>(`/intx/portfolio/${encodeURIComponent(portfolioUuid)}`),
  intxListPositions: (portfolioUuid: string) =>
    authedGet<{ positions: any[] }>(`/intx/positions/${encodeURIComponent(portfolioUuid)}`),
  intxGetPosition: (portfolioUuid: string, symbol: string) =>
    authedGet<{ position: any }>(`/intx/positions/${encodeURIComponent(portfolioUuid)}/${encodeURIComponent(symbol)}`),
  intxGetBalances: (portfolioUuid: string) =>
    authedGet<{ portfolio_balances: any }>(`/intx/balances/${encodeURIComponent(portfolioUuid)}`),
  intxMultiAssetCollateral: (body: { portfolio_uuid: string; multi_asset_collateral_enabled: boolean }) =>
    authedPost<{ multi_asset_collateral_enabled: boolean }>("/intx/multi_asset_collateral", body),
};

export type Cb = typeof cb;
