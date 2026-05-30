/**
 * Thin HTTP client around the four Polymarket services. Used by Next.js API routes
 * and background workers. The harness in `scripts/test-endpoints.ts` is the
 * source of truth for which routes / params / responses we trust.
 */
import { hmacSign } from "./sign";

type Env = {
  GAMMA: string;
  DATA: string;
  CLOB: string;
  RELAYER: string;
  RELAYER_API_KEY: string;
  RELAYER_API_KEY_ADDRESS: string;
  CLOB_API_KEY?: string;
  CLOB_SECRET?: string;
  CLOB_PASSPHRASE?: string;
  SIGNATURE_TYPE: number;
};

function readEnv(): Env {
  return {
    GAMMA: process.env.POLYMARKET_GAMMA_HOST ?? "https://gamma-api.polymarket.com",
    DATA: process.env.POLYMARKET_DATA_HOST ?? "https://data-api.polymarket.com",
    CLOB: process.env.POLYMARKET_CLOB_HOST ?? "https://clob.polymarket.com",
    RELAYER: process.env.POLYMARKET_RELAYER_HOST ?? "https://relayer-v2.polymarket.com",
    RELAYER_API_KEY: process.env.POLYMARKET_RELAYER_API_KEY ?? "",
    RELAYER_API_KEY_ADDRESS: process.env.POLYMARKET_RELAYER_API_KEY_ADDRESS ?? "",
    CLOB_API_KEY: process.env.POLYMARKET_CLOB_API_KEY,
    CLOB_SECRET: process.env.POLYMARKET_CLOB_SECRET,
    CLOB_PASSPHRASE: process.env.POLYMARKET_CLOB_PASSPHRASE,
    SIGNATURE_TYPE: Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? "1"),
  };
}

/** Per-request timeout. Polymarket Gamma + CLOB normally answer in <1s; 10s
 *  is generous. Override via POLYMARKET_FETCH_TIMEOUT_MS. Audit fix F2. */
function fetchTimeoutMs(): number {
  return Number(process.env.POLYMARKET_FETCH_TIMEOUT_MS ?? "10000");
}

