/**
 * binary-maker-paper — live PAPER market-maker on one Polymarket crypto binary,
 * pricing off the Binance feed. NO real orders. This is the G2 forward-paper gate
 * for the coinman2-style maker: prove the loop captures spread in real time before
 * any capital.
 *
 * Each tick:
 *   1. read Binance spot (live trade WS, seeded from REST 1m klines for vol)
 *   2. read the Polymarket CLOB top-of-book for the chosen Yes token
 *   3. compute an INDEPENDENT fair value (binary-fair-value) from spot/strike/τ/σ
 *   4. plan two-sided quotes around fair (binary-maker.planQuotes, A-S skew)
 *   5. simulate fills TRADE-DRIVEN: subscribe to the CLOB market WS; when a trade
 *      prints through our resting quote (price ≤ our bid → a seller hit us, we
 *      buy; price ≥ our ask → a buyer lifted us, we sell), we fill min(tradeSize,
 *      quoteSize). This is the live analogue of maker-fill.ts (trade-based), not
 *      a top-of-book proxy (which can't see intra-poll trades and never fills).
 *   6. update inventory / cash / rebates; mark PnL to both fair and market mid
 *   7. persist fills + periodic snapshots to a paper DB on the passport
 *
 *   npx tsx scripts/binary-maker-paper.ts -- \
 *     --token <yesClobTokenId> --symbol BTC --strike 62000 \
 *     --expiry-iso 2026-06-11T16:00:00Z --seconds 600 --tick-ms 1500
 *
 *   # Up/Down market: strike = the candle open; pass --strike <open price>.
 *
 * Honesty notes baked in:
 *   - the fill model assumes we're at the FRONT of the queue at our price (any
 *     trade through our level fills us). Real queue position means we'd fill LESS
 *     → this is an OPTIMISTIC upper bound on fill count. The live key-funded run
 *     is the final arbiter.
 *   - paper marks unrealized to the market mid (what you could exit at), not fair.
 *   - ADVERSE SELECTION is real and visible here: when our independent fair value
 *     diverges from the market and the market is RIGHT, our fills lose. The PnL
 *     column tells that story honestly.
 */
import "./_env.ts";
import WebSocket from "ws";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { proxiedFetch } from "../src/lib/data/proxy-fetch.ts";
import { poly } from "../src/lib/polymarket/client.ts";
import { fairValueFromMinuteCloses } from "../src/lib/strategies/binary-fair-value.ts";
import { planQuotes, type BinaryMakerParams } from "../src/lib/strategies/binary-maker.ts";
import { makerRebate, type FeeCategory, type ASParams } from "../src/lib/strategies/as-market-maker.ts";

const require_ = createRequire(import.meta.url);
const { HttpsProxyAgent } = require_("https-proxy-agent") as { HttpsProxyAgent: any };

// ── CLI ──
const flag = (n: string, d = ""): string => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const TOKEN = flag("--token");
const SYMBOL = flag("--symbol", "BTC").toUpperCase();
const STRIKE = Number(flag("--strike", "0"));
const EXPIRY_ISO = flag("--expiry-iso");
const SECONDS = Number(flag("--seconds", "600"));
const TICK_MS = Number(flag("--tick-ms", "1500"));
const SIZE_SHARES = Number(flag("--size", "100"));
const HALF_SPREAD = Number(flag("--half-spread", "0.02"));
const MIN_EDGE = Number(flag("--min-edge", "0.008"));
const MAX_INV = Number(flag("--max-inventory", "500"));
const FEE_CAT = (flag("--fee-category", "crypto") as FeeCategory);
// Which fair-value model QUOTES: "enhanced" = momentum + horizon-vol (audit §7
// upgrade), "baseline" = original zero-drift √t. BOTH are computed and logged
// every tick — the snapshots are the forward A/B that decides which one beats
// the market, regardless of which one quotes.
const FV_MODEL = flag("--fv", "enhanced") as "enhanced" | "baseline";
// Market question (recorded in bm_sessions for forensics — which series, which candle).
const QUESTION = flag("--question");
// Strike sanity self-check: if the median |fair − market mid| over the first
// SANITY_TICKS priced ticks exceeds this (in cents, 0 = off), the strike is
// almost certainly derived from the wrong candle / wrong reference — abort
// with exit 2 instead of logging a night of garbage. A real stale-quote edge
// on these markets is a few cents, not 40.
const ABORT_DIVERGENCE = Number(flag("--abort-divergence", "0")) / 100;
const SANITY_TICKS = 8;

