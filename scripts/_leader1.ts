/** ONE $1 live trade on the VALIDATED buy-early/sell-late edge (entry leg): at ~55-75s into a FRESH 5m window,
 * if any asset shows a CLEAR EARLY LEADER (leg price in a clean band) on a liquid book, buy $1 of the leader side.
 * Bounded: scans up to MAX_WINDOWS fresh windows, fires at most ONCE, then exits. LIVE only when ALLOW_TRADE=1 &&
 * --confirm; else shadow. Hard-capped $1. Holds to resolution (no live sell leg yet — captures the OOS-positive
 * hold version of the edge: +6.7%/$1, 87.5% win at lead>=0.15). */
import "./_env.ts";
import { polyFetch, ensureProxyRoutingReady } from "../src/lib/polymarket/proxy-routing.ts";
import { submitSingleSideMarket } from "../src/lib/polymarket/execute.ts";

const ASSETS = ["btc", "eth", "sol", "xrp", "doge"];
const STEP = 300, USD = 1;
const LEAD_LO = 0.60, LEAD_HI = 0.80;     // clean early lead: clear (>=0.60) but room to drift / not near-resolved
const CHECK_LO = 50, CHECK_HI = 80;       // seconds-into-window to read the EARLY leader
const MIN_DEPTH_USD = 1.5;                // need at least this much ask resting near touch to fill $1 honestly
const MAX_WINDOWS = 4;                     // bounded search (~20 min) then give up — no forcing a bad trade
const confirm = process.argv.includes("--confirm");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function asksOf(book: any): [number, number][] {
  return (book.asks || []).map((a: any) => [+a.price, +a.size]).sort((p: any, q: any) => p[0] - q[0]);
}
function depthWithin(asks: [number, number][], cents: number): number {
  if (!asks.length) return 0;
  const best = asks[0][0];
  return asks.filter((a) => a[0] <= best + cents + 1e-9).reduce((s, a) => s + a[0] * a[1], 0);
}

async function scanWindow(): Promise<any | null> {
  const now = Math.floor(Date.now() / 1000);
  const w = Math.floor(now / STEP) * STEP;
  let best: any = null;
  for (const asset of ASSETS) {
    const slug = `${asset}-updown-5m-${w}`;
    const ev: any = await (await polyFetch(`https://gamma-api.polymarket.com/events?slug=${slug}`)).json();
    const m = ev?.[0]?.markets?.[0];
    if (!m) continue;
    const tids = JSON.parse(m.clobTokenIds || "[]");
    const outs = JSON.parse(m.outcomes || "[]").map((o: string) => o.toLowerCase());
    if (tids.length < 2) continue;
    const upI = outs.indexOf("up") >= 0 ? outs.indexOf("up") : 0;
    const [upBook, downBook]: any = await Promise.all([
      (await polyFetch(`https://clob.polymarket.com/book?token_id=${tids[upI]}`)).json(),
      (await polyFetch(`https://clob.polymarket.com/book?token_id=${tids[1 - upI]}`)).json(),
    ]);
    const upAsks = asksOf(upBook), downAsks = asksOf(downBook);
    const upPx = upAsks[0]?.[0], downPx = downAsks[0]?.[0];
    // the leader is the side whose ask sits in the clean lead band with enough depth
    for (const [side, px, asks, tok] of [
      ["UP", upPx, upAsks, tids[upI]], ["DOWN", downPx, downAsks, tids[1 - upI]],
    ] as const) {
      if (px == null) continue;
      if (px >= LEAD_LO && px <= LEAD_HI && depthWithin(asks, 0.03) >= MIN_DEPTH_USD) {
        const score = px;  // prefer the clearer lead
        if (!best || score > best.score) best = { asset, slug, side, px, tok, score, depth: depthWithin(asks, 0.03) };
      }
    }
  }
  return best;
}

(async () => {
  await ensureProxyRoutingReady();
  for (let i = 0; i < MAX_WINDOWS; i++) {
    let now = Math.floor(Date.now() / 1000);
    let into = now % STEP;
    // align to the EARLY checkpoint of a window
    if (into > CHECK_HI) {
      const wait = STEP - into + CHECK_LO + 2;
      console.log(`  ⏳ into=${into}s — waiting ${wait}s for the next window's early checkpoint…`);
      await sleep(wait * 1000); now = Math.floor(Date.now() / 1000); into = now % STEP;
    } else if (into < CHECK_LO) {
      const wait = CHECK_LO - into + 2;
      await sleep(wait * 1000); now = Math.floor(Date.now() / 1000); into = now % STEP;
    }
    const sig = await scanWindow();
    const armed = process.env.ALLOW_TRADE === "1" && confirm;
    if (!sig) { console.log(`  [win ${i + 1}/${MAX_WINDOWS}] into=${into}s — no clean early leader (${LEAD_LO}-${LEAD_HI} on a liquid book)`);
      await sleep(8000); continue; }
    const ref = Math.min(0.97, +(sig.px + 0.03).toFixed(2));
    console.log("════════════════════════════════════════════════════");
    console.log(`  $1 LEADER TRADE — ${armed ? "🔴 ARMED (real)" : "🟢 SHADOW"}  ${sig.asset.toUpperCase()} 5m  into=${into}s`);
    console.log(`  BUY ${sig.side} (early leader) px=${sig.px} ref=${ref} depth≈$${sig.depth.toFixed(1)}  slug=${sig.slug}`);
    console.log("════════════════════════════════════════════════════");
    const t0 = Date.now();
    const v: any = await submitSingleSideMarket({ tokenId: sig.tok, side: "BUY", sizeUsd: USD, refPrice: ref,
      rationale: `_leader1 ${armed ? "ARMED" : "shadow"} ${sig.asset} early-leader ${sig.side}` });
    const lag = Date.now() - t0;
    const raw = v?.raw || {};
    const making = +(raw.makingAmount ?? NaN), taking = +(raw.takingAmount ?? NaN);
    const fill = making && taking ? making / taking : +(raw.price ?? NaN);
    console.log(JSON.stringify({ verdict: v?.kind, asset: sig.asset, side: sig.side, slug: sig.slug, entry_px: sig.px,
      fill: Number.isFinite(fill) ? +fill.toFixed(4) : null, shares: Number.isFinite(taking) ? +taking.toFixed(2) : null,
      lag_ms: lag, tx: raw.transactionsHashes?.[0] ?? null, reason: v?.reason ?? null }));
    process.exit(0);
  }
  console.log(`  no clean early-leader signal in ${MAX_WINDOWS} windows — NO TRADE (don't force it).`);
  process.exit(0);
})();
