/**
 * pair-maker-backtest — G3: the merge-maker (binary-pair-maker planner) replayed
 * on REAL Polymarket L2 history (PMXT hourly parquet → per-token JSONL extracts)
 * with the BACK-OF-QUEUE fill model (src/lib/backtest/queue-fill.ts) instead of
 * the optimistic front-of-queue LTP fills of the live paper loop.
 *
 * Per 5-min window (manifest from scripts/pmxt_extract_batch.py):
 *   - replay both tokens' book-update streams + trade tape chronologically;
 *   - every TICK_MS, plan quotes with planPairQuotes() exactly like
 *     binary-pair-maker-paper (fair value from Binance 1m closes — SAFETY cap,
 *     not the edge; the edge is the pair budget + rebates);
 *   - resting bids fill ONLY via queue-position accounting: we join the BACK of
 *     the visible queue at post time (+ACK_MS latency), prints consume the queue
 *     ahead first, prints through our price sweep us, cancels split per
 *     --cancel-mode (prorata default; behind/ahead bracket the estimate);
 *   - complete sets merge at $1 (settleMerge); the residual unpaired inventory
 *     is marked to the REAL 0/1 settle from Gamma (manifest.outcomeUp).
 *
 * Decomposition per window — identical to TradingBot2's merge_report:
 *   maker income (locked merge margin + rebates)  vs  residual settle PnL,
 *   pair-completion %, by-unpaired buckets paired(<=10) / mild(10-30) / heavy(>30).
 *
 *   npx tsx scripts/pair-maker-backtest.ts -- \
 *     --manifest "/Volumes/My Passport/hft-data/pmxt/extracts/2026-06-10/manifest.json" \
 *     [--cancel-mode prorata|behind|ahead] [--tick-ms 2000] [--ack-ms 250]
 *     [--size 25] [--merge-margin 0.02] [--out results.json]
 *
 * No mock data: real PMXT books/prints, real Binance 1m klines (cached to disk
 * after first fetch), real Gamma settles. Spot is the close of the last
 * COMPLETED minute (no lookahead inside the bar).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { loadPmxtJsonl, type PmxtEvent } from "../src/lib/backtest/pmxt.ts";
import {
  applyLevelUpdate, applyTrade, initQueueState, levelSizeAt,
  type CancelMode, type QueueState, type RestingQuote, type TradeEvent,
} from "../src/lib/backtest/queue-fill.ts";
import { fairValueFromMinuteCloses } from "../src/lib/strategies/binary-fair-value.ts";
import { planPairQuotes, settleMerge, type PairMakerParams } from "../src/lib/strategies/binary-pair-maker.ts";
import { makerRebate, type FeeCategory } from "../src/lib/strategies/as-market-maker.ts";

// ── CLI ──
const flag = (n: string, d = ""): string => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const MANIFEST = flag("--manifest");
const CANCEL_MODE = flag("--cancel-mode", "prorata") as CancelMode;
const TICK_MS = Number(flag("--tick-ms", "2000"));
const ACK_MS = Number(flag("--ack-ms", "250"));
const FEE_CAT = flag("--fee-category", "crypto") as FeeCategory;
const OUT = flag("--out");
const VOL_BARS = Number(flag("--vol-bars", "10")); // paper loop uses max(10, min(60, durationMin)) → 10 for 5m

const params: PairMakerParams = {
  quoteSizeShares: Number(flag("--size", "25")),
  mergeMargin: Number(flag("--merge-margin", "0.02")),
  feeBuffer: Number(flag("--fee-buffer", "0.005")),
  maxUnpairedShares: Number(flag("--max-unpaired", "50")),
  tauFloorSec: Number(flag("--tau-floor", "60")),
  safetyEdge: Number(flag("--safety-edge", "0.01")),
};

if (!MANIFEST || !existsSync(MANIFEST)) {
  console.error("need --manifest <path to pmxt_extract_batch manifest.json>");
  process.exit(1);
}
if (!["prorata", "behind", "ahead"].includes(CANCEL_MODE)) {
  console.error(`bad --cancel-mode ${CANCEL_MODE}`);
  process.exit(1);
}

type ManifestWindow = {
  slug: string; family: string; conditionId: string;
  tokenUp: string; tokenDown: string; outcomeUp: number;
  startSec: number; endSec: number;
  fileUp: string; fileDown: string;
  statsUp: { emitted: number; trades: number }; statsDown: { emitted: number; trades: number };
};
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { hours: string[]; windows: ManifestWindow[] };

// ── Binance 1m klines (real, disk-cached; spot = close of last COMPLETED minute) ──
type Kline = { openMs: number; open: number; close: number };
const klineCacheDir = resolve(dirname(MANIFEST));

async function fetchKlines(symbol: string, fromMs: number, toMs: number): Promise<Kline[]> {
  const cachePath = resolve(klineCacheDir, `klines-${symbol}-${fromMs}-${toMs}.json`);
  if (existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, "utf8")) as Kline[];
  const out: Kline[] = [];
  let cursor = fromMs;
  while (cursor < toMs) {
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${cursor}&endTime=${toMs}&limit=1000`;
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`binance klines ${symbol}: HTTP ${r.status}`);
    const rows = (await r.json()) as unknown[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const k of rows as [number, string, string, string, string][]) {
      out.push({ openMs: k[0], open: Number(k[1]), close: Number(k[4]) });
    }
    cursor = out[out.length - 1]!.openMs + 60_000;
    if (rows.length < 1000) break;
  }
  if (!out.length) throw new Error(`binance klines ${symbol}: empty — refusing to invent a fair-value feed`);
  writeFileSync(cachePath, JSON.stringify(out));
  return out;
}

/** closes of all minutes fully completed before `nowMs` (most-recent last) + that spot. */
function spotAndCloses(klines: Kline[], nowMs: number): { spot: number; closes: number[] } | null {
  const closes: number[] = [];
  let spot = NaN;
  for (const k of klines) {
    if (k.openMs + 60_000 <= nowMs) { closes.push(k.close); spot = k.close; }
    else break;
  }
  return Number.isFinite(spot) ? { spot, closes } : null;
}

