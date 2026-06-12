/**
 * One-shot Polymarket wallet-discovery sweep (2026-06-10).
 *
 *   npx tsx scripts/_sweep-wallets.ts            # writes data/sweep-2026-06-10.json
 *
 * Pulls the DAY/WEEK/MONTH PnL leaderboards (top 50 each), applies the same
 * sustained-performance filter as scan-leaderboard, then for each candidate:
 *   - activity (500)        → event-type mix (MERGE/SPLIT/REWARD ⇒ maker fingerprint), events/hr
 *   - trades (500)          → clip sizes, trades/day, buy share, avg price, distinct markets
 *   - closed-positions(500) → realized PnL / nResolved / winRate (wallet-verification lib)
 *   - lb-api profit+volume  → all-time margin on volume (maker fingerprint: huge vol, ~1% margin)
 *   - user-pnl-api          → account span in days + drawdown of the cumulative PnL curve
 * Read-only. No orders. No DB writes.
 */
import "./_env.ts";
import { writeFileSync } from "node:fs";
import { db } from "../src/lib/db/client.ts";
import { poly } from "../src/lib/polymarket/client.ts";
import { walletStatsFromClosed, verifyWalletStats } from "../src/lib/wallets/wallet-verification.ts";

const TOP_N = 50;
const WINDOWS: Array<"DAY" | "WEEK" | "MONTH"> = ["DAY", "WEEK", "MONTH"];
const MIN_PNL = 5000, MIN_VOL = 10000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; }
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