if (!TOKEN || !STRIKE || !EXPIRY_ISO) {
  console.error("need --token <yesClobTokenId> --strike <price> --expiry-iso <ISO>");
  process.exit(1);
}
const expiryMs = Date.parse(EXPIRY_ISO);
if (!Number.isFinite(expiryMs)) { console.error(`bad --expiry-iso ${EXPIRY_ISO}`); process.exit(1); }

// ── paper DB (passport, falls back to local data/) ──
const DB_PATH =
  process.env.BINARY_MAKER_DB_PATH ??
  (existsSync("/Volumes/My Passport") ? "/Volumes/My Passport/hft-data/binary-maker-paper.db" : resolve(process.cwd(), "data", "binary-maker-paper.db"));
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS bm_fills (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT, ts INTEGER, iso TEXT,
    side TEXT, price REAL, shares REAL, rebate_usd REAL, spot REAL, p_fair REAL,
    inv_after REAL, cash_after REAL
  );
  CREATE TABLE IF NOT EXISTS bm_snaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT, ts INTEGER, iso TEXT,
    spot REAL, p_fair REAL, mkt_bid REAL, mkt_ask REAL, our_bid REAL, our_ask REAL,
    inventory REAL, cash REAL, rebates REAL, pnl_fair REAL, pnl_mkt REAL
  );
  CREATE TABLE IF NOT EXISTS bm_sessions (
    session TEXT PRIMARY KEY, started_iso TEXT, ended_iso TEXT, token TEXT, symbol TEXT,
    strike REAL, expiry_iso TEXT, summary TEXT
  );
`);
// A/B columns added 2026-06-10 (idempotent for pre-existing DBs)
for (const col of ["p_fair_base REAL", "p_fair_enh REAL", "mu_per_hour REAL", "hurst REAL", "fv_model TEXT"]) {
  try { db.exec(`ALTER TABLE bm_snaps ADD COLUMN ${col}`); } catch { /* exists */ }
}
try { db.exec("ALTER TABLE bm_sessions ADD COLUMN question TEXT"); } catch { /* exists */ }
const SESSION = `${SYMBOL}-${STRIKE}-${Date.now()}`;
const insFill = db.prepare(
  "INSERT INTO bm_fills (session,ts,iso,side,price,shares,rebate_usd,spot,p_fair,inv_after,cash_after) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
);
const insSnap = db.prepare(
  "INSERT INTO bm_snaps (session,ts,iso,spot,p_fair,mkt_bid,mkt_ask,our_bid,our_ask,inventory,cash,rebates,pnl_fair,pnl_mkt,p_fair_base,p_fair_enh,mu_per_hour,hurst,fv_model) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
);

// ── Binance spot via trade WS, seeded with 1m klines for vol ──
const proxyUrl = process.env.DATA_PROXY_URL ?? process.env.POLYMARKET_PROXY_URL;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
let spot = NaN;
const minuteCloses: number[] = [];

async function seedKlines(): Promise<void> {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}USDT&interval=1m&limit=120`;
    const r = await proxiedFetch(url, { signal: AbortSignal.timeout(15_000) });
    const rows = (await r.json()) as any[];
    for (const k of rows) minuteCloses.push(Number(k[4]));
    if (minuteCloses.length) spot = minuteCloses.at(-1)!;
    console.log(`  seeded ${minuteCloses.length} 1m closes, spot ${spot}`);
  } catch (e) {
    console.log(`  kline seed failed: ${(e as Error).message.slice(0, 80)}`);
  }
}

const bn = new WebSocket(
  `wss://stream.binance.com:9443/ws/${SYMBOL.toLowerCase()}usdt@trade`,
  agent ? { agent } : undefined,
);
bn.on("message", (d: WebSocket.RawData) => {
  try {
    const m = JSON.parse(d.toString());
    if (m?.p) spot = Number(m.p);
  } catch { /* */ }
});
bn.on("error", (e) => console.log(`  binance ws err: ${(e as Error).message.slice(0, 60)}`));
// roll the minute-close buffer once a minute from the live spot
let lastMinute = -1;
function rollMinute(nowMs: number): void {
  const minute = Math.floor(nowMs / 60_000);
  if (minute !== lastMinute && Number.isFinite(spot)) {
    if (lastMinute >= 0) { minuteCloses.push(spot); if (minuteCloses.length > 240) minuteCloses.shift(); }
    lastMinute = minute;
  }
}

