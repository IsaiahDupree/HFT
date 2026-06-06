/** Generalized single-wallet copier — copy ANY target wallet's next crypto Up/Down entry, EDGE-FILTERED.
 * Usage: npx tsx scripts/_copywallet.ts <wallet> [--sides UP,DOWN] [--assets BTC,ETH,SOL,XRP,DOGE,BNB]
 *                                        [--usd 1] [--loop N] [--confirm]
 * Only copies entries whose (side, asset) is in the wallet's edge filter (where the wallet is net-positive).
 * Copies the EXACT token the wallet bought. LIVE only when ALLOW_TRADE=1 && --confirm; $1 hard cap. */
import "./_env.ts";
import { polyFetch, ensureProxyRoutingReady } from "../src/lib/polymarket/proxy-routing.ts";
import { submitSingleSideMarket } from "../src/lib/polymarket/execute.ts";

function arg(name: string, def = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const WALLET = process.argv[2];
const SIDES = (arg("--sides", "UP,DOWN")).toUpperCase().split(",").map(s => s.trim());
const ASSETS = (arg("--assets", "btc,eth,sol,xrp,doge,bnb")).toLowerCase().split(",").map(s => s.trim());
const USD = Math.min(1, Number(arg("--usd", "1")));
const MAX_ROUNDS = Math.max(1, Number(arg("--loop", "80")));
const confirm = process.argv.includes("--confirm");
const POLL = 3000, MAX_AGE = 18;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function parseUpdown(slug: string): { asset: string; step: number; start: number } | null {
  const m = /^([a-z]+)-updown-(5m|15m)-(\d+)$/.exec((slug || "").toLowerCase());
  return m ? { asset: m[1], step: m[2] === "5m" ? 300 : 900, start: +m[3] } : null;
}
function bestAsk(b: any): number | null {
  const a = (b.asks || []).map((x: any) => +x.price).filter((p: number) => p > 0).sort((x: number, y: number) => x - y);
  return a[0] ?? null;
}
function depthNear(b: any, c: number): number {
  const a = (b.asks || []).map((x: any) => [+x.price, +x.size]).filter((x: any) => x[0] > 0).sort((x: any, y: any) => x[0] - y[0]);
  if (!a.length) return 0; const t = a[0][0];
  return a.filter((x: any) => x[0] <= t + c + 1e-9).reduce((s: number, x: any) => s + x[0] * x[1], 0);
}

(async () => {
  if (!WALLET || !/^0x[0-9a-fA-F]{40}$/.test(WALLET)) { console.log("usage: _copywallet.ts <0xwallet> [--sides ..] [--assets ..] [--confirm]"); process.exit(2); }
  await ensureProxyRoutingReady();
  const armed = process.env.ALLOW_TRADE === "1" && confirm;
  console.log(`copy-wallet ${armed ? "🔴 ARMED ($" + USD + " live)" : "🟢 SHADOW"} — ${WALLET.slice(0, 10)} | sides=${SIDES} assets=${ASSETS}`);
  const seen = new Set<string>();
  // seed currently-open positions so we only copy a NEW entry
  {
    const tr: any = await (await polyFetch(`https://data-api.polymarket.com/trades?user=${WALLET}&limit=40`)).json();
    const now = Math.floor(Date.now() / 1000);
    for (const t of tr || []) { const w = parseUpdown(t.slug); if (w && w.start + w.step > now) seen.add(t.slug + "|" + t.outcome); }
    console.log(`  seeded ${seen.size} open positions`);
  }
  for (let i = 0; i < MAX_ROUNDS; i++) {
    const now = Math.floor(Date.now() / 1000);
    const tr: any = await (await polyFetch(`https://data-api.polymarket.com/trades?user=${WALLET}&limit=30`)).json();
    let pick: any = null;
    for (const t of tr || []) {
      if (String(t.side).toUpperCase() !== "BUY") continue;
      const w = parseUpdown(t.slug); if (!w || w.start + w.step <= now) continue;
      const key = t.slug + "|" + t.outcome; if (seen.has(key)) continue;
      const age = now - +t.timestamp; if (age > MAX_AGE || age < 0) continue;
      // EDGE FILTER: only where the wallet has edge
      if (!SIDES.includes(String(t.outcome).toUpperCase())) { seen.add(key); continue; }
      if (!ASSETS.includes(w.asset)) { seen.add(key); continue; }
      if (!pick || +t.timestamp > +pick.timestamp) pick = t;
    }
    if (pick) {
      seen.add(pick.slug + "|" + pick.outcome);
      const book: any = await (await polyFetch(`https://clob.polymarket.com/book?token_id=${pick.asset}`)).json();
      const ask = bestAsk(book), depth = depthNear(book, 0.03);
      if (ask == null || ask < 0.04 || ask > 0.97 || depth < 1.0) {
        console.log(`  · ${pick.slug} ${pick.outcome} book degenerate (ask=${ask} depth=$${depth.toFixed(1)}) — skip`); await sleep(POLL); continue;
      }
      const ref = Math.min(0.97, +(ask + 0.03).toFixed(2));
      console.log(`  ${armed ? "🔴 ARMED" : "🟢 SHADOW"} COPY ${pick.slug} ${pick.outcome} | they @${pick.price} our ask ${ask} ref ${ref} depth $${depth.toFixed(0)}`);
      const t0 = Date.now();
      const v: any = await submitSingleSideMarket({ tokenId: pick.asset, side: "BUY", sizeUsd: USD, refPrice: ref, rationale: `copy ${WALLET.slice(0, 8)} ${pick.slug} ${pick.outcome}` });
      const raw = v?.raw || {}; const mk = +raw.makingAmount, tk = +raw.takingAmount; const fill = mk && tk ? mk / tk : +raw.price;
      console.log(JSON.stringify({ verdict: v?.kind, slug: pick.slug, side: pick.outcome, their_price: +pick.price, fill: Number.isFinite(fill) ? +fill.toFixed(4) : null, shares: Number.isFinite(tk) ? +tk.toFixed(2) : null, lag_ms: Date.now() - t0, tx: raw.transactionsHashes?.[0] ?? null, reason: v?.reason ?? null }));
      process.exit(0);
    }
    if (i % 5 === 0) console.log(`  …round ${i + 1}/${MAX_ROUNDS}, no edge-filtered entry yet`);
    await sleep(POLL);
  }
  console.log("  no edge-filtered entry in the watch window — no trade."); process.exit(0);
})();
