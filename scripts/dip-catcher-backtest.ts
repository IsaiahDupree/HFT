/**
 * dip-catcher-backtest — the DECISIVE honest-fill test of the "early-dip resting
 * bid" idea, reusing the G3 queue-fill harness on the PMXT extracts already on
 * disk (docs/research/G3-QUEUE-FILL-BACKTEST-2026-06-12.md).
 *
 * THE IDEA. Instead of the pair-maker's fair-anchored quotes, rest a FLAT cheap
 * bid (X ∈ {0.02,0.03,0.05}) on BOTH the YES (Up) and NO (Down) token of each
 * 5-min crypto up/down window for the WHOLE window. The optimistic mid-touch
 * backtest claimed a side often dips ≤3¢ early/mid-window (spot moves against
 * it) then REVERSES and wins ~8% (vs the ~3% the 3¢ price implies, z≈8.4) — far
 * better than the late penny-sniper (enters ~60s pre-close, 0.83% win) because
 * the EARLY dip has minutes to reverse.
 *
 * THE DECISIVE QUESTION. The optimistic backtest assumed "mid touched 3¢ ⇒
 * filled at 3¢." That is exactly the fill optimism G3 was built to kill. Here a
 * flat Xc bid fills ONLY when the real trade tape SELLS through it (queue-fill.ts
 * back-of-queue: a SELL print at/through our price consumes the queue ahead,
 * then us). If nobody dumps the losing side through Xc, we never fill — and the
 * "edge" is a mirage. The win rate on HONEST fills vs the optimistic 8% is the
 * verdict.
 *
 * PnL per filled lot: cost = X·qty; settle = qty if that token resolved YES else
 * 0. Win = the bought side resolved 1.0. Held to the real Gamma 0/1 settle
 * (manifest.outcomeUp). No fees on a maker BUY here (rebates would only help;
 * left out so the number is conservative). No merging — this is a directional
 * dip bet on EACH side independently, not the pair-maker.
 *
 *   npx tsx scripts/dip-catcher-backtest.ts -- \
 *     --manifest "/Volumes/My Passport/hft-data/pmxt/extracts/2026-06-10/manifest.json" \
 *     --prices 0.02,0.03,0.05 [--size 25] [--cancel-mode prorata] [--ack-ms 250]
 *     [--out dip-results.json]
 *
 * Real data only: real PMXT books+prints, real Gamma settles. If a token's
 * extract carries no trade prints, queue-fill simply never fills it (reported as
 * 0 fills, never invented).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { loadPmxtJsonl, toQueueEvents } from "../src/lib/backtest/pmxt.ts";
import { simulateQueueFills, type CancelMode, type RestingQuote } from "../src/lib/backtest/queue-fill.ts";
import { proofCouncil, wilsonLowerBound, renderProofCouncil, type StrategyEvidence } from "../src/lib/backtest/proof-council.ts";

const flag = (n: string, d = ""): string => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const MANIFEST = flag("--manifest");
const PRICES = flag("--prices", "0.02,0.03,0.05").split(",").map((s) => Number(s.trim())).filter((x) => x > 0);
const SIZE = Number(flag("--size", "25"));
const CANCEL_MODE = flag("--cancel-mode", "prorata") as CancelMode;
const ACK_MS = Number(flag("--ack-ms", "250"));
const OUT = flag("--out");

if (!MANIFEST || !existsSync(MANIFEST)) {
  console.error("need --manifest <path to pmxt_extract_batch manifest.json>");
  process.exit(1);
}

type ManifestWindow = {
  slug: string; family: string; outcomeUp: number;
  startSec: number; endSec: number; fileUp: string; fileDown: string;
  statsUp: { emitted: number; trades: number }; statsDown: { emitted: number; trades: number };
};
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { hours: string[]; windows: ManifestWindow[] };

// only windows with a real two-sided stream on BOTH legs (same gate as G3)
const windows = manifest.windows.filter((w) => w.statsUp.emitted > 0 && w.statsDown.emitted > 0);
const skipped = manifest.windows.length - windows.length;

// ── one side of one window: rest a flat Xc bid for the whole window, honest fills ──
type SideFill = {
  slug: string; family: string; leg: "YES" | "NO"; price: number;
  filledQty: number; firstFillTs?: number; won: boolean;
  cost: number; settle: number; pnl: number;
  tradesAvailable: number; // prints on this token's tape (0 ⇒ queue-fill can never fill)
};

function runSide(w: ManifestWindow, leg: "YES" | "NO", price: number): SideFill {
  const file = leg === "YES" ? w.fileUp : w.fileDown;
  const events = loadPmxtJsonl(file);
  const startMs = w.startSec * 1000;
  const expiryMs = w.endSec * 1000;
  // resting flat Xc BUY bid, acked just after the window opens, live the whole window
  const quote: RestingQuote = { side: "bid", price, size: SIZE, postedTs: startMs + ACK_MS };
  // project the stream onto THIS quote (visible size at our price + trades that can hit us)
  // and clip to the window (no fills after expiry — the token has resolved).
  const qEvents = toQueueEvents(events, quote).filter((e) => e.ts < expiryMs);
  const tradesAvailable = events.filter((e) => e.type === "trade").length;
  const r = simulateQueueFills(quote, qEvents, { cancelMode: CANCEL_MODE });
  const filledQty = r.filledQty;
  // outcomeUp = 1.0 if Up(YES) resolved YES. The bought side WINS iff it resolved 1.0.
  const tokenSettle = leg === "YES" ? w.outcomeUp : 1 - w.outcomeUp; // 1.0 win / 0.0 loss
  const won = tokenSettle > 0.5;
  const cost = filledQty * price;
  const settle = filledQty * tokenSettle;
  return {
    slug: w.slug, family: w.family, leg, price,
    filledQty, firstFillTs: r.firstFillTs, won,
    cost: +cost.toFixed(6), settle: +settle.toFixed(6), pnl: +(settle - cost).toFixed(6),
    tradesAvailable,
  };
}

// ── walk-forward split: first half of the window-starts = IS, second half = OOS ──
const sortedStarts = [...new Set(windows.map((w) => w.startSec))].sort((a, b) => a - b);
const splitStart = sortedStarts[Math.floor(sortedStarts.length / 2)]!;
const isOos = (w: ManifestWindow): "IS" | "OOS" => (w.startSec < splitStart ? "IS" : "OOS");

type PriceReport = {
  price: number;
  lots: number; filledShares: number; winLots: number; winRate: number; wilsonLow: number;
  netPnl: number; pnlPerLot: number; pnlPerDollar: number;
  staked: number;
  // concentration: share of POSITIVE pnl from the top-k winning lots
  topWinShare: number; nWinners: number;
  // walk-forward
  isPnl: number; oosPnl: number; isWinRate: number; oosWinRate: number; isLots: number; oosLots: number;
  // tape availability (the kill-switch check)
  sidesWithNoTape: number; sidesTotal: number;
  byFamily: Record<string, { lots: number; winLots: number; netPnl: number }>;
};

function reportForPrice(price: number): { rep: PriceReport; fills: SideFill[] } {
  const fills: SideFill[] = [];
  for (const w of windows) {
    fills.push(runSide(w, "YES", price));
    fills.push(runSide(w, "NO", price));
  }
  const lotsArr = fills.filter((f) => f.filledQty > 1e-9);
  const lots = lotsArr.length;
  const filledShares = lotsArr.reduce((s, f) => s + f.filledQty, 0);
  const winLots = lotsArr.filter((f) => f.won).length;
  const netPnl = lotsArr.reduce((s, f) => s + f.pnl, 0);
  const staked = lotsArr.reduce((s, f) => s + f.cost, 0);
  const winRate = lots > 0 ? winLots / lots : 0;

  // concentration: of the positive PnL, what share comes from the top winners?
  const winners = lotsArr.filter((f) => f.pnl > 0).sort((a, b) => b.pnl - a.pnl);
  const posTotal = winners.reduce((s, f) => s + f.pnl, 0);
  const topK = Math.max(1, Math.round(winners.length * 0.1)); // top 10% of winners
  const topWinShare = posTotal > 0 ? winners.slice(0, topK).reduce((s, f) => s + f.pnl, 0) / posTotal : 0;

  const split = (arm: "IS" | "OOS") => {
    const byWin = new Map(windows.map((w) => [`${w.slug}`, isOos(w)]));
    const arr = lotsArr.filter((f) => byWin.get(f.slug) === arm);
    const wl = arr.filter((f) => f.won).length;
    return { pnl: arr.reduce((s, f) => s + f.pnl, 0), n: arr.length, winRate: arr.length ? wl / arr.length : 0 };
  };
  const is = split("IS"), oos = split("OOS");

  const byFamily: Record<string, { lots: number; winLots: number; netPnl: number }> = {};
  for (const f of lotsArr) {
    const d = (byFamily[f.family] ??= { lots: 0, winLots: 0, netPnl: 0 });
    d.lots++; if (f.won) d.winLots++; d.netPnl += f.pnl;
  }
  for (const k of Object.keys(byFamily)) byFamily[k]!.netPnl = +byFamily[k]!.netPnl.toFixed(2);

  const sidesWithNoTape = fills.filter((f) => f.tradesAvailable === 0).length;

  return {
    rep: {
      price,
      lots, filledShares: +filledShares.toFixed(1), winLots, winRate: +winRate.toFixed(4),
      wilsonLow: +wilsonLowerBound(winLots, lots).toFixed(4),
      netPnl: +netPnl.toFixed(2), pnlPerLot: lots ? +(netPnl / lots).toFixed(4) : 0,
      pnlPerDollar: staked > 0 ? +(netPnl / staked).toFixed(4) : 0, staked: +staked.toFixed(2),
      topWinShare: +topWinShare.toFixed(4), nWinners: winners.length,
      isPnl: +is.pnl.toFixed(2), oosPnl: +oos.pnl.toFixed(2),
      isWinRate: +is.winRate.toFixed(4), oosWinRate: +oos.winRate.toFixed(4), isLots: is.n, oosLots: oos.n,
      sidesWithNoTape, sidesTotal: fills.length,
      byFamily,
    },
    fills,
  };
}

console.log(`dip-catcher-backtest (honest queue-fill) — ${windows.length} windows (${skipped} empty-leg skipped) | prices ${PRICES.map((p) => (p * 100) + "c").join(",")} | size ${SIZE} | cancel ${CANCEL_MODE} ack ${ACK_MS}ms`);
console.log(`walk-forward: ${windows.filter((w) => isOos(w) === "IS").length} IS / ${windows.filter((w) => isOos(w) === "OOS").length} OOS windows (split at start ${splitStart})\n`);

const reports: PriceReport[] = [];
const allFills: Record<string, SideFill[]> = {};
for (const price of PRICES) {
  const { rep, fills } = reportForPrice(price);
  reports.push(rep);
  allFills[String(price)] = fills;
  const impliedWin = price * 100; // the price IS the implied win-prob in cents
  console.log(`══ flat ${(price * 100).toFixed(0)}c bid both sides ══`);
  console.log(`  fills(lots) ${rep.lots} of ${rep.sidesTotal} sides · filled shares ${rep.filledShares} · sides with NO tape ${rep.sidesWithNoTape}`);
  console.log(`  HONEST win rate ${(rep.winRate * 100).toFixed(2)}% (Wilson low ${(rep.wilsonLow * 100).toFixed(2)}%) vs ${impliedWin.toFixed(0)}% implied by ${(price * 100).toFixed(0)}c · vs optimistic ~8%`);
  console.log(`  net PnL $${rep.netPnl.toFixed(2)} · $/lot ${rep.pnlPerLot.toFixed(4)} · $/staked ${(rep.pnlPerDollar * 100).toFixed(1)}% · staked $${rep.staked.toFixed(2)}`);
  console.log(`  concentration: top-10% winners = ${(rep.topWinShare * 100).toFixed(0)}% of positive PnL (${rep.nWinners} winners)`);
  console.log(`  walk-forward: IS $${rep.isPnl.toFixed(2)} (${(rep.isWinRate * 100).toFixed(1)}% / ${rep.isLots} lots) · OOS $${rep.oosPnl.toFixed(2)} (${(rep.oosWinRate * 100).toFixed(1)}% / ${rep.oosLots} lots)`);
  console.log(`  by family: ${JSON.stringify(rep.byFamily)}\n`);
}

// ── proofCouncil verdict on the BEST-PnL price (judged on its own evidence) ──
const best = [...reports].sort((a, b) => b.netPnl - a.netPnl)[0]!;
// regimes covered ≈ 1 (one UTC day, one vol regime); the btc/eth split ≈ 2 symbol-days
const regimes = 1;
// PBO proxy: did the IS-best price hold its sign OOS? (single split, coarse)
const isBestPrice = [...reports].sort((a, b) => b.isPnl - a.isPnl)[0]!;
const heldOos = isBestPrice.oosPnl > 0 ? 1 : 0;
const ev: StrategyEvidence = {
  label: `dip-catcher flat ${(best.price * 100).toFixed(0)}c both-sides (honest queue-fill)`,
  objective: "edge",
  bars: best.lots, sampleUnit: "filled lots", feeBps: 0,
  cumPnlPct: best.staked > 0 ? (best.netPnl / best.staked) * 100 : 0,
  winRate: best.winRate, nTrades: best.lots,
  // walk-forward: OOS PnL sign as the OOS-Sharpe proxy (positive ⇒ >0, negative ⇒ ≤0)
  oosSharpeAnn: best.oosLots > 0 ? (best.oosPnl > 0 ? 0.5 : -0.5) : undefined,
  variants: PRICES.length, oosHold: heldOos,
  regimesCovered: regimes,
  maxDdPct: undefined,
};
const verdict = proofCouncil(ev);
console.log("─".repeat(70));
console.log(renderProofCouncil(verdict));
console.log("─".repeat(70));

if (OUT) {
  mkdirSync(dirname(resolve(OUT)), { recursive: true });
  writeFileSync(resolve(OUT), JSON.stringify({ params: { prices: PRICES, size: SIZE, cancelMode: CANCEL_MODE, ackMs: ACK_MS }, splitStart, reports, verdict, evidence: ev }, null, 1));
  console.log(`\nresults → ${resolve(OUT)}`);
}