// ── Polymarket CLOB top-of-book poll ──
// Use the proxy-aware `poly` client (Node's native fetch ignores HTTPS_PROXY,
// and Polymarket is geo-blocked from the local IP → must route via the proxy).
let bookErrLogged = false;
async function fetchBook(): Promise<{ bid: number; ask: number; ltp: number } | null> {
  try {
    const b = (await poly.orderbook(TOKEN)) as {
      bids?: { price: string }[]; asks?: { price: string }[]; last_trade_price?: string;
    };
    // Seed with ∓Infinity, NOT NaN — Math.max(NaN, x) is NaN and would poison every fold.
    const bid = (b.bids ?? []).reduce((mx, l) => Math.max(mx, Number(l.price)), -Infinity);
    const ask = (b.asks ?? []).reduce((mn, l) => Math.min(mn, Number(l.price)), Infinity);
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
    return { bid, ask, ltp: Number(b.last_trade_price) };
  } catch (e) {
    if (!bookErrLogged) { console.log(`  book fetch err: ${(e as Error).message.slice(0, 80)}`); bookErrLogged = true; }
    return null;
  }
}

// ── Fills are driven by the CLOB /book `last_trade_price` (proxied REST), NOT a
// WS — the CLOB trade WS is geo-blocked from this IP and delivers nothing, while
// the /book fetch (proxied) reliably carries the most recent trade price. Each
// time it changes we treat it as a print and fill any resting quote it crosses
// (front-of-queue assumption). Trade size isn't in /book → assume ample (capped
// by our quote size); that's the optimistic upper-bound the honesty note flags.
let liveQuote: { bidPx: number; bidSz: number; askPx: number; askSz: number } | null = null;
let lastLtp = NaN;

// ── maker params ──
const tauHoursAtStart = (expiryMs - Date.now()) / 3_600_000;
const asParams: ASParams = { gamma: 0.08, sigma: 0.25, kappa: 1.2, T: Math.max(tauHoursAtStart, 0.01) };
const makerParams: BinaryMakerParams = {
  baseHalfSpread: HALF_SPREAD,
  minEdge: MIN_EDGE,
  quoteSizeShares: SIZE_SHARES,
  maxInventoryShares: MAX_INV,
  feeCategory: FEE_CAT,
  as: asParams,
  boundaryM: 2000,
};

// ── state ──
let inventory = 0; // signed Yes shares
let cash = 0; // USD; negative = spent
let rebates = 0; // USD rebate income
let fillsCount = 0;
const startMs = Date.now();
const tClock = () => (Date.now() - startMs) / 3_600_000; // hours since start, AS clock

// Trade-driven fill: a print at/through our resting quote fills us (front-of-queue).
let lastFairForFill = 0.5;
function fillFromTrade(tradePx: number, tradeSz: number): void {
  if (!liveQuote) return;
  // A print at ≤ our bid means a seller hit our bid → we BUY.
  if (liveQuote.bidSz > 0 && tradePx <= liveQuote.bidPx && inventory + 1 <= MAX_INV) {
    const sz = Math.min(tradeSz, liveQuote.bidSz, MAX_INV - inventory);
    if (sz > 0) {
      const px = liveQuote.bidPx;
      const reb = makerRebate(px, sz, FEE_CAT);
      cash -= px * sz; inventory += sz; rebates += reb; fillsCount++;
      insFill.run(SESSION, Date.now(), new Date().toISOString(), "BUY", px, sz, reb, spot, lastFairForFill, inventory, cash);
      console.log(`    FILL BUY  ${sz}@${(px * 100).toFixed(1)}¢ (print ${(tradePx * 100).toFixed(1)}¢) reb $${reb.toFixed(3)} → inv ${inventory}`);
      liveQuote.bidSz -= sz; // consume our posted size this tick
    }
  }
  // A print at ≥ our ask means a buyer lifted our ask → we SELL.
  if (liveQuote.askSz > 0 && tradePx >= liveQuote.askPx && inventory - 1 >= -MAX_INV) {
    const sz = Math.min(tradeSz, liveQuote.askSz, MAX_INV + inventory);
    if (sz > 0) {
      const px = liveQuote.askPx;
      const reb = makerRebate(px, sz, FEE_CAT);
      cash += px * sz; inventory -= sz; rebates += reb; fillsCount++;
      insFill.run(SESSION, Date.now(), new Date().toISOString(), "SELL", px, sz, reb, spot, lastFairForFill, inventory, cash);
      console.log(`    FILL SELL ${sz}@${(px * 100).toFixed(1)}¢ (print ${(tradePx * 100).toFixed(1)}¢) reb $${reb.toFixed(3)} → inv ${inventory}`);
      liveQuote.askSz -= sz;
    }
  }
}

