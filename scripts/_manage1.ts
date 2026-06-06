/** Buy-early / SELL-LATE managed $1 trade (the full edge, not just the entry leg).
 * 1) at the early checkpoint of a fresh 5m window, BUY $1 of a clear early leader (like _leader1);
 * 2) then MANAGE: poll the side's bid; if NOT confident the side wins (price < HOLD_PRICE) and the bid is
 *    profitably above entry, SELL into it (lock the higher rate — the user's rule). If confident (>= HOLD_PRICE),
 *    hold for the full $1. Never dump at a loss; if never profitable, ride to resolution.
 * LIVE only when ALLOW_TRADE=1 && --confirm; else shadow (tracks a hypothetical position and prints decisions).
 * Hard-capped $1 on entry. */
import "./_env.ts";
import { polyFetch, ensureProxyRoutingReady } from "../src/lib/polymarket/proxy-routing.ts";
import { submitSingleSideMarket } from "../src/lib/polymarket/execute.ts";

const ASSETS = ["btc", "eth", "sol", "xrp", "doge"];
const STEP = 300, USD = 1;
const LEAD_LO = 0.60, LEAD_HI = 0.80, CHECK_LO = 50, CHECK_HI = 80, MIN_DEPTH = 1.5;
const HOLD_PRICE = 0.85, MIN_PROFIT = 0.05, CLOSE_BUFFER = 30, POLL_MS = 8000;
const confirm = process.argv.includes("--confirm");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function asksOf(b: any) { return (b.asks || []).map((a: any) => [+a.price, +a.size]).sort((p: any, q: any) => p[0] - q[0]); }
function bidsOf(b: any) { return (b.bids || []).map((a: any) => [+a.price, +a.size]).sort((p: any, q: any) => q[0] - p[0]); }
function depthNear(asks: number[][], c: number) { if (!asks.length) return 0; const t = asks[0][0]; return asks.filter((a) => a[0] <= t + c + 1e-9).reduce((s, a) => s + a[0] * a[1], 0); }

// mirror of lastminute.entry_timing.exit_decision
function exitDecision(entry: number, bid: number, tau: number, confident: boolean): "HOLD" | "SELL" | "WAIT" {
  const profit = bid - entry;
  if (confident) return "HOLD";
  if (profit >= MIN_PROFIT - 1e-9) return "SELL";
  if (tau <= CLOSE_BUFFER) return profit > 1e-9 ? "SELL" : "HOLD";
  return "WAIT";
}

async function bookFor(tok: string) { return (await polyFetch(`https://clob.polymarket.com/book?token_id=${tok}`)).json(); }

async function findLeader(w: number) {
  let best: any = null;
  for (const asset of ASSETS) {
    const ev: any = await (await polyFetch(`https://gamma-api.polymarket.com/events?slug=${asset}-updown-5m-${w}`)).json();
    const m = ev?.[0]?.markets?.[0]; if (!m) continue;
    const tids = JSON.parse(m.clobTokenIds || "[]"); const outs = JSON.parse(m.outcomes || "[]").map((o: string) => o.toLowerCase());
    if (tids.length < 2) continue;
    const upI = outs.indexOf("up") >= 0 ? outs.indexOf("up") : 0;
    for (const [side, tok] of [["UP", tids[upI]], ["DOWN", tids[1 - upI]]] as const) {
      const asks = asksOf(await bookFor(tok)); const px = asks[0]?.[0];
      if (px != null && px >= LEAD_LO && px <= LEAD_HI && depthNear(asks, 0.03) >= MIN_DEPTH)
        if (!best || px > best.px) best = { asset, side, tok, px, slug: `${asset}-updown-5m-${w}` };
    }
  }
  return best;
}

(async () => {
  await ensureProxyRoutingReady();
  let now = Math.floor(Date.now() / 1000), into = now % STEP;
  if (into > CHECK_HI) { const wait = STEP - into + CHECK_LO + 2; console.log(`  ⏳ waiting ${wait}s for a fresh window…`); await sleep(wait * 1000); }
  else if (into < CHECK_LO) { await sleep((CHECK_LO - into + 2) * 1000); }
  now = Math.floor(Date.now() / 1000); const w = Math.floor(now / STEP) * STEP;
  const sig = await findLeader(w);
  const armed = process.env.ALLOW_TRADE === "1" && confirm;
  if (!sig) { console.log("  no clean early leader — NO TRADE."); process.exit(0); }

  // ---- ENTRY: buy $1 of the early leader
  const ref = Math.min(0.97, +(sig.px + 0.03).toFixed(2));
  console.log(`  ${armed ? "🔴 ARMED" : "🟢 SHADOW"} ENTRY  BUY ${sig.asset.toUpperCase()} ${sig.side} @ ref ${ref} (leader px ${sig.px})  ${sig.slug}`);
  let entry = sig.px, shares = +(USD / sig.px).toFixed(2);
  if (armed) {
    const v: any = await submitSingleSideMarket({ tokenId: sig.tok, side: "BUY", sizeUsd: USD, refPrice: ref, rationale: `_manage1 entry ${sig.asset} ${sig.side}` });
    if (v?.kind !== "executed") { console.log("  entry not filled:", JSON.stringify(v).slice(0, 200)); process.exit(0); }
    const raw = v.raw || {}; shares = +(+raw.takingAmount || shares).toFixed(2); entry = +(+raw.makingAmount / +raw.takingAmount || entry).toFixed(4);
    console.log(`  ✅ filled ${shares} sh @ ${entry}  tx ${raw.transactionsHashes?.[0] ?? "?"}`);
  }

  // ---- MANAGE: poll bid, apply exitDecision, SELL when the rule says so
  while (true) {
    now = Math.floor(Date.now() / 1000); const tau = STEP - (now - w);
    if (tau <= 0) { console.log("  window closed — held to resolution."); break; }
    const bids = bidsOf(await bookFor(sig.tok)); const bid = bids[0]?.[0] ?? 0;
    const confident = bid >= HOLD_PRICE;
    const d = exitDecision(entry, bid, tau, confident);
    console.log(`  [tau=${tau}s] bid=${bid} entry=${entry} profit=${(bid - entry).toFixed(3)} confident=${confident} -> ${d}`);
    if (d === "SELL") {
      const sellRef = Math.max(0.02, +(bid - 0.02).toFixed(2));
      if (armed) {
        const v: any = await submitSingleSideMarket({ tokenId: sig.tok, side: "SELL", sizeUsd: 0, shares, refPrice: sellRef, rationale: `_manage1 sell-late ${sig.asset} ${sig.side}` });
        const raw = v?.raw || {};
        console.log(`  💰 SOLD ${shares} sh @~${sellRef}  verdict=${v?.kind} net≈${((bid - entry)).toFixed(3)}/$1  tx ${raw.transactionsHashes?.[0] ?? "?"}`);
      } else {
        console.log(`  💰 [shadow] would SELL ${shares} sh @~${sellRef}  net≈${(bid - entry).toFixed(3)}/$1`);
      }
      break;
    }
    await sleep(POLL_MS);
  }
  process.exit(0);
})();
