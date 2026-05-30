/**
 * Polymarket CLOB market-channel websocket client. Browser-side (uses native WebSocket).
 *
 * - Connects to wss://ws-subscriptions-clob.polymarket.com/ws/market
 * - Subscribes to a list of token (asset) ids on open
 * - Heartbeats every 10s (server closes on missed heartbeat)
 * - Auto-reconnects with exponential backoff
 * - Calls back per message — book / price_change / tick_size_change / last_trade_price
 *
 * Caller convention: returns an unsubscribe() function. Designed to be called
 * inside a React `useEffect` so unmount tears down the socket cleanly.
 */
export type MarketWsMessage = {
  event_type?: "book" | "price_change" | "tick_size_change" | "last_trade_price" | "best_bid_ask" | "market_resolved" | "new_market" | string;
  asset_id?: string;
  market?: string;
  hash?: string;
  timestamp?: string | number;
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
  // Variant payloads
  changes?: Array<{ price: string; side: "BUY" | "SELL"; size: string }>;
  best_bid?: string;
  best_ask?: string;
  price?: string;
  side?: "BUY" | "SELL";
  size?: string;
} & Record<string, unknown>;

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export type SubscribeOpts = {
  assetIds: string[];
  customFeatures?: boolean;
  onMessage: (msg: MarketWsMessage) => void;
  onStatus?: (status: "connecting" | "open" | "closed" | "error") => void;
};

export function subscribeMarket(opts: SubscribeOpts): () => void {
  let socket: WebSocket | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    opts.onStatus?.("connecting");
    socket = new WebSocket(WS_URL);

    socket.addEventListener("open", () => {
      attempt = 0;
      opts.onStatus?.("open");
      socket?.send(JSON.stringify({
        type: "MARKET",
        assets_ids: opts.assetIds,
        custom_feature_enabled: opts.customFeatures ?? true,
      }));
      heartbeat = setInterval(() => {
        try { socket?.send("PING"); } catch {}
      }, 10_000);
    });

    socket.addEventListener("message", (e) => {
      const raw = e.data as string;
      if (raw === "PONG") return;
      try {
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const m of list) opts.onMessage(m as MarketWsMessage);
      } catch {
        // ignore non-JSON heartbeats
      }
    });

    const handleClose = () => {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      opts.onStatus?.("closed");
      if (stopped) return;
      attempt += 1;
      const delay = Math.min(15_000, 500 * 2 ** Math.min(5, attempt));
      reconnectTimer = setTimeout(connect, delay);
    };
    socket.addEventListener("close", handleClose);
    socket.addEventListener("error", () => {
      opts.onStatus?.("error");
      socket?.close();
    });
  };

  connect();

  return () => {
    stopped = true;
    if (heartbeat) clearInterval(heartbeat);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try { socket?.close(); } catch {}
  };
}