(async () => {
  // 1. leaderboards
  const agg = new Map<string, { userName?: string; windows: Set<string>; bestPnl: number; bestVol: number }>();
  for (const w of WINDOWS) {
    const rows = (await poly.traderLeaderboard({ category: "OVERALL", timePeriod: w, orderBy: "PNL", limit: TOP_N })) as any[];
    for (const r of rows ?? []) {
      if (!r?.proxyWallet) continue;
      const k = r.proxyWallet.toLowerCase();
      const e = agg.get(k) ?? { userName: r.userName, windows: new Set<string>(), bestPnl: 0, bestVol: 0 };
      e.windows.add(w);
      e.bestPnl = Math.max(e.bestPnl, Number(r.pnl));
      e.bestVol = Math.max(e.bestVol, Number(r.vol));
      if (!e.userName && r.userName) e.userName = r.userName;
      agg.set(k, e);
    }
  }
  const candidates = [...agg.entries()]
    .filter(([, v]) => v.windows.size >= 2 && v.bestPnl >= MIN_PNL && v.bestVol >= MIN_VOL)
    .sort((a, b) => b[1].bestPnl - a[1].bestPnl);
  console.log(`[sweep] ${agg.size} distinct leaderboard wallets, ${candidates.length} sustained candidates`);

  // prior-tracked lookup (was this wallet already in tracked_wallets before today?)
  const prior = new Map(
    (db().prepare("SELECT proxy_wallet, created_at FROM tracked_wallets WHERE proxy_wallet IS NOT NULL").all() as Array<{ proxy_wallet: string; created_at: string }>)
      .map((r) => [r.proxy_wallet.toLowerCase(), r.created_at]),
  );

  const out: any[] = [];
  for (const [addr, meta] of candidates) {
    const [activity, trades, closed, profitArr, volArr, pnlSeries] = await Promise.all([
      poly.userActivity(addr, { limit: 500 }).catch(() => []),
      poly.userTrades(addr, { limit: 500 }).catch(() => []),
      getJson<any[]>(`https://data-api.polymarket.com/closed-positions?user=${addr}&limit=500`),
      getJson<any[]>(`https://lb-api.polymarket.com/profit?window=all&limit=1&address=${addr}`),
      getJson<any[]>(`https://lb-api.polymarket.com/volume?window=all&limit=1&address=${addr}`),
      getJson<Array<{ t: number; p: number }>>(`https://user-pnl-api.polymarket.com/user-pnl?user_address=${addr}&interval=all&fidelity=1d`),
    ]);

    const acts = Array.isArray(activity) ? (activity as any[]) : [];
    const typeCounts: Record<string, number> = {};
    for (const a of acts) typeCounts[String(a.type ?? "?")] = (typeCounts[String(a.type ?? "?")] ?? 0) + 1;
    const actSpanH = acts.length >= 2 ? (Number(acts[0].timestamp) - Number(acts[acts.length - 1].timestamp)) / 3600 : 0;
    const eventsPerHour = actSpanH > 0 ? acts.length / actSpanH : 0;
    const makerEvents = (typeCounts["MERGE"] ?? 0) + (typeCounts["SPLIT"] ?? 0) + (typeCounts["CONVERSION"] ?? 0) + (typeCounts["REWARD"] ?? 0) + (typeCounts["MAKER_REBATE"] ?? 0);
    const makerShare = acts.length ? makerEvents / acts.length : 0;

    const tr = Array.isArray(trades) ? (trades as any[]) : [];
    const clips = tr.map((t) => Number(t.usdcSize ?? Number(t.size ?? 0) * Number(t.price ?? 0))).filter((x) => x > 0);
    const trSpanD = tr.length >= 2 ? (Number(tr[0].timestamp) - Number(tr[tr.length - 1].timestamp)) / 86400 : 0;
    const tradesPerDay = trSpanD > 0 ? tr.length / trSpanD : tr.length;
    const buys = tr.filter((t) => String(t.side).toUpperCase() === "BUY");
    const buyShare = tr.length ? buys.length / tr.length : 0;
    const avgPrice = tr.length ? tr.reduce((a, t) => a + Number(t.price ?? 0), 0) / tr.length : 0;
    const distinctMarkets = new Set(tr.map((t) => String(t.conditionId))).size;

    const cl = Array.isArray(closed) ? closed : [];
    const stats = walletStatsFromClosed(cl.map((c) => ({ realizedPnl: Number(c.realizedPnl), curPrice: Number(c.curPrice) })));
    const verify = verifyWalletStats(stats, { minResolved: 10, minRealizedPnlUsd: 0 });
    const winners = cl.filter((c) => Number(c.curPrice) >= 0.99);
    const avgWinnerEntry = winners.length ? winners.reduce((a, c) => a + Number(c.avgPrice ?? 0), 0) / winners.length : 0;
    const cheapEntryShare = winners.length ? winners.filter((c) => Number(c.avgPrice) < 0.65).length / winners.length : 0;
    const distinctResolvedMkts = new Set(cl.map((c) => String(c.conditionId))).size;
    const totalBoughtSum = cl.reduce((a, c) => a + Number(c.totalBought ?? 0), 0);
    const maxPosShare = totalBoughtSum > 0 ? Math.max(0, ...cl.map((c) => Number(c.totalBought ?? 0))) / totalBoughtSum : 0;
    const catCounts: Record<string, number> = {};
    for (const c of cl) {
      const slug = String(c.eventSlug ?? c.slug ?? "");
      const cat = /atp|wta|nba|nhl|mlb|nfl|ufc|epl|liga|serie|bundesliga|league|cup|vs-|fc-|-fc|sox|yankees|f1|tennis|soccer|football|basketball|baseball|hockey|golf/.test(slug) ? "sports"
        : /btc|eth|sol|xrp|doge|bitcoin|ethereum|crypto|updown|up-or-down|above|dip/.test(slug) ? "crypto"
        : /trump|biden|elect|senate|house|president|mayor|primary|nominee|impeach|cabinet|tariff|fed-|rate|gov|minister|coalition|parliament/.test(slug) ? "politics-macro"
        : "other";
      catCounts[cat] = (catCounts[cat] ?? 0) + 1;
    }

    const series = Array.isArray(pnlSeries) ? pnlSeries : [];
    const spanDays = series.length >= 2 ? (series[series.length - 1].t - series[0].t) / 86400 : 0;
    let peak = -Infinity, maxDD = 0;
    for (const pt of series) { peak = Math.max(peak, pt.p); maxDD = Math.min(maxDD, pt.p - peak); }
    const allProfit = Number(profitArr?.[0]?.amount ?? NaN);
    const allVolume = Number(volArr?.[0]?.amount ?? NaN);
    const margin = Number.isFinite(allProfit) && allVolume > 0 ? allProfit / allVolume : null;

    // crude auto-classification (human review in the report refines it)
    let cls = "taker";
    if (makerShare > 0.05 || (margin !== null && margin < 0.02 && allVolume > 5_000_000 && eventsPerHour > 5)) cls = "maker";
    else if (eventsPerHour > 20 || tradesPerDay > 300) cls = "bot-highfreq";

    out.push({
      addr, userName: meta.userName, windows: [...meta.windows], leaderboardPnl: meta.bestPnl, leaderboardVol: meta.bestVol,
      priorTracked: prior.get(addr) ?? null,
      activity: { n: acts.length, typeCounts, eventsPerHour: +eventsPerHour.toFixed(2), makerShare: +makerShare.toFixed(4) },
      trades: { n: tr.length, spanDays: +trSpanD.toFixed(1), tradesPerDay: +tradesPerDay.toFixed(1), avgClipUsd: +(clips.reduce((a, b) => a + b, 0) / Math.max(1, clips.length)).toFixed(0), medianClipUsd: +median(clips).toFixed(0), buyShare: +buyShare.toFixed(2), avgPrice: +avgPrice.toFixed(3), distinctMarkets },
      realized: { pnlUsd: +stats.realizedPnlUsd.toFixed(0), nResolved: stats.nResolved, winRate: +stats.winRate.toFixed(3), verified: verify.verified, reason: verify.reason, distinctResolvedMkts, avgWinnerEntry: +avgWinnerEntry.toFixed(3), cheapEntryShare: +cheapEntryShare.toFixed(2), maxPosShare: +maxPosShare.toFixed(2), categories: catCounts },
      allTime: { profitUsd: Number.isFinite(allProfit) ? Math.round(allProfit) : null, volumeUsd: Number.isFinite(allVolume) ? Math.round(allVolume) : null, marginOnVolume: margin !== null ? +margin.toFixed(4) : null },
      pnlCurve: { spanDays: +spanDays.toFixed(0), maxDrawdownUsd: Math.round(maxDD) },
      autoClass: cls,
    });
    console.log(`[sweep] ${addr.slice(0, 10)}… ${String(meta.userName ?? "").padEnd(20)} class=${cls.padEnd(13)} realized=$${Math.round(stats.realizedPnlUsd).toLocaleString()} n=${stats.nResolved} span=${spanDays.toFixed(0)}d margin=${margin !== null ? (margin * 100).toFixed(1) + "%" : "?"}`);
    await sleep(200);
  }

  writeFileSync("data/sweep-2026-06-10.json", JSON.stringify(out, null, 2));
  console.log(`[sweep] wrote data/sweep-2026-06-10.json (${out.length} wallets)`);
})().catch((e) => { console.error("[sweep] FATAL:", e); process.exit(1); });
