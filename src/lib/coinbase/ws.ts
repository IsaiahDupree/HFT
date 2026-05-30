/**
 * Coinbase Advanced Trade WebSocket client.
 *
 * Two URLs:
 *   • Market data (public + public channels): wss://advanced-trade-ws.coinbase.com
 *   • User data (authenticated `user` + `futures_balance_summary`): wss://advanced-trade-ws-user.coinbase.com
 *
 * Channels:
 *   public  — ticker, ticker_batch, level2, market_trades, candles, heartbeats, status
 *   auth    — user, futures_balance_summary  (JWT inside the subscribe message)
 *
 * Quirks (confirmed against the docs + SDK):
 *   • JWT lifetime is 120s; you must send a fresh JWT in *every new* subscribe.
 *     Channels you already subscribed to keep streaming after the JWT expires.
 *   • Must send a subscribe within 5s of opening the socket or you get dropped.
 *   • Unauth message ceiling: 8 msg/s/IP.
 *
 * Returns an `unsubscribe()` that closes the socket cleanly.
 */
import { buildJwt } from "./auth";

export type CbPublicChannel =
  | "ticker"
  | "ticker_batch"
  | "level2"
  | "market_trades"
  | "candles"
  | "heartbeats"
  | "status";
export type CbAuthChannel = "user" | "futures_balance_summary";

export type CbWsMessage = {
  channel?: string;
  client_id?: string;
  timestamp?: string;
  sequence_num?: number;
  events?: any[];
  type?: string;
  message?: string;
} & Record<string, unknown>;

export type CbSubscribeOpts = {
  channel: CbPublicChannel | CbAuthChannel;
  productIds?: string[];
  /** Force a specific URL; otherwise inferred from channel. */
  url?: string;
  onMessage: (msg: CbWsMessage) => void;
  onStatus?: (status: "connecting" | "open" | "closed" | "error") => void;
  /** Use a WebSocket implementation (Node 'ws' or DOM). Defaults to the global. */
  WebSocketImpl?: typeof WebSocket;
};

const URL_PUBLIC = "wss://advanced-trade-ws.coinbase.com";
const URL_USER = "wss://advanced-trade-ws-user.coinbase.com";
const AUTH_CHANNELS = new Set<CbAuthChannel>(["user", "futures_balance_summary"]);

function pickUrl(channel: string, override?: string): string {
  if (override) return override;
  return AUTH_CHANNELS.has(channel as CbAuthChannel) ? URL_USER : URL_PUBLIC;
}

/**
 * Subscribe to a single channel. For multiple channels, call multiple times
 * with separate sockets — that's the SDK pattern and isolates reconnect logic.
 */
export function subscribeCoinbase(opts: CbSubscribeOpts): () => void {
  const url = pickUrl(opts.channel, opts.url);
  const isAuth = AUTH_CHANNELS.has(opts.channel as CbAuthChannel);
  const WS = opts.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WS) throw new Error("No WebSocket implementation available. Pass `WebSocketImpl` (e.g., `ws.WebSocket` from the 'ws' package).");

  let socket: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const sendSubscribe = async (): Promise<void> => {
    if (!socket || socket.readyState !== 1 /* OPEN */) return;
    const msg: Record<string, unknown> = {
      type: "subscribe",
      channel: opts.channel,
    };
    if (opts.productIds && opts.productIds.length > 0) msg.product_ids = opts.productIds;
    if (isAuth) {
      msg.jwt = await buildJwt(); // no `uri` claim for WS
    }
    socket.send(JSON.stringify(msg));
  };

  const connect = () => {
    if (stopped) return;
    opts.onStatus?.("connecting");
    socket = new WS(url);

    socket.addEventListener("open", () => {
      attempt = 0;
      opts.onStatus?.("open");
      // Must subscribe within 5s of open or get disconnected.
      void sendSubscribe();
    });

    socket.addEventListener("message", (e: MessageEvent) => {
      try {
        const parsed = JSON.parse(typeof e.data === "string" ? e.data : (e.data as Buffer).toString("utf8"));
        opts.onMessage(parsed as CbWsMessage);
      } catch {
        // ignore non-JSON
      }
    });

    socket.addEventListener("close", () => {
      opts.onStatus?.("closed");
      if (stopped) return;
      attempt += 1;
      const delay = Math.min(15_000, 500 * 2 ** Math.min(5, attempt));
      reconnectTimer = setTimeout(connect, delay);
    });

    socket.addEventListener("error", () => {
      opts.onStatus?.("error");
      try { socket?.close(); } catch {}
    });
  };

  connect();

  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try {
      if (socket?.readyState === 1) {
        const unsubMsg: Record<string, unknown> = { type: "unsubscribe", channel: opts.channel };
        if (opts.productIds && opts.productIds.length > 0) unsubMsg.product_ids = opts.productIds;
        // Best-effort, no JWT needed on unsubscribe per docs.
        socket.send(JSON.stringify(unsubMsg));
      }
    } catch {}
    try { socket?.close(); } catch {}
  };
}
