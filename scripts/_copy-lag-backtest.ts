/**
 * Lag-aware copy-backtest for the 2026-06-10 sweep candidates (scratch, read-only).
 *
 * Question: these are LIVE-GAME sports takers whose edge is entry timing. How much
 * edge survives a realistic copy delay at EXECUTABLE prices?
 *
 *   npx tsx scripts/_copy-lag-backtest.ts --wallet 0x... --handle name [--max-age-days N] [--fine-markets N]
 *
 * Method (no lookahead anywhere):
 *   - Leader fills from data-api /trades?user (full pagination, offset≤3000).
 *   - Slugged orders collapsed into logical bets via collapseSluggedTrades (1h window).
 *   - Copy entry at t_leader + delay, priced from CLOB prices-history 1-minute bars
 *     (startTs/endTs + fidelity=1 — the finest the historical API serves), using the
 *     FIRST bar at-or-after t+delay. Spread-crossing cost: copier is a taker, pays
 *     mid + SPREAD_COST on entry (and mid − SPREAD_COST on mirrored exits).
 *   - Delays 60s/300s measured on the full bet set. 5s/30s measured ONLY where the
 *     data-api market tape (offset hard-cap 3000 → most recent ~3.5k prints/market)
 *     reaches back to the leader's entry — reported with coverage, never fabricated.
 *   - Settlement: hold to resolution (Gamma winning index), mirroring the leaders'
 *     observed hold-to-resolution behavior; if the leader exits early via SELL
 *     (≥50% of the buy), the copier mirrors the exit at t_sell + delay.
 *   - Leader benchmark: the leader's own vwap fill settled identically on the SAME bets.
 *   - Skeptic controls: shuffle (random entry times in the same market window, same
 *     token, K draws/bet) and beta (buy the at-entry favorite at the same delayed times).
 *
 * Fees: Polymarket taker fee = 0 on these markets today (repo convention); gas is
 * relayer-subsidized. Cost model is therefore spread-crossing only.
 *
 * Output: JSON to data/copy-lag-2026-06-11-<handle>.json + console summary.
 */
import "./_env.ts";
import * as fs from "node:fs";
import {
  collapseSluggedTrades,
  parseGammaResolvedMarket,
  type ResolvedMarket,
} from "../src/lib/wallets/copy-backtest.ts";
import type { RawTrade } from "../src/lib/wallets/fingerprint.ts";

const DATA = "https://data-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const GAMMA = "https://gamma-api.polymarket.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) hft-research/1.0";

const SPREAD_COST = 0.01;      // one full tick crossed per leg (conservative for NBA books)
const COARSE_DELAYS = [60, 300];
const FINE_DELAYS = [5, 30];
const SHUFFLE_DRAWS = 20;
const DEDUP_WINDOW_SEC = 3600;
const BAR_TOLERANCE_SEC = 180; // max wait past t+delay for the next 1-min bar
const MAX_ENTRY = 0.985;       // entries above this after spread are uncopyable

const argv = process.argv.slice(2);
function flag(name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] ?? null : null;
}
const WALLET = (flag("wallet") ?? "").toLowerCase();
const HANDLE = flag("handle") ?? WALLET.slice(0, 10);
const MAX_AGE_DAYS = Number(flag("max-age-days") ?? "365");
const FINE_MARKETS = Number(flag("fine-markets") ?? "25");
const MIN_USD = Number(flag("min-usd") ?? "0"); // copy only leader bets of at least this size
if (!WALLET) { console.error("--wallet required"); process.exit(1); }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function getJson<T>(url: string, tries = 3): Promise<T> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`${r.status}`);
      return (await r.json()) as T;
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(500 * (i + 1));
    }
  }
  throw new Error("unreachable");
}

type Bar = { t: number; p: number };