function pnl(markPrice: number): number {
  return cash + inventory * markPrice + rebates;
}

// ── main loop ──
console.log(`binary-maker-paper | ${SYMBOL} strike ${STRIKE} | token …${TOKEN.slice(-8)} | expiry ${EXPIRY_ISO}`);
console.log(`  τ≈${tauHoursAtStart.toFixed(2)}h size ${SIZE_SHARES} half ${(HALF_SPREAD * 100).toFixed(1)}¢ minEdge ${(MIN_EDGE * 100).toFixed(1)}¢ maxInv ${MAX_INV} fee ${FEE_CAT}`);
console.log(`  DB ${DB_PATH} | session ${SESSION} | proxy ${agent ? "ON" : "OFF"} | fv ${FV_MODEL} (A/B logged) [PAPER — no real orders]\n`);
db.prepare("INSERT OR REPLACE INTO bm_sessions (session,started_iso,token,symbol,strike,expiry_iso,question) VALUES (?,?,?,?,?,?,?)")
  .run(SESSION, new Date().toISOString(), TOKEN, SYMBOL, STRIKE, EXPIRY_ISO, QUESTION || null);

await seedKlines();

let running = true;
let cycle = 0;
const sanityGaps: number[] = [];
process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });
setTimeout(() => { running = false; }, SECONDS * 1000).unref?.();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