// ── per-leg resting-quote state under the queue model ──
type Leg = {
  quote: RestingQuote | null;
  q: QueueState | null;        // null until acked
  pendingVisible: number;      // last visible size at our level observed at-or-before ack
  fillsSeen: number;
};

type WindowResult = {
  slug: string; family: string; outcomeUp: number;
  fills: number; sharesBought: number; merged: number;
  pairCompletionPct: number | null;
  lockedMargin: number; rebates: number; makerIncome: number;
  residUp: number; residDown: number; unpaired: number; bucket: string;
  residualCost: number; residualSettle: number; residualPnl: number;
  pnlSettled: number;
  quoteTicks: number; bothSidesTicks: number;
};

function bucketOf(u: number): string {
  return u <= 10 ? "paired(<=10)" : u <= 30 ? "mild(10-30)" : "heavy(>30)";
}

const EPS = 1e-9;

function runWindow(w: ManifestWindow, klines: Kline[]): WindowResult {
  const startMs = w.startSec * 1000;
  const expiryMs = w.endSec * 1000;
  const strikeBar = klines.find((k) => k.openMs === startMs);
  if (!strikeBar) throw new Error(`${w.slug}: no Binance 1m bar at window start — refusing to guess the strike`);
  const strike = strikeBar.open;

  // merge the two token streams chronologically (each file is already time-sorted)
  const up = loadPmxtJsonl(w.fileUp);
  const down = loadPmxtJsonl(w.fileDown);
  type Tagged = { ev: PmxtEvent; leg: "YES" | "NO" };
  const events: Tagged[] = [];
  let i = 0, j = 0;
  while (i < up.length || j < down.length) {
    if (j >= down.length || (i < up.length && up[i]!.ts <= down[j]!.ts)) events.push({ ev: up[i++]!, leg: "YES" });
    else events.push({ ev: down[j++]!, leg: "NO" });
  }

  // book state per leg (top-N ladders from the extract)
  const lastBook: Record<"YES" | "NO", { bids: ReadonlyArray<readonly [number, number]>; asks: ReadonlyArray<readonly [number, number]> } | null> = { YES: null, NO: null };
  const legs: Record<"YES" | "NO", Leg> = {
    YES: { quote: null, q: null, pendingVisible: 0, fillsSeen: 0 },
    NO: { quote: null, q: null, pendingVisible: 0, fillsSeen: 0 },
  };

  let invYes = 0, invNo = 0, costYes = 0, costNo = 0;
  let cash = 0, rebates = 0, mergedSets = 0, lockedMargin = 0, fillsCount = 0, sharesBought = 0;
  let quoteTicks = 0, bothSidesTicks = 0;

  const onFills = (leg: "YES" | "NO", st: Leg): void => {
    const q = st.q;
    if (!q || !st.quote) return;
    for (; st.fillsSeen < q.fills.length; st.fillsSeen++) {
      const f = q.fills[st.fillsSeen]!;
      cash -= f.price * f.qty;
      rebates += makerRebate(f.price, f.qty, FEE_CAT);
      fillsCount++;
      sharesBought += f.qty;
      if (leg === "YES") { invYes += f.qty; costYes += f.price * f.qty; }
      else { invNo += f.qty; costNo += f.price * f.qty; }
    }
    if (q.remaining <= EPS) { st.quote = null; st.q = null; st.fillsSeen = 0; }
  };

  const feedLeg = (leg: "YES" | "NO", ev: PmxtEvent): void => {
    const st = legs[leg];
    if (!st.quote) return;
    const visibleNow = ev.type === "book" ? levelSizeAt(ev.bids, st.quote.price) : null;
    if (ev.ts <= st.quote.postedTs) {
      // pre-ack: track the book we will join behind; prints can't fill us yet
      if (visibleNow !== null) st.pendingVisible = visibleNow;
      return;
    }
    if (!st.q) { st.q = initQueueState(st.quote, st.pendingVisible); st.fillsSeen = 0; }
    if (ev.type === "book") {
      st.q = applyLevelUpdate(st.q, visibleNow!, CANCEL_MODE);
    } else {
      const t: TradeEvent = { ts: ev.ts, kind: "trade", price: ev.price, size: ev.size, aggressor: ev.aggressor };
      st.q = applyTrade(st.q, st.quote, t);
      onFills(leg, st);
    }
  };

  const decide = (nowMs: number): void => {
    const sc = spotAndCloses(klines, nowMs);
    const yes = lastBook.YES, no = lastBook.NO;
    const tauSec = (expiryMs - nowMs) / 1000;
    const fv = sc ? fairValueFromMinuteCloses({ spot: sc.spot, strike, nowMs, expiryMs, minuteCloses: sc.closes, volBars: VOL_BARS }) : null;
    const top = (b: typeof yes) => ({
      bestBid: b && b.bids.length ? b.bids[0]![0] : NaN,
      bestAsk: b && b.asks.length ? b.asks[0]![0] : NaN,
    });
    const plan = fv && yes && no
      ? planPairQuotes({ pFair: fv.pFair, yesBook: top(yes), noBook: top(no), yesShares: invYes, noShares: invNo, tauSec, params })
      : { yesBid: null, noBid: null, mergeable: 0, unpaired: invYes - invNo, note: "no fair/book" };

    quoteTicks++;
    if (plan.yesBid && plan.noBid) bothSidesTicks++;

    for (const leg of ["YES", "NO"] as const) {
      const want = leg === "YES" ? plan.yesBid : plan.noBid;
      const st = legs[leg];
      if (!want) { st.quote = null; st.q = null; st.fillsSeen = 0; continue; }
      if (st.quote && Math.abs(st.quote.price - want.px) < 1e-9) continue; // same px → KEEP queue position
      // cancel + repost at the new price: back of the visible queue, after ACK latency
      const book = lastBook[leg];
      st.quote = { side: "bid", price: want.px, size: want.sz, postedTs: nowMs + ACK_MS };
      st.q = null;
      st.fillsSeen = 0;
      st.pendingVisible = book ? levelSizeAt(book.bids, want.px) : 0;
    }

    // merge complete sets at $1 (paper analogue of the on-chain merge)
    const m = settleMerge({ yesShares: invYes, noShares: invNo, yesCost: costYes, noCost: costNo });
    if (m.merged > 0) {
      cash += m.cashIn;
      lockedMargin += m.lockedMargin;
      mergedSets += m.merged;
      ({ yesShares: invYes, noShares: invNo, yesCost: costYes, noCost: costNo } = m.next);
    }
  };

  // ── event loop with decision ticks every TICK_MS, quoting only inside the window ──
  let nextDecision = startMs;
  for (const { ev, leg } of events) {
    if (ev.ts >= expiryMs) break; // book collapse / settle tail — nothing fills after expiry
    while (nextDecision <= ev.ts && nextDecision < expiryMs) { decide(nextDecision); nextDecision += TICK_MS; }
    if (ev.type === "book") lastBook[leg] = { bids: ev.bids, asks: ev.asks };
    feedLeg(leg, ev);
  }
  // final merge pass for fills after the last decision tick
  const m = settleMerge({ yesShares: invYes, noShares: invNo, yesCost: costYes, noCost: costNo });
  if (m.merged > 0) {
    cash += m.cashIn; lockedMargin += m.lockedMargin; mergedSets += m.merged;
    ({ yesShares: invYes, noShares: invNo, yesCost: costYes, noCost: costNo } = m.next);
  }

  // ── residual marked to the REAL settle ──
  const residualCost = costYes + costNo;
  const residualSettle = invYes * w.outcomeUp + invNo * (1 - w.outcomeUp);
  const residualPnl = residualSettle - residualCost;
  const pnlSettled = lockedMargin + rebates + residualPnl;
  const check = cash + residualSettle + rebates;
  if (Math.abs(check - pnlSettled) > 1e-6) throw new Error(`${w.slug}: PnL decomposition mismatch ${check} vs ${pnlSettled}`);
  const unpaired = Math.abs(invYes - invNo);

  return {
    slug: w.slug, family: w.family, outcomeUp: w.outcomeUp,
    fills: fillsCount, sharesBought, merged: mergedSets,
    pairCompletionPct: sharesBought > 0 ? +(100 * (2 * mergedSets) / sharesBought).toFixed(1) : null,
    lockedMargin: +lockedMargin.toFixed(4), rebates: +rebates.toFixed(4),
    makerIncome: +(lockedMargin + rebates).toFixed(4),
    residUp: invYes, residDown: invNo, unpaired, bucket: bucketOf(unpaired),
    residualCost: +residualCost.toFixed(4), residualSettle: +residualSettle.toFixed(4),
    residualPnl: +residualPnl.toFixed(4), pnlSettled: +pnlSettled.toFixed(4),
    quoteTicks, bothSidesTicks,
  };
}

