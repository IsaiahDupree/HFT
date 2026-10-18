import {
  ConnectionStatus,
  RealTimeDataClient,
  type ClobApiKeyCreds,
  type Message,
} from "@polymarket/real-time-data-client";

/**
 * Thin typed wrapper over @polymarket/real-time-data-client.
 *
 * The official client surfaces a generic Message + subscription primitives.
 * This wrapper:
 *   - Pulls CLOB credentials from env for the authenticated `clob_user` channel
 *   - Exposes named subscribe methods so callers don't have to remember
 *     topic/type strings ("activity"/"trades", "clob_user"/"*", etc.)
 *   - Lets the consumer pass a typed handler per topic; falls back to a
 *     generic onMessage for anything not handled.
 *
 * The wrapper does NOT auto-reconnect by default — pass `autoReconnect: true`
 * to opt in. This matches the upstream client default.
 */

export type ActivityHandler = (msg: { topic: "activity"; type: "trades" | "orders_matched"; payload: ActivityTrade }) => void;
export type ClobUserHandler = (msg: { topic: "clob_user"; type: "order" | "trade"; payload: ClobUserOrder | ClobUserTrade }) => void;
export type CryptoPriceHandler = (msg: { topic: "crypto_prices"; type: "update"; payload: CryptoPriceUpdate }) => void;
export type ClobMarketHandler = (msg: { topic: "clob_market"; type: string; payload: unknown }) => void;
export type AnyHandler = (msg: Message) => void;
export type StatusHandler = (status: ConnectionStatus) => void;

export type ActivityTrade = {
  asset: string;
  conditionId: string;
  outcome: string;
  outcomeIndex: number;
  price: number;
  side: "BUY" | "SELL";
  size: number;
  slug: string;
  timestamp: number;
  transactionHash: string;
  [k: string]: unknown;
};

export type ClobUserOrder = {
  asset_id: string;
  id: string;
  market: string;
  order_type: "GTC" | "GTD" | "FOK" | "FAK";
  outcome: "YES" | "NO";
  price: string;
  side: "BUY" | "SELL";
  size_matched: string;
  status: string;
  type: "PLACEMENT" | "CANCELLATION" | "FILL" | string;
  [k: string]: unknown;
};

export type ClobUserTrade = {
  asset_id: string;
  id: string;
  market: string;
  outcome: "YES" | "NO";
  price: string;
  side: "BUY" | "SELL";
  size: string;
  status: string;
  transaction_hash: string;
  [k: string]: unknown;
};

export type CryptoPriceUpdate = {
  symbol: string;
  timestamp: number;
  value: number;
};

export type PolymarketRealtimeOptions = {
  host?: string;
  pingInterval?: number;
  autoReconnect?: boolean;
  onActivity?: ActivityHandler;
  onClobUser?: ClobUserHandler;
  onCryptoPrice?: CryptoPriceHandler;
  onClobMarket?: ClobMarketHandler;
  onAny?: AnyHandler;
  onStatusChange?: StatusHandler;
};

export class PolymarketRealtime {
  private client: RealTimeDataClient | null = null;
  private connected = false;

  constructor(private readonly opts: PolymarketRealtimeOptions = {}) {}

  connect(): this {
    if (this.client) return this;
    this.client = new RealTimeDataClient({
      host: this.opts.host,
      pingInterval: this.opts.pingInterval,
      autoReconnect: this.opts.autoReconnect ?? false,
      onConnect: () => {
        this.connected = true;
      },
      onStatusChange: (status) => {
        this.connected = status === ConnectionStatus.CONNECTED;
        this.opts.onStatusChange?.(status);
      },
      onMessage: (_client, message) => {
        this.opts.onAny?.(message);
        switch (message.topic) {
          case "activity":
            this.opts.onActivity?.(message as any);
            break;
          case "clob_user":
            this.opts.onClobUser?.(message as any);
            break;
          case "crypto_prices":
            this.opts.onCryptoPrice?.(message as any);
            break;
          case "clob_market":
            this.opts.onClobMarket?.(message as any);
            break;
        }
      },
    }).connect();
    return this;
  }

  isConnected(): boolean {
    return this.connected;
  }

  disconnect(): void {
    this.client?.disconnect();
    this.client = null;
    this.connected = false;
  }

  // ---------------------------------------------------------------- subscribe

  subscribeActivity(filters?: { eventSlug?: string; marketSlug?: string }): void {
    const filterJson =
      filters?.eventSlug ? JSON.stringify({ event_slug: filters.eventSlug }) :
      filters?.marketSlug ? JSON.stringify({ market_slug: filters.marketSlug }) :
      undefined;
    this.requireClient().subscribe({
      subscriptions: [
        { topic: "activity", type: "trades", filters: filterJson },
        { topic: "activity", type: "orders_matched", filters: filterJson },
      ],
    });
  }

  /** Subscribe to authenticated user channel — needs CLOB API key creds. */
  subscribeUserChannel(creds: ClobApiKeyCreds = readCredsFromEnv()): void {
    this.requireClient().subscribe({
      subscriptions: [{ topic: "clob_user", type: "*", clob_auth: creds }],
    });
  }

  subscribeCryptoPrices(symbols: string[] = ["btcusdt", "ethusdt"]): void {
    this.requireClient().subscribe({
      subscriptions: symbols.map((symbol) => ({
        topic: "crypto_prices",
        type: "update",
        filters: JSON.stringify({ symbol }),
      })),
    });
  }

  subscribeClobMarket(assetIds: string[], types: Array<"agg_orderbook" | "price_change" | "last_trade_price" | "tick_size_change"> = ["agg_orderbook", "price_change", "last_trade_price"]): void {
    const filters = JSON.stringify(assetIds);
    this.requireClient().subscribe({
      subscriptions: types.map((type) => ({ topic: "clob_market", type, filters })),
    });
  }

  // ---------------------------------------------------------------- internals

  private requireClient(): RealTimeDataClient {
    if (!this.client) {
      throw new Error("PolymarketRealtime: call connect() before subscribing");
    }
    return this.client;
  }
}

/**
 * Read CLOB API credentials from env. Throws if any are missing — callers
 * should fall back to public-only channels in that case.
 */
export function readCredsFromEnv(): ClobApiKeyCreds {
  const key = process.env.POLYMARKET_CLOB_API_KEY ?? "";
  const secret = process.env.POLYMARKET_CLOB_SECRET ?? "";
  const passphrase = process.env.POLYMARKET_CLOB_PASSPHRASE ?? "";
  if (!key || !secret || !passphrase) {
    throw new Error(
      "PolymarketRealtime: clob_user channel requires POLYMARKET_CLOB_API_KEY / _SECRET / _PASSPHRASE env vars (run `npm run derive:creds`)",
    );
  }
  return { key, secret, passphrase };
}

export function hasClobCreds(): boolean {
  return Boolean(
    process.env.POLYMARKET_CLOB_API_KEY &&
      process.env.POLYMARKET_CLOB_SECRET &&
      process.env.POLYMARKET_CLOB_PASSPHRASE,
  );
}

export { ConnectionStatus };