while (running) {
  cycle++;
  const now = Date.now();
  rollMinute(now);

  if (now >= expiryMs) { console.log("  market expired — stopping."); break; }
  if (!Number.isFinite(spot)) { await sleep(TICK_MS); continue; }

  // Compute BOTH models every tick: the snapshots are a forward A/B of
  // baseline (zero-drift, √t) vs enhanced (shrunken-EWMA momentum + VR horizon
  // vol). FV_MODEL picks which one quotes.
  const fvBase = fairValueFromMinuteCloses({ spot, strike: STRIKE, nowMs: now, expiryMs, minuteCloses, volBars: 30 });
  const fvEnh = fairValueFromMinuteCloses({ spot, strike: STRIKE, nowMs: now, expiryMs, minuteCloses, volBars: 30, momentum: true, horizonVol: true });
  const fv = FV_MODEL === "enhanced" ? (fvEnh ?? fvBase) : (fvBase ?? fvEnh);
  const mkt = await fetchBook();
  if (!fv || !mkt) { await sleep(TICK_MS); continue; }

  // strike sanity self-check (first SANITY_TICKS priced ticks)
  if (ABORT_DIVERGENCE > 0 && sanityGaps.length < SANITY_TICKS) {
    sanityGaps.push(Math.abs(fv.pFair - (mkt.bid + mkt.ask) / 2));
    if (sanityGaps.length === SANITY_TICKS) {
      const med = [...sanityGaps].sort((a, b) => a - b)[Math.floor(SANITY_TICKS / 2)]!;
      if (med > ABORT_DIVERGENCE) {
        const msg = `STRIKE-SUSPECT: median |fair−mid| ${(med * 100).toFixed(1)}¢ > ${(ABORT_DIVERGENCE * 100).toFixed(0)}¢ over first ${SANITY_TICKS} ticks — wrong candle/reference likely. Aborting (exit 2).`;
        console.error(`  ${msg}`);
        db.prepare("UPDATE bm_sessions SET ended_iso=?, summary=? WHERE session=?")
          .run(new Date().toISOString(), JSON.stringify({ aborted: "strike-suspect", medianGap: +med.toFixed(4) }), SESSION);
        db.close();
        process.exit(2);
      }
    }
  }

  const plan = planQuotes({
    pFair: fv.pFair,
    inventoryShares: inventory,
    t: tClock(),
    book: { bestBid: mkt.bid, bestAsk: mkt.ask },
    params: makerParams,
  });

  // Publish the freshly-planned quote, then fill against the latest trade print
  // (last_trade_price) if it changed since the previous tick and crosses us.
  lastFairForFill = fv.pFair;
  liveQuote = plan.active
    ? { bidPx: plan.yesBid.px, bidSz: plan.yesBid.sz, askPx: plan.yesAsk.px, askSz: plan.yesAsk.sz }
    : null;
  // Guard against a STALE/OUTLIER last_trade_price: a real print that could fill
  // us sits near the touch. Reject anything more than `LTP_BAND` outside the
  // current book (a 40¢ "print" against a 57/58¢ book is garbage, not a fill).
  const LTP_BAND = 0.03;
  if (
    liveQuote &&
    Number.isFinite(mkt.ltp) &&
    mkt.ltp !== lastLtp &&
    mkt.ltp >= mkt.bid - LTP_BAND &&
    mkt.ltp <= mkt.ask + LTP_BAND
  ) {
    fillFromTrade(mkt.ltp, Infinity);
    lastLtp = mkt.ltp;
  } else if (Number.isFinite(mkt.ltp)) {
    lastLtp = mkt.ltp; // record it so we don't re-evaluate the same stale print
  }

  const mid = (mkt.bid + mkt.ask) / 2;
  const pnlFair = pnl(fv.pFair);
  const pnlMkt = pnl(mid);
  insSnap.run(
    SESSION, now, new Date().toISOString(), spot, fv.pFair, mkt.bid, mkt.ask, plan.yesBid.px, plan.yesAsk.px,
    inventory, cash, rebates, pnlFair, pnlMkt,
    fvBase ? fvBase.pFair : null, fvEnh ? fvEnh.pFair : null,
    fvEnh ? fvEnh.muPerHour : null, fvEnh ? fvEnh.hurst : null, FV_MODEL,
  );

  if (cycle % 5 === 1) {
    const abNote = fvBase && fvEnh ? ` [base ${(fvBase.pFair * 100).toFixed(1)}¢ enh ${(fvEnh.pFair * 100).toFixed(1)}¢ H ${fvEnh.hurst.toFixed(2)}]` : "";
    console.log(
      `[${cycle}] spot ${spot.toFixed(1)} fair ${(fv.pFair * 100).toFixed(1)}¢${abNote} mkt ${(mkt.bid * 100).toFixed(1)}/${(mkt.ask * 100).toFixed(1)}¢ ` +
      `→ ${plan.active ? `bid ${(plan.yesBid.px * 100).toFixed(1)}¢×${plan.yesBid.sz} ask ${(plan.yesAsk.px * 100).toFixed(1)}¢×${plan.yesAsk.sz}` : "withdrawn"} ` +
      `| inv ${inventory} fills ${fillsCount} reb $${rebates.toFixed(2)} pnl(mkt) $${pnlMkt.toFixed(2)} pnl(fair) $${pnlFair.toFixed(2)}`,
    );
  }

  await sleep(TICK_MS);
}

// ── shutdown summary ──
try { bn.close(); } catch { /* */ }
const lastBook = await fetchBook();
const markMid = lastBook ? (lastBook.bid + lastBook.ask) / 2 : 0.5;
const finalFv = fairValueFromMinuteCloses({ spot, strike: STRIKE, nowMs: Date.now(), expiryMs, minuteCloses, volBars: 30 });
const summary = {
  session: SESSION,
  cycles: cycle,
  fills: fillsCount,
  inventory,
  cashUsd: +cash.toFixed(4),
  rebatesUsd: +rebates.toFixed(4),
  markMid: +markMid.toFixed(4),
  pFair: finalFv ? +finalFv.pFair.toFixed(4) : null,
  pnlMarkUsd: +pnl(markMid).toFixed(4),
  pnlFairUsd: finalFv ? +pnl(finalFv.pFair).toFixed(4) : null,
  noteOnHonesty: "top-of-book fill proxy is OPTIMISTIC (ignores queue). Treat pnl as an upper bound; confirm with L2 maker-fill model + a tiny key-funded run.",
};
db.prepare("UPDATE bm_sessions SET ended_iso=?, summary=? WHERE session=?")
  .run(new Date().toISOString(), JSON.stringify(summary), SESSION);

console.log(`\n── Paper session summary ──`);
console.log(JSON.stringify(summary, null, 2));
console.log(`\nInspect: sqlite3 "${DB_PATH}" "SELECT COUNT(*) fills, SUM(rebate_usd) reb FROM bm_fills WHERE session='${SESSION}'"`);
db.close();