// ── main ──
const famSymbol = (family: string): string => `${family.split("-")[0]!.toUpperCase()}USDT`;
const windows = manifest.windows.filter((w) => w.statsUp.emitted > 0 && w.statsDown.emitted > 0);
const skippedEmpty = manifest.windows.length - windows.length;
const minStart = Math.min(...windows.map((w) => w.startSec)) * 1000;
const maxEnd = Math.max(...windows.map((w) => w.endSec)) * 1000;

console.log(`pair-maker-backtest (G3) — ${windows.length} windows (${skippedEmpty} skipped: empty leg) | cancel-mode ${CANCEL_MODE} | tick ${TICK_MS}ms ack ${ACK_MS}ms`);
console.log(`params: size ${params.quoteSizeShares} margin ${params.mergeMargin} feeBuf ${params.feeBuffer} maxUnpaired ${params.maxUnpairedShares} tauFloor ${params.tauFloorSec}s safetyEdge ${params.safetyEdge}\n`);

const symbols = [...new Set(windows.map((w) => famSymbol(w.family)))];
const klinesBySym: Record<string, Kline[]> = {};
for (const s of symbols) {
  klinesBySym[s] = await fetchKlines(s, minStart - 40 * 60_000, maxEnd + 60_000);
  console.log(`  klines ${s}: ${klinesBySym[s]!.length} bars`);
}

