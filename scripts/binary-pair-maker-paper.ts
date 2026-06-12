/**
 * binary-pair-maker-paper — live PAPER run of the MERGE-MAKER (binary-pair-maker)
 * on one Polymarket binary: maker BUY bids on BOTH tokens, complete sets merged
 * at $1, unpaired remainder capped structurally. NO real orders.
 *
 * This is the successor paper loop to binary-maker-paper after the naked-FV
 * demotion (2026-06-11: market mid out-forecasts our fair → naked quoting
 * supplies edge; the verified winners are pair/merge makers). The fair value
 * here is a SAFETY CAP on each leg's bid, not the edge — the edge is the pair
 * budget (yesBid + noBid ≤ 1 − margin − fees) plus rebates.
 *
 *   npx tsx scripts/binary-pair-maker-paper.ts -- \
 *     --yes-token <id> --no-token <id> --symbol BTC --strike 62000 \
 *     --expiry-iso 2026-06-12T00:05:00Z --seconds 280
 *
 * Honesty notes (same as the naked loop, still apply):
 *   - LTP-driven fills assume front-of-queue + ample print size → fill count is
 *     an OPTIMISTIC upper bound (the queue-position model in src/lib/backtest/
 *     is the G3 corrective).
 *   - final mark prefers live book → last snapshot mid → fair; source recorded.
 *   - per-fill τ is recorded so "where do we bleed/earn" is answerable by phase.
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
import { planPairQuotes, settleMerge, type PairMakerParams } from "../src/lib/strategies/binary-pair-maker.ts";
import { makerRebate, type FeeCategory } from "../src/lib/strategies/as-market-maker.ts";

const require_ = createRequire(import.meta.url);
const { HttpsProxyAgent } = require_("https-proxy-agent") as { HttpsProxyAgent: any };

// ── CLI ──
const flag = (n: string, d = ""): string => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const YES_TOKEN = flag("--yes-token");
const NO_TOKEN = flag("--no-token");
const SYMBOL = flag("--symbol", "BTC").toUpperCase();
const STRIKE = Number(flag("--strike", "0"));
const EXPIRY_ISO = flag("--expiry-iso");
const SECONDS = Number(flag("--seconds", "280"));
const TICK_MS = Number(flag("--tick-ms", "2000"));
const QUESTION = flag("--question");
const DURATION_MIN = Number(flag("--duration-min", "0"));
const FEE_CAT = flag("--fee-category", "crypto") as FeeCategory;
const ABORT_DIVERGENCE = Number(flag("--abort-divergence", "0")) / 100;
const SANITY_TICKS = 8;

const params: PairMakerParams = {
  quoteSizeShares: Number(flag("--size", "25")),
  mergeMargin: Number(flag("--merge-margin", "0.02")),
  feeBuffer: Number(flag("--fee-buffer", "0.005")),
  maxUnpairedShares: Number(flag("--max-unpaired", "50")),
  tauFloorSec: Number(flag("--tau-floor", "60")),
  safetyEdge: Number(flag("--safety-edge", "0.01")),
};

if (!YES_TOKEN || !NO_TOKEN || !STRIKE || !EXPIRY_ISO) {
  console.error("need --yes-token --no-token --strike --expiry-iso");
  process.exit(1);
}
const expiryMs = Date.parse(EXPIRY_ISO);
if (!Number.isFinite(expiryMs)) { console.error(`bad --expiry-iso ${EXPIRY_ISO}`); process.exit(1); }

const VOL_BARS = DURATION_MIN > 0 ? Math.max(10, Math.min(60, Math.round(DURATION_MIN))) : 30;

// ── paper DB (passport, falls back to local data/) — pm_* tables ──
const DB_PATH =
  process.env.BINARY_MAKER_DB_PATH ??
  (existsSync("/Volumes/My Passport") ? "/Volumes/My Passport/hft-data/binary-maker-paper.db" : resolve(process.cwd(), "data", "binary-maker-paper.db"));
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS pm_sessions (
    session TEXT PRIMARY KEY, started_iso TEXT, ended_iso TEXT, yes_token TEXT, no_token TEXT,
    symbol TEXT, strike REAL, expiry_iso TEXT, question TEXT, params TEXT, summary TEXT
  );
  CREATE TABLE IF NOT EXISTS pm_fills (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT, ts INTEGER, iso TEXT,
    leg TEXT, price REAL, shares REAL, rebate_usd REAL, tau_sec REAL, spot REAL, p_fair REAL,
    inv_yes REAL, inv_no REAL, cash REAL
  );
  CREATE TABLE IF NOT EXISTS pm_snaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT, ts INTEGER, iso TEXT,
    spot REAL, p_fair REAL, yes_bid REAL, yes_ask REAL, no_bid REAL, no_ask REAL,
    our_yes_bid REAL, our_no_bid REAL, inv_yes REAL, inv_no REAL, merged REAL,
    locked_margin REAL, cash REAL, rebates REAL, pnl_mkt REAL, tau_sec REAL
  );
`);
const SESSION = `PM-${SYMBOL}-${STRIKE}-${Date.now()}`;
const insFill = db.prepare(
  "INSERT INTO pm_fills (session,ts,iso,leg,price,shares,rebate_usd,tau_sec,spot,p_fair,inv_yes,inv_no,cash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
);
const insSnap = db.prepare(
  "INSERT INTO pm_snaps (session,ts,iso,spot,p_fair,yes_bid,yes_ask,no_bid,no_ask,our_yes_bid,our_no_bid,inv_yes,inv_no,merged,locked_margin,cash,rebates,pnl_mkt,tau_sec) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
);

// ── Binance spot via trade WS, seeded with 1m klines ──
const proxyUrl = process.env.DATA_PROXY_URL ?? process.env.POLYMARKET_PROXY_URL;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
let spot = NaN;
const minuteCloses: number[] = [];

async function seedKlines(): Promise<void> {
  for (const host of ["https://api.binance.com", "https://data-api.binance.vision"]) {
    try {
      const fetchFn = host.includes("vision") ? fetch : proxiedFetch;
      const r = await fetchFn(`${host}/api/v3/klines?symbol=${SYMBOL}USDT&interval=1m&limit=120`, { signal: AbortSignal.timeout(15_000) });
      const rows = (await r.json()) as any[];
      if (!Array.isArray(rows) || !rows.length) continue;
      minuteCloses.length = 0;
      for (const k of rows) minuteCloses.push(Number(k[4]));
      spot = minuteCloses.at(-1)!;
      console.log(`  seeded ${minuteCloses.length} 1m closes via ${host.includes("vision") ? "mirror" : "proxy"}, spot ${spot}`);
      return;
    } catch (e) {
      console.log(`  kline seed failed (${host}): ${(e as Error).message.slice(0, 60)}`);
    }
  }
}

let lastSpotMs = 0;
const bn = new WebSocket(`wss://stream.binance.com:9443/ws/${SYMBOL.toLowerCase()}usdt@trade`, agent ? { agent } : undefined);
bn.on("message", (d: WebSocket.RawData) => {
  try { const m = JSON.parse(d.toString()); if (m?.p) { spot = Number(m.p); lastSpotMs = Date.now(); } } catch { /* */ }
});
bn.on("error", (e) => console.log(`  binance ws err: ${(e as Error).message.slice(0, 60)}`));

