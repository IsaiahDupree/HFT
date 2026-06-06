/** temp helper — resolve the current SOL/ETH 5m up/down token + best ask THROUGH THE PROXY, and report the funder's
 * real USDC.e cash balance. Read-only; places nothing. */
import "./_env.ts";
import { polyFetch, ensureProxyRoutingReady } from "../src/lib/polymarket/proxy-routing.ts";

const asset = (process.argv[2] || "sol").toLowerCase();
const step = 300;

(async () => {
  await ensureProxyRoutingReady();
  const now = Math.floor(Date.now() / 1000);
  const w = Math.floor(now / step) * step;
  const slug = `${asset}-updown-5m-${w}`;
  const ev: any = await (await polyFetch(`https://gamma-api.polymarket.com/events?slug=${slug}`)).json();
  const m = ev?.[0]?.markets?.[0];
  if (!m) { console.log(JSON.stringify({ ok: false, error: "no market", slug })); return; }
  const tids = JSON.parse(m.clobTokenIds || "[]");
  const book: any = await (await polyFetch(`https://clob.polymarket.com/book?token_id=${tids[0]}`)).json();
  const asks = (book.asks || []).map((a: any) => [+a.price, +a.size]).sort((x: any, y: any) => x[0] - y[0]);
  const bids = (book.bids || []).map((b: any) => [+b.price, +b.size]).sort((x: any, y: any) => y[0] - x[0]);

  // funder USDC.e cash balance (Polygon RPC, direct — polygon-rpc.com is in NO_PROXY)
  const funder = process.env.POLYMARKET_FUNDER_ADDRESS!;
  const USDCe = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
  const data = "0x70a08231" + "000000000000000000000000" + funder.slice(2).toLowerCase();
  let usdc = "?";
  try {
    const r: any = await (await fetch("https://polygon-rpc.com", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDCe, data }, "latest"] }),
    })).json();
    usdc = (parseInt(r.result, 16) / 1e6).toFixed(2);
  } catch (e: any) { usdc = "rpc-err:" + String(e).slice(0, 40); }

  console.log(JSON.stringify({
    ok: true, slug, wstart: w, tau_s: Math.round(step - (now - w)),
    up_token: tids[0], down_token: tids[1],
    best_ask_UP: asks[0] ?? null, best_bid_UP: bids[0] ?? null,
    up_ask_price: asks[0]?.[0] ?? null, down_ask_price: asks[0] ? +(1 - bids[0][0]).toFixed(3) : null,
    funder, funder_USDCe_cash: usdc,
  }, null, 0));
})();