const results: WindowResult[] = [];
for (const w of windows) {
  const r = runWindow(w, klinesBySym[famSymbol(w.family)]!);
  results.push(r);
  console.log(
    `  ${r.slug}  fills ${String(r.fills).padStart(2)} (${String(r.sharesBought).padStart(4)} sh)  merged ${String(r.merged).padStart(3)}` +
    `  pair% ${r.pairCompletionPct === null ? "  —" : String(r.pairCompletionPct).padStart(5)}  maker $${r.makerIncome.toFixed(2).padStart(6)}` +
    `  resid $${r.residualPnl.toFixed(2).padStart(7)}  net $${r.pnlSettled.toFixed(2).padStart(7)}  [${r.bucket}]`,
  );
}

// ── aggregate — same decomposition as TradingBot2 merge_report ──
const settled = results;
const filledShares = settled.reduce((s, r) => s + r.sharesBought, 0);
const mergedShares = settled.reduce((s, r) => s + r.merged, 0);
const completion = filledShares > 0 ? (2 * mergedShares) / filledShares : 0;
const makerIncome = settled.reduce((s, r) => s + r.makerIncome, 0);
const residual = settled.reduce((s, r) => s + r.residualPnl, 0);
const total = settled.reduce((s, r) => s + r.pnlSettled, 0);
const residRows = settled.filter((r) => r.residUp > 0 || r.residDown > 0);
const residWins = residRows.filter((r) => r.residualPnl > 0).length;