// Staleness fallback (RAILS-REVIEW finding 13: a dead WS feed quotes forever on
// a frozen spot — observed live: WS 451 geo-block → fair pinned at the seed).
// If no WS tick for 20s, poll the keyless mirror's last price every loop pass.
let lastPollMs = 0;
async function refreshSpotIfStale(now: number): Promise<void> {
  if (now - lastSpotMs < 20_000 || now - lastPollMs < 5_000) return;
  lastPollMs = now;
  try {
    const r = await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${SYMBOL}USDT`, { signal: AbortSignal.timeout(5_000) });
    const j = (await r.json()) as { price?: string };
    const px = Number(j?.price);
    if (px > 0) { spot = px; lastSpotMs = now; }
  } catch { /* next pass */ }
}
let lastMinute = -1;
function rollMinute(nowMs: number): void {
  const minute = Math.floor(nowMs / 60_000);
  if (minute !== lastMinute && Number.isFinite(spot)) {
    if (lastMinute >= 0) { minuteCloses.push(spot); if (minuteCloses.length > 240) minuteCloses.shift(); }
    lastMinute = minute;
  }
}

// ── CLOB book per token (proxy-aware poly client) ──
type Book = { bid: number; ask: number; ltp: number };
const bookErrLogged = new Set<string>();
async function fetchBook(token: string): Promise<Book | null> {
  try {
    const b = (await poly.orderbook(token)) as { bids?: { price: string }[]; asks?: { price: string }[]; last_trade_price?: string };
    const bid = (b.bids ?? []).reduce((mx, l) => Math.max(mx, Number(l.price)), -Infinity);
    const ask = (b.asks ?? []).reduce((mn, l) => Math.min(mn, Number(l.price)), Infinity);
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
    return { bid, ask, ltp: Number(b.last_trade_price) };
  } catch (e) {
    if (!bookErrLogged.has(token)) { console.log(`  book err …${token.slice(-6)}: ${(e as Error).message.slice(0, 70)}`); bookErrLogged.add(token); }
    return null;
  }
}

// ── state ──
let invYes = 0, invNo = 0;       // long shares per leg
let costYes = 0, costNo = 0;     // dollars in CURRENT inventory (avg-cost basis)
let cash = 0;                    // negative = spent
let rebates = 0, mergedSets = 0, lockedMargin = 0, fillsCount = 0;
let liveYesBid: { px: number; sz: number } | null = null;
let liveNoBid: { px: number; sz: number } | null = null;
const lastLtp: Record<string, number> = {};
const sanityGaps: number[] = [];

const LTP_BAND = 0.03;
function tryFill(leg: "YES" | "NO", book: Book, quote: { px: number; sz: number } | null, pFair: number, tauSec: number): void {
  const token = leg === "YES" ? YES_TOKEN : NO_TOKEN;
  if (!quote || !Number.isFinite(book.ltp)) { if (Number.isFinite(book.ltp)) lastLtp[token] = book.ltp; return; }
  const fresh = book.ltp !== lastLtp[token];
  const sane = book.ltp >= book.bid - LTP_BAND && book.ltp <= book.ask + LTP_BAND;
  if (fresh && sane && book.ltp <= quote.px) {
    const sz = quote.sz;
    const px = quote.px;
    const reb = makerRebate(px, sz, FEE_CAT);
    cash -= px * sz; rebates += reb; fillsCount++;
    if (leg === "YES") { invYes += sz; costYes += px * sz; } else { invNo += sz; costNo += px * sz; }
    insFill.run(SESSION, Date.now(), new Date().toISOString(), leg, px, sz, reb, tauSec, spot, pFair, invYes, invNo, cash);
    console.log(`    FILL BUY-${leg} ${sz}@${(px * 100).toFixed(0)}¢ (print ${(book.ltp * 100).toFixed(0)}¢, τ ${tauSec.toFixed(0)}s) → yes ${invYes} no ${invNo}`);
    quote.sz = 0; // consumed this tick
  }
  if (Number.isFinite(book.ltp)) lastLtp[token] = book.ltp;
}

// ── main ──
console.log(`binary-PAIR-maker-paper | ${SYMBOL} strike ${STRIKE} | expiry ${EXPIRY_ISO}`);
console.log(`  size ${params.quoteSizeShares} margin ${(params.mergeMargin * 100).toFixed(0)}¢ unpaired≤${params.maxUnpairedShares} τfloor ${params.tauFloorSec}s`);
console.log(`  DB ${DB_PATH} | session ${SESSION} | proxy ${agent ? "ON" : "OFF"} [PAPER — no real orders]\n`);
db.prepare("INSERT OR REPLACE INTO pm_sessions (session,started_iso,yes_token,no_token,symbol,strike,expiry_iso,question,params) VALUES (?,?,?,?,?,?,?,?,?)")
  .run(SESSION, new Date().toISOString(), YES_TOKEN, NO_TOKEN, SYMBOL, STRIKE, EXPIRY_ISO, QUESTION || null, JSON.stringify(params));

await seedKlines();

let running = true;
let cycle = 0;
process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });
setTimeout(() => { running = false; }, SECONDS * 1000).unref?.();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

while (running) {
  cycle++;
  const now = Date.now();
  await refreshSpotIfStale(now);
  rollMinute(now);
  if (now >= expiryMs) { console.log("  market expired — stopping."); break; }
  if (!Number.isFinite(spot)) { await sleep(TICK_MS); continue; }

  const tauSec = (expiryMs - now) / 1000;
  // baseline fair (the A/B verdict: baseline ≥ enhanced; fair is a SAFETY cap here)
  const fv = fairValueFromMinuteCloses({ spot, strike: STRIKE, nowMs: now, expiryMs, minuteCloses, volBars: VOL_BARS });
  const [yesBook, noBook] = await Promise.all([fetchBook(YES_TOKEN), fetchBook(NO_TOKEN)]);
  if (!fv || !yesBook || !noBook) { await sleep(TICK_MS); continue; }

  // strike sanity self-check vs the YES mid
  if (ABORT_DIVERGENCE > 0 && sanityGaps.length < SANITY_TICKS) {
    sanityGaps.push(Math.abs(fv.pFair - (yesBook.bid + yesBook.ask) / 2));
    if (sanityGaps.length === SANITY_TICKS) {
      const med = [...sanityGaps].sort((a, b) => a - b)[Math.floor(SANITY_TICKS / 2)]!;
      if (med > ABORT_DIVERGENCE) {
        console.error(`  STRIKE-SUSPECT: median |fair−mid| ${(med * 100).toFixed(1)}¢ — aborting (exit 2).`);
        db.prepare("UPDATE pm_sessions SET ended_iso=?, summary=? WHERE session=?")
          .run(new Date().toISOString(), JSON.stringify({ aborted: "strike-suspect", medianGap: +med.toFixed(4) }), SESSION);
        db.close();
        process.exit(2);
      }
    }
  }

  const plan = planPairQuotes({
    pFair: fv.pFair,
    yesBook: { bestBid: yesBook.bid, bestAsk: yesBook.ask },
    noBook: { bestBid: noBook.bid, bestAsk: noBook.ask },
    yesShares: invYes, noShares: invNo, tauSec, params,
  });
  liveYesBid = plan.yesBid ? { px: plan.yesBid.px, sz: plan.yesBid.sz } : null;
  liveNoBid = plan.noBid ? { px: plan.noBid.px, sz: plan.noBid.sz } : null;

  tryFill("YES", yesBook, liveYesBid, fv.pFair, tauSec);
  tryFill("NO", noBook, liveNoBid, fv.pFair, tauSec);

  // merge every complete set immediately (paper analogue of the on-chain merge)
  const m = settleMerge({ yesShares: invYes, noShares: invNo, yesCost: costYes, noCost: costNo });
  if (m.merged > 0) {
    cash += m.cashIn;
    lockedMargin += m.lockedMargin;
    mergedSets += m.merged;
    ({ yesShares: invYes, noShares: invNo, yesCost: costYes, noCost: costNo } = m.next);
    console.log(`    MERGE ${m.merged} sets → +$${m.cashIn.toFixed(2)} cash (locked margin +$${m.lockedMargin.toFixed(2)}) | yes ${invYes} no ${invNo}`);
  }

  const yesMid = (yesBook.bid + yesBook.ask) / 2;
  const noMid = (noBook.bid + noBook.ask) / 2;
  const pnlMkt = cash + invYes * yesMid + invNo * noMid + rebates;
  insSnap.run(SESSION, now, new Date().toISOString(), spot, fv.pFair, yesBook.bid, yesBook.ask, noBook.bid, noBook.ask,
    liveYesBid?.px ?? null, liveNoBid?.px ?? null, invYes, invNo, mergedSets, lockedMargin, cash, rebates, pnlMkt, tauSec);

  if (cycle % 5 === 1) {
    console.log(
      `[${cycle}] τ${tauSec.toFixed(0)}s fair ${(fv.pFair * 100).toFixed(1)}¢ yes ${(yesBook.bid * 100).toFixed(0)}/${(yesBook.ask * 100).toFixed(0)} no ${(noBook.bid * 100).toFixed(0)}/${(noBook.ask * 100).toFixed(0)} ` +
      `→ ${plan.note} | merged ${mergedSets} locked $${lockedMargin.toFixed(2)} pnl $${pnlMkt.toFixed(2)}`,
    );
  }
  await sleep(TICK_MS);
}

// ── shutdown summary (honest final mark) ──
try { bn.close(); } catch { /* */ }
const [fbYes, fbNo] = await Promise.all([fetchBook(YES_TOKEN), fetchBook(NO_TOKEN)]);
const lastSnap = db.prepare("SELECT yes_bid,yes_ask,no_bid,no_ask FROM pm_snaps WHERE session=? ORDER BY ts DESC LIMIT 1").get(SESSION) as any;
const yesMark = fbYes ? (fbYes.bid + fbYes.ask) / 2 : lastSnap ? (lastSnap.yes_bid + lastSnap.yes_ask) / 2 : 0.5;
const noMark = fbNo ? (fbNo.bid + fbNo.ask) / 2 : lastSnap ? (lastSnap.no_bid + lastSnap.no_ask) / 2 : 0.5;
const markSource = fbYes && fbNo ? "book" : lastSnap ? "last-snapshot-mid" : "UNKNOWN-0.5";
const sharesBought = fillsCount > 0 ? db.prepare("SELECT SUM(shares) s FROM pm_fills WHERE session=?").get(SESSION) as any : { s: 0 };
const totalShares = Number(sharesBought?.s ?? 0);
const summary = {
  session: SESSION,
  cycles: cycle,
  fills: fillsCount,
  sharesBought: totalShares,
  mergedSets,
  pairCompletionPct: totalShares > 0 ? +(100 * (2 * mergedSets) / totalShares).toFixed(1) : null,
  lockedMarginUsd: +lockedMargin.toFixed(4),
  rebatesUsd: +rebates.toFixed(4),
  unpairedFinal: { yes: invYes, no: invNo },
  pnlMarkUsd: +(cash + invYes * yesMark + invNo * noMark + rebates).toFixed(4),
  markSource,
  noteOnHonesty: "LTP fills are optimistic (front-of-queue, ample size). Locked margin + rebates are the structural income; unpaired mark is the directional residue.",
};
db.prepare("UPDATE pm_sessions SET ended_iso=?, summary=? WHERE session=?").run(new Date().toISOString(), JSON.stringify(summary), SESSION);
console.log(`\n── PAIR paper session summary ──\n${JSON.stringify(summary, null, 2)}`);
db.close();
