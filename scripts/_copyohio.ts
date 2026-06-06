/** Directly copy OhioRiskManagement's NEXT crypto Up/Down entry with a live $1.
 * Polls Ohio's trade feed; on their next FRESH BUY into a still-open 5m/15m window, copies the EXACT token they
 * bought (the trade's asset_id) with a $1 marketable BUY. LIVE only when ALLOW_TRADE=1 && --confirm; $1 hard cap.
 * One-shot: fires once on the next entry, then exits. */
import "./_env.ts";
import { polyFetch, ensureProxyRoutingReady } from "../src/lib/polymarket/proxy-routing.ts";
import { submitSingleSideMarket } from "../src/lib/polymarket/execute.ts";

const OHIO = "0x0c7c5204404e9d5402d258fedac59c7212bae4cb";
const USD = 1, MAX_ROUNDS = 80, POLL = 3000, MAX_AGE = 18;
const confirm = process.argv.includes("--confirm");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseUpdown(slug: string): { step: number; start: number } | null {
  const m = /^([a-z]+)-updown-(5m|15m)-(\d+)$/.exec((slug || "").toLowerCase());
  if (!m) return null;
  return { step: m[2] === "5m" ? 300 : 900, start: +m[3] };
}
function bestAsk(book: any): number | null {
  const a = (book.asks || []).map((x: any) => +x.price).filter((p: number) => p > 0).sort((x: number, y: number) => x - y);
  return a[0] ?? null;
}
function depthNear(book: any, c: number): number {
  const a = (book.asks || []).map((x: any) => [+x.price, +x.size]).filter((x: any) => x[0] > 0).sort((x: any, y: any) => x[0] - y[0]);
  if (!a.length) return 0; const t = a[0][0];
  return a.filter((x: any) => x[0] <= t + c + 1e-9).reduce((s: number, x: any) => s + x[0] * x[1], 0);
}

(async () => {
  await ensureProxyRoutingReady();
  const armed = process.env.ALLOW_TRADE === "1" && confirm;
  console.log(`copy-ohio ${armed ? "🔴 ARMED ($1 live)" : "🟢 SHADOW"} — watching ${OHIO.slice(0, 10)} for the next 5m/15m entry…`);
  const seen = new Set<string>();
  // seed seen with Ohio's CURRENT open positions so we only fire on a genuinely NEW entry after we start watching
  {
    const tr: any = await (await polyFetch(`https://data-api.polymarket.com/trades?user=${OHIO}&limit=40`)).json();
    const now = Math.floor(Date.now() / 1000);
    for (const t of tr || []) {
      const w = parseUpdown(t.slug); if (!w) continue;
      if (w.start + w.step > now) seen.add(t.slug + "|" + t.outcome);   // already-open positions = not new
    }
    console.log(`  seeded ${seen.size} of Ohio's currently-open positions (will only copy a NEW one)`);
  }

  for (let i = 0; i < MAX_ROUNDS; i++) {
    const now = Math.floor(Date.now() / 1000);
    const tr: any = await (await polyFetch(`https://data-api.polymarket.com/trades?user=${OHIO}&limit=30`)).json();
    let pick: any = null;
    for (const t of tr || []) {
      if (String(t.side).toUpperCase() !== "BUY") continue;
      const w = parseUpdown(t.slug); if (!w) continue;
      if (w.start + w.step <= now) continue;                 // window already closed
      const key = t.slug + "|" + t.outcome;
      if (seen.has(key)) continue;
      const age = now - +t.timestamp;
      if (age > MAX_AGE || age < 0) continue;                // only a FRESH entry
      if (!pick || +t.timestamp > +pick.timestamp) pick = t; // newest fresh
    }
    if (pick) {
      const token = pick.asset;                               // the EXACT token Ohio bought
      const book: any = await (await polyFetch(`https://clob.polymarket.com/book?token_id=${token}`)).json();
      const ask = bestAsk(book), depth = depthNear(book, 0.03);
      seen.add(pick.slug + "|" + pick.outcome);
      if (ask == null || ask < 0.04 || ask > 0.97 || depth < 1.0) {
        console.log(`  · Ohio bought ${pick.slug} ${pick.outcome} @${pick.price} but our book is degenerate (ask=${ask} depth=$${depth.toFixed(1)}) — skip, keep watching`);
        await sleep(POLL); continue;
      }
      const ref = Math.min(0.97, +(ask + 0.03).toFixed(2));
      console.log("════════════════════════════════════════════════════");
      console.log(`  ${armed ? "🔴 ARMED" : "🟢 SHADOW"}  COPY Ohio ${pick.slug} ${pick.outcome}`);
      console.log(`  they paid ${pick.price}  | our ask ${ask} ref ${ref}  depth $${depth.toFixed(1)}  age ${now - +pick.timestamp}s`);
      console.log("════════════════════════════════════════════════════");
      const t0 = Date.now();
      const v: any = await submitSingleSideMarket({ tokenId: token, side: "BUY", sizeUsd: USD, refPrice: ref,
        rationale: `copy-ohio ${pick.slug} ${pick.outcome}` });
      const lag = Date.now() - t0; const raw = v?.raw || {};
      const mk = +raw.makingAmount, tk = +raw.takingAmount; const fill = mk && tk ? mk / tk : +raw.price;
      console.log(JSON.stringify({ verdict: v?.kind, slug: pick.slug, side: pick.outcome, their_price: +pick.price,
        fill: Number.isFinite(fill) ? +fill.toFixed(4) : null, shares: Number.isFinite(tk) ? +tk.toFixed(2) : null,
        lag_ms: lag, tx: raw.transactionsHashes?.[0] ?? null, reason: v?.reason ?? null }));
      process.exit(0);
    }
    if (i % 5 === 0) console.log(`  …round ${i + 1}/${MAX_ROUNDS}, no new Ohio entry yet`);
    await sleep(POLL);
  }
  console.log("  no new Ohio entry in the watch window — exiting (no trade).");
  process.exit(0);
})();