// ---------------------------------------------------------------------------
// 1. Leader fills
// ---------------------------------------------------------------------------
async function fetchUserTrades(addr: string): Promise<RawTrade[]> {
  const out: RawTrade[] = [];
  for (let off = 0; off <= 3000; off += 500) {
    const page = await getJson<any[]>(`${DATA}/trades?user=${addr}&limit=500&offset=${off}`);
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    if (page.length < 500) break;
    await sleep(150);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Price bars (1-minute, windowed). Cached per token.
// ---------------------------------------------------------------------------
const barCache = new Map<string, Bar[]>();
async function fetchBars(tokenId: string, startTs: number, endTs: number): Promise<Bar[]> {
  const key = `${tokenId}|${startTs}|${endTs}`;
  if (barCache.has(key)) return barCache.get(key)!;
  let bars: Bar[] = [];
  try {
    const r = await getJson<{ history: Bar[] }>(
      `${CLOB}/prices-history?market=${tokenId}&startTs=${startTs}&endTs=${endTs}&fidelity=1`,
    );
    bars = Array.isArray(r?.history) ? r.history : [];
  } catch { bars = []; }
  barCache.set(key, bars);
  await sleep(120);
  return bars;
}
function barAtOrAfter(bars: Bar[], t: number): Bar | null {
  // binary search first bar with bar.t >= t
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid].t >= t) { ans = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return ans >= 0 ? bars[ans] : null;
}

// ---------------------------------------------------------------------------
// Bet model
// ---------------------------------------------------------------------------
type Bet = {
  conditionId: string;
  tokenId: string;
  ts: number;            // leader's (cluster-start) entry time
  leaderFill: number;    // leader's vwap fill price on this cluster
  usd: number;
  inverse: boolean;      // leader SOLD with no prior buy → bet against the token
  exitTs: number | null; // leader's early-exit time (first SELL cluster ≥50% of buys)
  exitFill: number | null;
  slug: string;
  title: string;
};

function buildBets(clusters: RawTrade[]): { bets: Bet[]; exits: number } {
  const byToken = new Map<string, RawTrade[]>();
  for (const c of clusters) {
    const k = `${c.conditionId}|${c.asset}`;
    if (!byToken.has(k)) byToken.set(k, []);
    byToken.get(k)!.push(c);
  }
  const bets: Bet[] = [];
  let exits = 0;
  for (const [, list] of byToken) {
    list.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
    const buys = list.filter((c) => String(c.side).toUpperCase() === "BUY");
    const sells = list.filter((c) => String(c.side).toUpperCase() === "SELL");
    const buyUsd = buys.reduce((s, c) => s + Number(c.usdcSize ?? 0), 0);
    const sellUsd = sells.reduce((s, c) => s + Number(c.usdcSize ?? 0), 0);
    if (buys.length > 0) {
      // early-exit if leader sold ≥50% of what it bought on this token
      const exit = sellUsd >= buyUsd * 0.5 && sells.length > 0 ? sells[0] : null;
      if (exit) exits++;
      for (const b of buys) {
        const ts = Number(b.timestamp);
        const exitTs = exit && Number(exit.timestamp) > ts ? Number(exit.timestamp) : null;
        bets.push({
          conditionId: String(b.conditionId), tokenId: String(b.asset), ts,
          leaderFill: Number(b.price), usd: Number(b.usdcSize ?? 0), inverse: false,
          exitTs, exitFill: exitTs ? Number(exit!.price) : null,
          slug: String(b.slug ?? ""), title: String(b.title ?? ""),
        });
      }
    } else if (sells.length > 0) {
      // standalone short → bet against the token (buy complement at 1-p)
      for (const s of sells) {
        bets.push({
          conditionId: String(s.conditionId), tokenId: String(s.asset), ts: Number(s.timestamp),
          leaderFill: Number(s.price), usd: Number(s.usdcSize ?? 0), inverse: true,
          exitTs: null, exitFill: null, slug: String(s.slug ?? ""), title: String(s.title ?? ""),
        });
      }
    }
  }
  bets.sort((a, b) => a.ts - b.ts);
  return { bets, exits };
}

// settle $1 bought at `entry` on a token that `won` → pnl per $1
const settle = (entry: number, won: boolean) => (won ? (1 - entry) / entry : -1);

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - MAX_AGE_DAYS * 86400;

  console.log(`\n=== ${HANDLE} (${WALLET}) — lag-aware copy-backtest ===`);
  const raw = await fetchUserTrades(WALLET);
  const trades = raw
    .filter((t) => Number(t.timestamp) >= cutoff)
    .map((t) => ({ ...t, usdcSize: Number(t.usdcSize ?? 0) || Number(t.size ?? 0) * Number(t.price ?? 0) }));
  console.log(`raw trades: ${raw.length} (${trades.length} within ${MAX_AGE_DAYS}d)`);

  const clusters = collapseSluggedTrades(trades as RawTrade[], DEDUP_WINDOW_SEC);
  const built = buildBets(clusters);
  const bets = MIN_USD > 0 ? built.bets.filter((b) => b.usd >= MIN_USD) : built.bets;
  console.log(`logical bets after slug-dedup: ${built.bets.length} (leader early-exits on ${built.exits} tokens)` +
    (MIN_USD > 0 ? ` → ${bets.length} after min-usd=$${MIN_USD}` : ""));

  // --- resolutions ---
  const conditionIds = Array.from(new Set(bets.map((b) => b.conditionId)));
  const resolved = new Map<string, ResolvedMarket>();
  for (let i = 0; i < conditionIds.length; i += 25) {
    const slice = conditionIds.slice(i, i + 25);
    try {
      // NOTE: Gamma no longer honors comma-joined condition_ids (returns []) —
      // repeated condition_ids= params are required (poly.marketsByCondition is stale).
      const ms = await getJson<any[]>(`${GAMMA}/markets?${slice.map((c) => `condition_ids=${c}`).join("&")}&closed=true`);
      for (const m of ms) {
        const p = parseGammaResolvedMarket(m);
        if (p) resolved.set(p.conditionId, p);
      }
    } catch (e) { console.warn(`gamma chunk ${i} failed: ${(e as Error).message}`); }
    await sleep(150);
  }
  console.log(`resolved markets: ${resolved.size}/${conditionIds.length}`);

  // --- bars per token, window spanning that token's bets ---
  const tokenWindows = new Map<string, { min: number; max: number }>();
  for (const b of bets) {
    if (!resolved.has(b.conditionId)) continue;
    const w = tokenWindows.get(b.tokenId) ?? { min: b.ts, max: b.ts };
    w.min = Math.min(w.min, b.ts);
    w.max = Math.max(w.max, b.exitTs ?? b.ts);
    tokenWindows.set(b.tokenId, w);
  }
  console.log(`fetching 1-min bars for ${tokenWindows.size} tokens…`);
  const barsByToken = new Map<string, Bar[]>();
  let done = 0;
  for (const [tok, w] of tokenWindows) {
    const bars = await fetchBars(tok, w.min - 4 * 3600, w.max + 6 * 3600);
    if (bars.length >= 2) barsByToken.set(tok, bars);
    if (++done % 50 === 0) console.log(`  …${done}/${tokenWindows.size}`);
  }
  console.log(`tokens with usable bars: ${barsByToken.size}/${tokenWindows.size}`);

  // --- coarse delays (60s/300s) over the full bet set ---
  type DelayAgg = {
    delay: number; n: number; wins: number; pnl: number; cap: number;
    slipSum: number; driftSum: number; achievedSum: number;
    skUnresolved: number; skNoBars: number; skNoBar: number; skTooExpensive: number;
    leaderPnl: number; leaderWins: number;
  };
  const aggs: DelayAgg[] = COARSE_DELAYS.map((d) => ({
    delay: d, n: 0, wins: 0, pnl: 0, cap: 0, slipSum: 0, driftSum: 0, achievedSum: 0,
    skUnresolved: 0, skNoBars: 0, skNoBar: 0, skTooExpensive: 0, leaderPnl: 0, leaderWins: 0,
  }));
  // for controls: bets scored at d=60 with their entry context
  const scored60: Array<{ bet: Bet; mkt: ResolvedMarket; bars: Bar[]; entryMid: number; won: boolean }> = [];

  for (const bet of bets) {
    const mkt = resolved.get(bet.conditionId);
    for (const agg of aggs) {
      if (!mkt) { agg.skUnresolved++; continue; }
      const idx = mkt.clobTokenIds.indexOf(bet.tokenId);
      if (idx < 0) { agg.skUnresolved++; continue; }
      const bars = barsByToken.get(bet.tokenId);
      if (!bars) { agg.skNoBars++; continue; }
      const entryBar = barAtOrAfter(bars, bet.ts + agg.delay);
      if (!entryBar || entryBar.t - (bet.ts + agg.delay) > BAR_TOLERANCE_SEC) { agg.skNoBar++; continue; }
      const mid = bet.inverse ? 1 - entryBar.p : entryBar.p;
      const entry = mid + SPREAD_COST;
      if (entry >= MAX_ENTRY || mid <= 0.005) { agg.skTooExpensive++; continue; }

      const tokenWon = mkt.winningIndex === idx;
      const won = bet.inverse ? !tokenWon : tokenWon;
      let pnlPerDollar: number;
      let exited = false;
      if (bet.exitTs && !bet.inverse) {
        const exitBar = barAtOrAfter(bars, bet.exitTs + agg.delay);
        if (exitBar && exitBar.t - (bet.exitTs + agg.delay) <= BAR_TOLERANCE_SEC) {
          const exitPx = Math.max(exitBar.p - SPREAD_COST, 0.001);
          pnlPerDollar = (exitPx - entry) / entry;
          exited = true;
        } else pnlPerDollar = settle(entry, won);
      } else pnlPerDollar = settle(entry, won);

      // leader benchmark on the same bet
      const leaderEntry = bet.inverse ? 1 - bet.leaderFill : bet.leaderFill;
      let leaderPnl: number;
      if (bet.exitTs && bet.exitFill != null && !bet.inverse) {
        leaderPnl = (bet.exitFill - bet.leaderFill) / bet.leaderFill;
      } else leaderPnl = settle(leaderEntry, won);

      agg.n++; agg.cap += 1;
      if ((exited && pnlPerDollar > 0) || (!exited && won)) agg.wins++;
      agg.pnl += pnlPerDollar;
      agg.slipSum += entry - leaderEntry;        // executable copy entry vs leader fill
      agg.driftSum += mid - leaderEntry;         // pure market drift (pre-spread)
      agg.achievedSum += entryBar.t - bet.ts;
      agg.leaderPnl += leaderPnl;
      if (leaderPnl > 0) agg.leaderWins++;

      if (agg.delay === 60) scored60.push({ bet, mkt, bars, entryMid: mid, won: tokenWon });
    }
  }

  // --- skeptic control 1: shuffle (random entries, same token/market window) ---
  let shufPnl = 0, shufN = 0, shufWins = 0;
  for (const s of scored60) {
    const idx = s.mkt.clobTokenIds.indexOf(s.bet.tokenId);
    const tokenWon = s.mkt.winningIndex === idx;
    const tEnd = Math.min(s.bars[s.bars.length - 1].t, s.mkt.closedTime ?? Infinity);
    const tStart = s.bars[0].t;
    if (tEnd <= tStart) continue;
    for (let k = 0; k < SHUFFLE_DRAWS; k++) {
      let bar: Bar | null = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        const t = tStart + Math.random() * (tEnd - tStart);
        const b = barAtOrAfter(s.bars, t);
        if (b && b.p >= 0.02 && b.p <= 0.98) { bar = b; break; }
      }
      if (!bar) continue;
      const entry = (s.bet.inverse ? 1 - bar.p : bar.p) + SPREAD_COST;
      if (entry >= MAX_ENTRY) continue;
      const won = s.bet.inverse ? !tokenWon : tokenWon;
      const pnl = settle(entry, won);
      shufPnl += pnl; shufN++; if (won) shufWins++;
    }
  }

  // --- skeptic control 2: beta (buy the at-entry favorite at the same delayed times) ---
  let betaPnl = 0, betaN = 0, betaWins = 0;
  for (const s of scored60) {
    const idx = s.mkt.clobTokenIds.indexOf(s.bet.tokenId);
    if (s.mkt.clobTokenIds.length !== 2) continue;
    // token mid at the delayed entry (entryMid is inverse-adjusted; undo for the raw token)
    const tokenMid = s.bet.inverse ? 1 - s.entryMid : s.entryMid;
    const favIsToken = tokenMid >= 0.5;
    const favMid = favIsToken ? tokenMid : 1 - tokenMid;
    const entry = favMid + SPREAD_COST;
    if (entry >= MAX_ENTRY) continue;
    const favWon = favIsToken ? s.mkt.winningIndex === idx : s.mkt.winningIndex !== idx;
    betaPnl += settle(entry, favWon); betaN++; if (favWon) betaWins++;
  }

  // --- fine delays (5s/30s) via market tape, where reachable ---
  type FineAgg = { delay: number; n: number; wins: number; pnl: number; slipSum: number; achievedSum: number };
  const fineAggs: FineAgg[] = [...FINE_DELAYS, 60].map((d) => ({ delay: d, n: 0, wins: 0, pnl: 0, slipSum: 0, achievedSum: 0 }));
  const fineMarkets = Array.from(new Set(
    [...scored60].sort((a, b) => b.bet.ts - a.bet.ts).map((s) => s.bet.conditionId),
  )).slice(0, FINE_MARKETS);
  let tapeReached = 0, tapeMissed = 0;
  const tapeCache = new Map<string, Array<{ t: number; p: number; asset: string; side: string }>>();
  for (const cond of fineMarkets) {
    const betsHere = scored60.filter((s) => s.bet.conditionId === cond);
    const minTs = Math.min(...betsHere.map((s) => s.bet.ts));
    let tape: Array<{ t: number; p: number; asset: string; side: string }> = [];
    let covered = false;
    for (let off = 0; off <= 3000; off += 500) {
      let page: any[];
      try { page = await getJson<any[]>(`${DATA}/trades?market=${cond}&limit=500&offset=${off}`); }
      catch { break; }
      if (!Array.isArray(page) || page.length === 0) break;
      for (const tr of page) tape.push({ t: Number(tr.timestamp), p: Number(tr.price), asset: String(tr.asset), side: String(tr.side).toUpperCase() });
      const oldest = tape[tape.length - 1].t;
      if (oldest <= minTs) { covered = true; break; }
      if (page.length < 500) break;
      await sleep(120);
    }
    tape.sort((a, b) => a.t - b.t);
    tapeCache.set(cond, tape);
    const oldestTs = tape.length ? tape[0].t : Infinity;
    for (const s of betsHere) {
      if (s.bet.ts < oldestTs) { tapeMissed++; continue; }
      tapeReached++;
      const idx = s.mkt.clobTokenIds.indexOf(s.bet.tokenId);
      const tokenWon = s.mkt.winningIndex === idx;
      const won = s.bet.inverse ? !tokenWon : tokenWon;
      for (const fa of fineAggs) {
        const target = s.bet.ts + fa.delay;
        const tol = fa.delay <= 5 ? 25 : fa.delay <= 30 ? 30 : 60;
        // first print at/after target on either token (complement converted)
        const print = tape.find((p) => p.t >= target && p.t <= target + tol && (p.asset === s.bet.tokenId || s.mkt.clobTokenIds.includes(p.asset)));
        if (!print) continue;
        const sameToken = print.asset === s.bet.tokenId;
        // executable BUY price for our token from a side-attributed print:
        //   same-token BUY print → that WAS the ask; SELL print → bid, pay + spread
        //   complement BUY print at q → our bid ≈ 1-q, pay + spread; complement SELL print at q → our ask ≈ 1-q
        let exe: number;
        if (sameToken) exe = print.side === "BUY" ? print.p : print.p + SPREAD_COST;
        else exe = print.side === "SELL" ? 1 - print.p : 1 - print.p + SPREAD_COST;
        const entry = s.bet.inverse ? 1 - exe + 2 * SPREAD_COST : exe; // inverse: cross the other way
        if (entry >= MAX_ENTRY || entry <= 0.005) continue;
        const pnl = settle(entry, won);
        fa.n++; fa.pnl += pnl; if (won) fa.wins++;
        fa.slipSum += entry - (s.bet.inverse ? 1 - s.bet.leaderFill : s.bet.leaderFill);
        fa.achievedSum += print.t - s.bet.ts;
      }
    }
  }

  // --- report ---
  const fmt = (x: number) => (x * 100).toFixed(1) + "%";
  console.log(`\n--- coarse delays (1-min bars, full bet set) ---`);
  for (const a of aggs) {
    console.log(
      `delay=${a.delay}s  n=${a.n}  win=${a.n ? fmt(a.wins / a.n) : "-"}  copyROI=${a.n ? fmt(a.pnl / a.n) : "-"}  ` +
      `leaderROI(same bets)=${a.n ? fmt(a.leaderPnl / a.n) : "-"} (leaderWin=${a.n ? fmt(a.leaderWins / a.n) : "-"})  avgSlip=${a.n ? (a.slipSum / a.n * 100).toFixed(1) : "-"}¢  ` +
      `avgDrift=${a.n ? (a.driftSum / a.n * 100).toFixed(1) : "-"}¢  avgAchievedDelay=${a.n ? Math.round(a.achievedSum / a.n) : "-"}s  ` +
      `skipped[unres=${a.skUnresolved} noBars=${a.skNoBars} noBar=${a.skNoBar} tooExp=${a.skTooExpensive}]`,
    );
  }
  console.log(`\n--- controls (on the d=60 scored set, n=${scored60.length}) ---`);
  console.log(`shuffle (random entry, same token/window, ${SHUFFLE_DRAWS} draws/bet): n=${shufN} win=${shufN ? fmt(shufWins / shufN) : "-"} ROI=${shufN ? fmt(shufPnl / shufN) : "-"}`);
  console.log(`beta (buy at-entry favorite at same delayed times): n=${betaN} win=${betaN ? fmt(betaWins / betaN) : "-"} ROI=${betaN ? fmt(betaPnl / betaN) : "-"}`);
  console.log(`\n--- fine delays (market tape, most recent ${FINE_MARKETS} markets; reached=${tapeReached} missed=${tapeMissed}) ---`);
  for (const fa of fineAggs) {
    console.log(`delay=${fa.delay}s  n=${fa.n}  win=${fa.n ? fmt(fa.wins / fa.n) : "-"}  copyROI=${fa.n ? fmt(fa.pnl / fa.n) : "-"}  avgSlip=${fa.n ? (fa.slipSum / fa.n * 100).toFixed(1) : "-"}¢  avgAchieved=${fa.n ? Math.round(fa.achievedSum / fa.n) : "-"}s`);
  }

  const out = {
    wallet: WALLET, handle: HANDLE, runAt: new Date().toISOString(),
    maxAgeDays: MAX_AGE_DAYS, spreadCost: SPREAD_COST, dedupWindowSec: DEDUP_WINDOW_SEC,
    rawTrades: raw.length, tradesInWindow: trades.length, logicalBets: bets.length,
    resolvedMarkets: resolved.size, totalMarkets: conditionIds.length,
    tokensWithBars: barsByToken.size, tokensNeeded: tokenWindows.size,
    minUsd: MIN_USD,
    coarse: aggs, shuffle: { n: shufN, wins: shufWins, pnl: shufPnl },
    scoredBets: scored60.map((s) => ({
      slug: s.bet.slug, ts: s.bet.ts, usd: Math.round(s.bet.usd),
      leaderFill: s.bet.leaderFill, mid60: s.entryMid, inverse: s.bet.inverse, tokenWon: s.won,
    })),
    beta: { n: betaN, wins: betaWins, pnl: betaPnl },
    fine: { aggs: fineAggs, marketsTried: fineMarkets.length, betsReached: tapeReached, betsMissed: tapeMissed },
  };
  const path = `data/copy-lag-2026-06-11-${HANDLE}.json`;
  fs.writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${path}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
