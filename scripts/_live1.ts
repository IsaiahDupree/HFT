/** ONE atomic $1 live test: resolve the current {asset} 5m window, pick the cheaper (underpriced) side, fire ONE FAK BUY.
 * LIVE only when ALLOW_TRADE=1 AND --confirm; else shadow. Hard-capped at $1. Re-resolves in-process so the token can't be
 * stale from a rolled window. */
import "./_env.ts";
import { polyFetch, ensureProxyRoutingReady } from "../src/lib/polymarket/proxy-routing.ts";
import { submitSingleSideMarket } from "../src/lib/polymarket/execute.ts";

const asset = (process.argv[2] || "sol").toLowerCase();
const confirm = process.argv.includes("--confirm");
const step = 300, USD = 1;

function bestAsk(book: any): [number, number] | null {
  const a = (book.asks || []).map((x: any) => [+x.price, +x.size]).sort((p: any, q: any) => p[0] - q[0]);
  return a[0] ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await ensureProxyRoutingReady();
  let now = Math.floor(Date.now() / 1000);
  let tauNow = step - (now % step);
  // fire EARLY in a fresh window (both sides liquid near coin-flip). If <200s remain, wait for the next window.
  if (tauNow < 200) {
    const waitS = (step - (now % step)) + 6;
    console.log(`  ⏳ only ${tauNow}s left — waiting ${waitS}s for a fresh window…`);
    await sleep(waitS * 1000);
    now = Math.floor(Date.now() / 1000);
  }
  const w = Math.floor(now / step) * step;
  const slug = `${asset}-updown-5m-${w}`;
  const ev: any = await (await polyFetch(`https://gamma-api.polymarket.com/events?slug=${slug}`)).json();
  const m = ev?.[0]?.markets?.[0];
  if (!m) { console.log("no market for", slug); process.exit(2); }
  const tids = JSON.parse(m.clobTokenIds || "[]");
  const [upBook, downBook]: any = await Promise.all([
    (await polyFetch(`https://clob.polymarket.com/book?token_id=${tids[0]}`)).json(),
    (await polyFetch(`https://clob.polymarket.com/book?token_id=${tids[1]}`)).json(),
  ]);
  const upAsk = bestAsk(upBook), downAsk = bestAsk(downBook);
  if (!upAsk && !downAsk) { console.log("no asks on either side (resolved?)"); process.exit(2); }
  // pick a side with liquidity; if both, the cheaper (underpriced) side. Skip degenerate ≤2¢ resolved sides.
  const upOk = upAsk && upAsk[0] > 0.02 && upAsk[0] < 0.98;
  const downOk = downAsk && downAsk[0] > 0.02 && downAsk[0] < 0.98;
  if (!upOk && !downOk) { console.log("both sides degenerate/resolved", { upAsk, downAsk }); process.exit(2); }
  const buyUp = upOk && (!downOk || upAsk![0] <= downAsk![0]);
  const token = buyUp ? tids[0] : tids[1];
  const rawAsk = (buyUp ? upAsk![0] : downAsk![0]);
  // marketable limit: cross the spread by 3¢ so the FAK actually fills (the book moves in the ~2s round-trip).
  const ref = Math.min(0.97, +(rawAsk + 0.03).toFixed(2));
  const tau = Math.round(step - (now - w));
  const armed = process.env.ALLOW_TRADE === "1" && confirm;

  console.log("════════════════════════════════════════════════════");
  console.log(`  $1 LIVE TEST — ${armed ? "🔴 ARMED (real order)" : "🟢 SHADOW"}  ${asset.toUpperCase()} 5m  tau=${tau}s`);
  console.log(`  BUY ${buyUp ? "UP" : "DOWN"} (cheap side) @ ref ${ref}  ~${(USD / ref).toFixed(2)} shares for $${USD}`);
  console.log(`  upAsk=${JSON.stringify(upAsk)} downAsk=${JSON.stringify(downAsk)}  ALLOW_TRADE=${process.env.ALLOW_TRADE ?? "unset"} confirm=${confirm}`);
  console.log("════════════════════════════════════════════════════");

  const t0 = Date.now();
  const v: any = await submitSingleSideMarket({
    tokenId: token, side: "BUY", sizeUsd: USD, refPrice: ref,
    rationale: `_live1 ${armed ? "ARMED" : "shadow"} ${asset} 5m cheap-side`,
  });
  const lag = Date.now() - t0;
  console.log(`\n  verdict: ${v.kind}  (${lag}ms)`);
  if (v.kind === "executed") {
    const raw = v.raw || {};
    const making = +(raw.makingAmount ?? raw.making_amount ?? NaN);
    const taking = +(raw.takingAmount ?? raw.taking_amount ?? NaN);
    const fill = making && taking ? making / taking : +(raw.price ?? NaN);
    console.log(`  ✅ order ${v.brokerOrderId ?? "?"} | fill ${Number.isFinite(fill) ? fill.toFixed(4) : "?"} | slippage vs ref ${Number.isFinite(fill) ? ((fill - ref) * 100).toFixed(2) + "¢" : "?"} | shares ${Number.isFinite(taking) ? taking.toFixed(2) : "?"}`);
    console.log(`  raw: ${JSON.stringify(raw).slice(0, 400)}`);
  } else {
    console.log(`  reason: ${v.reason ?? JSON.stringify(v).slice(0, 300)}`);
  }
  process.exit(0);
})();