async function get<T>(url: string, headers: HeadersInit = {}): Promise<T> {
  const r = await fetch(url, {
    method: "GET", headers, cache: "no-store",
    signal: AbortSignal.timeout(fetchTimeoutMs()),
  });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status} ${await r.text().then((t) => t.slice(0, 200))}`);
  return r.json() as Promise<T>;
}

export const poly = {
  env: readEnv,
  // --- Gamma (public) ---
  events: (opts: {
    limit?: number;
    closed?: boolean;
    tag_slug?: string;
    /** ISO timestamp — Gamma returns events with endDate >= this. */
    end_date_min?: string;
    /** ISO timestamp — Gamma returns events with endDate <= this. */
    end_date_max?: string;
    /** Field to order by, e.g. 'endDate' or 'startDate'. */
    order?: string;
    ascending?: boolean;
  } = {}) => {
    const e = readEnv();
    const qs = new URLSearchParams();
    qs.set("limit", String(opts.limit ?? 10));
    if (opts.closed !== undefined) qs.set("closed", String(opts.closed));
    if (opts.tag_slug) qs.set("tag_slug", opts.tag_slug);
    if (opts.end_date_min) qs.set("end_date_min", opts.end_date_min);
    if (opts.end_date_max) qs.set("end_date_max", opts.end_date_max);
    if (opts.order) qs.set("order", opts.order);
    if (opts.ascending !== undefined) qs.set("ascending", String(opts.ascending));
    return get<any[]>(`${e.GAMMA}/events?${qs}`);
  },
  event: (id: number | string) => get<any>(`${readEnv().GAMMA}/events/${id}`),
  marketsByCondition: (conditionIds: string[], opts: { closed?: boolean; archived?: boolean } = {}) => {
    const qs = new URLSearchParams({ condition_ids: conditionIds.join(",") });
    if (opts.closed !== undefined) qs.set("closed", String(opts.closed));
    if (opts.archived !== undefined) qs.set("archived", String(opts.archived));
    return get<any[]>(`${readEnv().GAMMA}/markets?${qs}`);
  },
  tags: (limit = 20) => get<any[]>(`${readEnv().GAMMA}/tags?limit=${limit}`),
  search: (q: string, limitPerType = 5) =>
    get<any>(`${readEnv().GAMMA}/public-search?q=${encodeURIComponent(q)}&limit_per_type=${limitPerType}`),
  publicProfile: (address: string) =>
    get<any>(`${readEnv().GAMMA}/public-profile?address=${address.toLowerCase()}`),
  // --- Data (public) ---
  userPositions: (user: string, opts: { limit?: number } = {}) =>
    get<any[]>(`${readEnv().DATA}/positions?user=${user}&limit=${opts.limit ?? 50}`),
  userTrades: (user: string, opts: { limit?: number } = {}) =>
    get<any[]>(`${readEnv().DATA}/trades?user=${user}&limit=${opts.limit ?? 50}`),
  userActivity: (user: string, opts: { limit?: number } = {}) =>
    get<any[]>(`${readEnv().DATA}/activity?user=${user}&limit=${opts.limit ?? 50}`),
  userValue: async (user: string): Promise<{ user: string; value: number } | null> => {
    // The /value endpoint returns an array [{ user, value }] — unwrap to a
    // single object (or null if the wallet has no recorded value). Most
    // callers just want the number; surfacing the raw array repeatedly led
    // to silent `value?.value` reads returning undefined.
    const raw = await get<any>(`${readEnv().DATA}/value?user=${user}`);
    if (Array.isArray(raw)) return raw[0] ?? null;
    if (raw && typeof raw === "object" && "value" in raw) return raw as { user: string; value: number };
    return null;
  },
  openInterest: () => get<any>(`${readEnv().DATA}/oi`),
  topHolders: (conditionId: string, limit = 10) =>
    get<any[]>(`${readEnv().DATA}/holders?market=${conditionId}&limit=${limit}`),
  marketPositions: (conditionId: string, status: "OPEN" | "CLOSED" | "ALL" = "ALL") =>
    get<any[]>(`${readEnv().DATA}/v1/market-positions?market=${conditionId}&status=${status}`),
  liveEventVolume: (eventId: number | string) =>
    get<any[]>(`${readEnv().DATA}/live-volume?id=${eventId}`),
  traderLeaderboard: (opts: { category?: string; timePeriod?: "DAY" | "WEEK" | "MONTH" | "ALL"; orderBy?: "PNL" | "VOL"; limit?: number } = {}) => {
    const e = readEnv();
    const qs = new URLSearchParams({
      category: opts.category ?? "OVERALL",
      timePeriod: opts.timePeriod ?? "DAY",
      orderBy: opts.orderBy ?? "PNL",
      limit: String(opts.limit ?? 25),
    });
    return get<any[]>(`${e.DATA}/v1/leaderboard?${qs}`);
  },
  // --- CLOB (public) ---
  clobMarkets: (opts: { limit?: number; next_cursor?: string } = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.next_cursor) qs.set("next_cursor", opts.next_cursor);
    return get<{ data: any[]; next_cursor?: string; limit: number; count: number }>(`${readEnv().CLOB}/markets?${qs}`);
  },
  samplingMarkets: async (limit = 10) => {
    // CLOB returns the full reward-eligible page (~1000) and ignores the `limit` query param;
    // we slice client-side so callers get the size they expect.
    const e = readEnv();
    const full = await get<{ data: any[]; next_cursor?: string; limit: number; count: number }>(`${e.CLOB}/sampling-markets`);
    return { ...full, data: full.data.slice(0, limit), limit };
  },
  orderbook: (tokenId: string) => get<any>(`${readEnv().CLOB}/book?token_id=${tokenId}`),
  price: (tokenId: string, side: "BUY" | "SELL") =>
    get<{ price: string }>(`${readEnv().CLOB}/price?token_id=${tokenId}&side=${side}`),
  midpoint: (tokenId: string) => get<{ mid: string }>(`${readEnv().CLOB}/midpoint?token_id=${tokenId}`),
  spread: (tokenId: string) => get<{ spread: string }>(`${readEnv().CLOB}/spread?token_id=${tokenId}`),
  lastTradePrice: (tokenId: string) => get<any>(`${readEnv().CLOB}/last-trade-price?token_id=${tokenId}`),
  pricesHistory: (tokenId: string, interval: "max" | "1w" | "1d" | "6h" | "1h" = "1d", fidelity = 60) =>
    get<{ history: Array<{ t: number; p: number }> }>(`${readEnv().CLOB}/prices-history?market=${tokenId}&interval=${interval}&fidelity=${fidelity}`),
  // --- CLOB (auth) ---
  clobAuthGet: <T = unknown>(path: string): Promise<T> => {
    const e = readEnv();
    if (!e.CLOB_API_KEY || !e.CLOB_SECRET || !e.CLOB_PASSPHRASE) {
      throw new Error("CLOB L2 credentials missing — run `npm run derive:creds`");
    }
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = hmacSign(e.CLOB_SECRET, ts, "GET", path);
    return get<T>(`${e.CLOB}${path}`, {
      POLY_ADDRESS: e.RELAYER_API_KEY_ADDRESS,
      POLY_API_KEY: e.CLOB_API_KEY,
      POLY_PASSPHRASE: e.CLOB_PASSPHRASE,
      POLY_TIMESTAMP: ts,
      POLY_SIGNATURE: sig,
    });
  },
  myOpenOrders: () => poly.clobAuthGet<any[]>("/data/orders"),
  myTrades: () => poly.clobAuthGet<any[]>("/data/trades"),
  // --- Relayer ---
  relayerPayload: (type: "PROXY" | "SAFE" = "PROXY") => {
    const e = readEnv();
    return get<{ address: string; nonce: string }>(
      `${e.RELAYER}/relay-payload?address=${e.RELAYER_API_KEY_ADDRESS}&type=${type}`,
      { RELAYER_API_KEY: e.RELAYER_API_KEY, RELAYER_API_KEY_ADDRESS: e.RELAYER_API_KEY_ADDRESS },
    );
  },
  relayerTxs: () => {
    const e = readEnv();
    return get<any[]>(`${e.RELAYER}/transactions?address=${e.RELAYER_API_KEY_ADDRESS}`, {
      RELAYER_API_KEY: e.RELAYER_API_KEY,
      RELAYER_API_KEY_ADDRESS: e.RELAYER_API_KEY_ADDRESS,
    });
  },
};
