/**
 * CLI tail of OrderFilled events from both Polymarket exchange contracts.
 * Prints a one-liner per fill: time, exchange, implied price, size, side.
 *
 *   npm run onchain:watch            # public RPC, both contracts
 *   POLYGON_WS_URL=wss://... npm run onchain:watch
 */
import "./_env.ts";
import { subscribeOrderFilled, impliedPriceFromFill } from "../src/lib/polymarket/onchain.ts";

let count = 0;
let connected = false;
const start = Date.now();

const stop = subscribeOrderFilled({
  onStatus: (s) => {
    if (s === "open" && !connected) { connected = true; console.log("[onchain] connected"); }
    if (s === "closed") console.log("[onchain] closed — reconnecting");
    if (s === "error") console.log("[onchain] error");
  },
  onFill: (fill) => {
    count++;
    const ts = new Date(fill.receivedAt).toISOString().slice(11, 23);
    const px = impliedPriceFromFill(fill);
    const exch = fill.exchange.padEnd(8);
    if (px) {
      console.log(`${ts}  ${exch}  tok=${px.tokenId.slice(0, 12)}…  maker=${px.makerSide}  ${px.sizeShares.toFixed(2)} sh @ $${px.pricePerShare.toFixed(4)}  tx=${fill.txHash.slice(0, 14)}…`);
    } else {
      console.log(`${ts}  ${exch}  outcome↔outcome match  tx=${fill.txHash.slice(0, 14)}…`);
    }
  },
});

process.on("SIGINT", () => {
  console.log(`\n[onchain] saw ${count} fills in ${((Date.now() - start) / 1000).toFixed(1)}s. shutting down.`);
  stop();
  process.exit(0);
});

// Auto-exit after 2 min if not killed (so it doesn't hang in CI).
setTimeout(() => {
  console.log(`\n[onchain] timed out after 2 min — ${count} fills observed.`);
  stop();
  process.exit(0);
}, 2 * 60_000);