const byBucket: Record<string, { n: number; net: number; maker: number; residual: number }> = {};
for (const r of settled) {
  const d = (byBucket[r.bucket] ??= { n: 0, net: 0, maker: 0, residual: 0 });
  d.n++; d.net += r.pnlSettled; d.maker += r.makerIncome; d.residual += r.residualPnl;
}
const byKind: Record<string, { n: number; fills: number; merged: number; pnl: number; maker: number }> = {};
for (const r of settled) {
  const d = (byKind[r.family] ??= { n: 0, fills: 0, merged: 0, pnl: 0, maker: 0 });
  d.n++; d.fills += r.fills; d.merged += r.merged; d.pnl += r.pnlSettled; d.maker += r.makerIncome;
}

const verdict =
  makerIncome > 0 && Math.abs(residual) <= makerIncome
    ? "MAKER-DRIVEN: merge margin dominates; residual is noise"
    : total > 0
      ? "RESIDUAL-DRIVEN: profit exists but rides the unpaired coin-flips — NOT proven maker edge"
      : "NEGATIVE: adverse selection on unpaired inventory exceeds merge margin";

const summary = {
  manifest: MANIFEST, hours: manifest.hours, cancelMode: CANCEL_MODE,
  tickMs: TICK_MS, ackMs: ACK_MS, params,
  windows: settled.length, skippedEmptyLeg: skippedEmpty,
  windowsWithFills: settled.filter((r) => r.fills > 0).length,
  filledShares: +filledShares.toFixed(1), mergedShares,
  pairCompletion: +completion.toFixed(4),
  makerIncome: +makerIncome.toFixed(4), residualSettlePnl: +residual.toFixed(4),
  totalPnl: +total.toFixed(4),
  residualWindows: residRows.length, residualWins: residWins,
  byBucket: Object.fromEntries(Object.entries(byBucket).map(([k, d]) => [k, { n: d.n, net: +d.net.toFixed(2), maker: +d.maker.toFixed(2), residual: +d.residual.toFixed(2) }])),
  byKind: Object.fromEntries(Object.entries(byKind).map(([k, d]) => [k, { ...d, pnl: +d.pnl.toFixed(2), maker: +d.maker.toFixed(2) }])),
  verdict,
};

console.log(`\n── G3 aggregate (${CANCEL_MODE}) ──`);
console.log(`  windows ${summary.windows} (fills in ${summary.windowsWithFills}) · filled shares ${summary.filledShares} · merged sets ${mergedShares} · pair completion ${(completion * 100).toFixed(1)}%`);
console.log(`  maker income $${makerIncome.toFixed(2)} (locked margin + rebates) · residual settle $${residual.toFixed(2)} over ${residRows.length} windows (${residWins} wins)`);
console.log(`  TOTAL $${total.toFixed(2)}  →  ${verdict}`);
console.log(`  by bucket: ${JSON.stringify(summary.byBucket)}`);
console.log(`  by kind:   ${JSON.stringify(summary.byKind)}`);

if (OUT) {
  mkdirSync(dirname(resolve(OUT)), { recursive: true });
  writeFileSync(resolve(OUT), JSON.stringify({ summary, results }, null, 1));
  console.log(`\nresults → ${resolve(OUT)}`);
}
