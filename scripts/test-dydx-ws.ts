/**
 * dYdX Indexer WebSocket probe. Subscribes to the public channels we'd consume
 * for live trading (markets, trades, orderbook, candles), tallies messages over
 * a fixed window, then unsubscribes and exits.
 *
 *   npm run test:dydx:ws                         # testnet, BTC-USD, 10s
 *   npm run test:dydx:ws -- --mainnet
 *   npm run test:dydx:ws -- --market ETH-USD --duration 20
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeSocketClient, resolveNet, IncomingMessageTypes, CandlesResolution } from "../src/lib/hft/dydx";

type Counts = Record<string, number>;

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const net = resolveNet();
const market = argValue("market", "BTC-USD");
const durationSec = Number(argValue("duration", "10"));

const counts: Counts = {
  connected: 0, subscribed: 0, error: 0, pong: 0,
  v4_markets: 0, v4_trades: 0, v4_orderbook: 0, v4_candles: 0,
  other: 0,
};
const firstSamples: Record<string, unknown> = {};

const startedAt = Date.now();

const socket = makeSocketClient(net, {
  onOpen: () => {
    console.log(`[open] ${net} indexer ws connected`);
    socket.subscribeToMarkets();
    socket.subscribeToTrades(market);
    socket.subscribeToOrderbook(market);
    socket.subscribeToCandles(market, CandlesResolution.ONE_MINUTE);
  },
  onClose: () => console.log("[close] socket closed"),
  onError: (ev) => {
    counts.error++;
    console.error("[error]", (ev as { message?: string }).message ?? ev);
  },
  onMessage: (event) => {
    let msg: any;
    try { msg = JSON.parse(event.data as string); } catch { counts.other++; return; }
    const type = msg.type as string | undefined;
    const channel = msg.channel as string | undefined;
    if (type === IncomingMessageTypes.CONNECTED) counts.connected++;
    else if (type === IncomingMessageTypes.SUBSCRIBED) {
      counts.subscribed++;
      console.log(`[subscribed] ${channel}${msg.id ? `/${msg.id}` : ""}`);
    } else if (type === IncomingMessageTypes.PONG) counts.pong++;
    else if (type === IncomingMessageTypes.ERROR) {
      counts.error++;
      console.error("[ws-error]", msg.message ?? JSON.stringify(msg));
    } else if (channel && Object.prototype.hasOwnProperty.call(counts, channel)) {
      counts[channel]++;
      if (!firstSamples[channel]) firstSamples[channel] = msg;
    } else counts.other++;
  },
});

console.log(`dYdX WS probe • net=${net} • market=${market} • duration=${durationSec}s`);
socket.connect();

setTimeout(() => {
  try {
    socket.unsubscribeFromMarkets();
    socket.unsubscribeFromTrades(market);
    socket.unsubscribeFromOrderbook(market);
    socket.unsubscribeFromCandles(market, CandlesResolution.ONE_MINUTE);
  } catch {}
  socket.close();

  const ms = Date.now() - startedAt;
  const rateOf = (c: number) => +(c / (ms / 1000)).toFixed(2);
  const summary = {
    net, market, durationSec, ms,
    counts,
    rate_per_sec: {
      v4_markets: rateOf(counts.v4_markets),
      v4_trades: rateOf(counts.v4_trades),
      v4_orderbook: rateOf(counts.v4_orderbook),
      v4_candles: rateOf(counts.v4_candles),
    },
    sampleChannels: Object.keys(firstSamples),
  };
  const outDir = resolve(process.cwd(), "docs");
  const outPath = resolve(outDir, "dydx-ws-results.json");
  writeFileSync(outPath, JSON.stringify({ ...summary, firstSamples }, null, 2));

  console.log("\n── Summary ──");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Wrote ${outPath}`);

  const ok = counts.subscribed >= 4 && (counts.v4_markets + counts.v4_trades + counts.v4_orderbook + counts.v4_candles) > 0;
  process.exit(ok ? 0 : 1);
}, durationSec * 1000);
