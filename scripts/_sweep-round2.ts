/**
 * Wallet-discovery sweep ROUND 2 (2026-06-11) — the corners the PnL boards miss.
 *
 *   npx tsx scripts/_sweep-round2.ts            # writes data/sweep-2026-06-11-round2.json
 *
 * Channels:
 *   A. CRYPTO 5-min Up/Down binaries (btc/eth-updown-5m-<epoch>) — recurring counterparties
 *      across sampled windows (takerOnly=false so both maker and taker side fills appear).
 *   B. VOLUME leaderboard (orderBy=VOL, DAY/WEEK/MONTH) — high-volume wallets with positive
 *      all-time realized profit (lb-api), i.e. grinders the PnL boards undersell.
 *   C. "Small near-cert taker" lane — wallets that recur BUYing 0.94-0.995 on recently
 *      resolved markets (the aekghas pattern).
 * Then a per-wallet deep profile identical to the 2026-06-10 sweep (activity event mix,
 * trades, closed-positions realized stats, lb-api all-time, user-pnl span/drawdown), plus
 * maker-calibration stats from the channel-A window fills.
 *
 * Read-only. No orders. No DB writes.
 */
import "./_env.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { poly } from "../src/lib/polymarket/client.ts";
import { walletStatsFromClosed, verifyWalletStats } from "../src/lib/wallets/wallet-verification.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(url: string): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
      if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch { await sleep(800); }
  }
  return null;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

// ---- exclusions: round-1 cohort + known wallets ----
const round1 = JSON.parse(readFileSync("data/sweep-2026-06-10.json", "utf8")) as Array<{ addr: string }>;
const EXCLUDE = new Set<string>(round1.map((w) => w.addr.toLowerCase()));
EXCLUDE.add("0x55be7aa03ecfbe37aa5460db791205f7ac9ddca3"); // coinman2 (maker, audited)
const EXCLUDE_PREFIX = ["0xf8831548"]; // Inaccuratestake (one-lucky-tail, round 1)
const isExcluded = (a: string) => EXCLUDE.has(a) || EXCLUDE_PREFIX.some((p) => a.startsWith(p));

type Fill = { wallet: string; side: string; price: number; usd: number; ts: number; slug: string; asset: string };

(async () => {
  const report: any = { generatedAt: new Date().toISOString(), channels: {} };

  // ================= CHANNEL A: crypto 5-min binaries =================
  const nowFloor = Math.floor(Date.now() / 1000 / 300) * 300;
  // sample: last 12 consecutive resolved windows + 1 window/hour back 22h (series relaunched 2026-06-10)
  const offsets: number[] = [];
  for (let i = 2; i <= 13; i++) offsets.push(i * 300);            // recent consecutive
  for (let h = 2; h <= 22; h += 1) offsets.push(h * 3600);        // hourly back-samples
  const slugs: string[] = [];
  for (const asset of ["btc", "eth"]) for (const off of offsets) slugs.push(`${asset}-updown-5m-${nowFloor - off}`);

  const windowFills: Fill[] = [];
  let winFound = 0, winMissing = 0;
  for (const slug of slugs) {
    const ev = await getJson<any[]>(`https://gamma-api.polymarket.com/events?slug=${slug}`);
    const cond = ev?.[0]?.markets?.[0]?.conditionId;
    if (!cond) { winMissing++; continue; }
    const trades = await getJson<any[]>(`https://data-api.polymarket.com/trades?market=${cond}&limit=500&takerOnly=false`);
    if (!Array.isArray(trades) || !trades.length) { winMissing++; continue; }
    winFound++;
    for (const t of trades) {
      windowFills.push({
        wallet: String(t.proxyWallet).toLowerCase(), side: String(t.side),
        price: Number(t.price), usd: Number(t.size) * Number(t.price),
        ts: Number(t.timestamp), slug, asset: slug.slice(0, 3),
      });
    }
    await sleep(120);
  }
  console.log(`[A] sampled ${slugs.length} window slugs → ${winFound} with trades (${winMissing} missing/empty), ${windowFills.length} fills`);

  // aggregate per wallet
  const aAgg = new Map<string, { windows: Set<string>; fills: Fill[] }>();
  for (const f of windowFills) {
    const e = aAgg.get(f.wallet) ?? { windows: new Set<string>(), fills: [] };
    e.windows.add(f.slug); e.fills.push(f); aAgg.set(f.wallet, e);
  }
  const aRecurring = [...aAgg.entries()]
    .map(([w, v]) => ({ wallet: w, nWindows: v.windows.size, nFills: v.fills.length, usd: v.fills.reduce((a, f) => a + f.usd, 0), fills: v.fills }))
    .filter((x) => x.nWindows >= 6)
    .sort((a, b) => b.nWindows - a.nWindows);
  console.log(`[A] ${aAgg.size} distinct wallets in sampled windows → ${aRecurring.length} recurring (≥6 windows)`);
  report.channels.cryptoUpDown = {
    windowsSampled: slugs.length, windowsWithTrades: winFound, totalFills: windowFills.length,
    distinctWallets: aAgg.size, recurringThreshold: 6, recurring: aRecurring.length,
  };

  // ================= CHANNEL B: VOL leaderboard =================
  const bAgg = new Map<string, { userName?: string; windows: Set<string>; vol: number; pnl: number }>();
  for (const w of ["DAY", "WEEK", "MONTH"] as const) {
    const rows = (await poly.traderLeaderboard({ category: "OVERALL", timePeriod: w, orderBy: "VOL", limit: 50 })) as any[];
    for (const r of rows ?? []) {
      if (!r?.proxyWallet) continue;
      const k = String(r.proxyWallet).toLowerCase();
      const e = bAgg.get(k) ?? { userName: r.userName, windows: new Set<string>(), vol: 0, pnl: 0 };
      e.windows.add(w); e.vol = Math.max(e.vol, Number(r.vol)); e.pnl = Math.max(e.pnl, Number(r.pnl));
      bAgg.set(k, e);
    }
    await sleep(150);
  }
  const bAll = [...bAgg.entries()];
  const bNew = bAll.filter(([a]) => !isExcluded(a));
  // prefilter: positive all-time realized profit via lb-api
  const bSurvivors: Array<{ addr: string; userName?: string; vol: number; allProfit: number }> = [];
  let bChecked = 0, bNegative = 0;
  for (const [addr, meta] of bNew) {
    const prof = await getJson<any[]>(`https://lb-api.polymarket.com/profit?window=all&limit=1&address=${addr}`);
    const p = Number(prof?.[0]?.amount ?? NaN);
    bChecked++;
    if (Number.isFinite(p) && p > 10000) bSurvivors.push({ addr, userName: meta.userName, vol: meta.vol, allProfit: p });
    else bNegative++;
    await sleep(120);
  }
  bSurvivors.sort((a, b) => b.allProfit - a.allProfit);
  console.log(`[B] ${bAll.length} distinct VOL-board wallets, ${bNew.length} not already examined, ${bChecked} profit-checked → ${bSurvivors.length} with all-time profit > $10k`);
  report.channels.volLeaderboard = {
    distinct: bAll.length, alreadyExamined: bAll.length - bNew.length, checked: bChecked,
    failedProfitGate: bNegative, survivors: bSurvivors.map((s) => ({ addr: s.addr, userName: s.userName, vol: Math.round(s.vol), allProfit: Math.round(s.allProfit) })),
  };

  // ================= CHANNEL C: near-cert takers on recently resolved markets =================
  const nowIso = new Date().toISOString();
  const tenDaysAgo = new Date(Date.now() - 10 * 86400_000).toISOString();
  const cMarkets: Array<{ cond: string; slug: string; vol: number }> = [];
  for (let offset = 0; offset < 300 && cMarkets.length < 45; offset += 100) {
    const evs = await getJson<any[]>(
      `https://gamma-api.polymarket.com/events?closed=true&end_date_min=${tenDaysAgo}&end_date_max=${nowIso}&order=endDate&ascending=false&limit=100&offset=${offset}`);
    if (!Array.isArray(evs) || !evs.length) break;
    for (const e of evs) {
      for (const m of e.markets ?? []) {
        const vol = Number(m.volumeNum ?? m.volume ?? 0);
        const slug = String(m.slug ?? e.slug ?? "");
        if (vol >= 100_000 && !/updown/.test(slug) && cMarkets.length < 45) cMarkets.push({ cond: m.conditionId, slug, vol });
      }
    }
    await sleep(150);
  }
  console.log(`[C] ${cMarkets.length} recently-resolved markets (vol ≥ $100k, non-updown)`);

  const cAgg = new Map<string, { markets: Set<string>; usd: number; n: number; prices: number[] }>();
  for (const m of cMarkets) {
    const trades = await getJson<any[]>(`https://data-api.polymarket.com/trades?market=${m.cond}&limit=500`); // takerOnly default true
    for (const t of trades ?? []) {
      const price = Number(t.price);
      if (String(t.side).toUpperCase() !== "BUY" || price < 0.94 || price > 0.995) continue;
      const w = String(t.proxyWallet).toLowerCase();
      const e = cAgg.get(w) ?? { markets: new Set<string>(), usd: 0, n: 0, prices: [] };
      e.markets.add(m.cond); e.usd += Number(t.size) * price; e.n++; e.prices.push(price);
      cAgg.set(w, e);
    }
    await sleep(120);
  }
  const cRecurring = [...cAgg.entries()]
    .map(([w, v]) => ({ wallet: w, nMarkets: v.markets.size, nFills: v.n, usd: v.usd, avgPrice: v.prices.reduce((a, b) => a + b, 0) / Math.max(1, v.prices.length) }))
    .filter((x) => x.nMarkets >= 4 && x.usd >= 3000)
    .sort((a, b) => b.nMarkets - a.nMarkets);
  console.log(`[C] ${cAgg.size} distinct near-cert buyers → ${cRecurring.length} recurring (≥4 markets, ≥$3k)`);
  report.channels.nearCert = {
    marketsScanned: cMarkets.length, distinctNearCertBuyers: cAgg.size,
    recurringThreshold: "≥4 markets and ≥$3k", recurring: cRecurring.length,
  };

  // ================= deep profile union of candidates =================
  const toProfile = new Map<string, { channels: string[]; chanMeta: any }>();
  for (const r of aRecurring.slice(0, 18)) {
    if (isExcluded(r.wallet)) { console.log(`[skip] ${r.wallet} (channel A) already examined round 1`); continue; }
    toProfile.set(r.wallet, { channels: ["crypto-updown"], chanMeta: { A: { nWindows: r.nWindows, nFills: r.nFills, usd: Math.round(r.usd) } } });
  }
  for (const s of bSurvivors.slice(0, 15)) {
    const e = toProfile.get(s.addr) ?? { channels: [], chanMeta: {} };
    e.channels.push("vol-leaderboard"); e.chanMeta.B = { vol: Math.round(s.vol), allProfit: Math.round(s.allProfit), userName: s.userName };
    toProfile.set(s.addr, e);
  }
  for (const r of cRecurring.slice(0, 12)) {
    if (isExcluded(r.wallet)) { console.log(`[skip] ${r.wallet} (channel C) already examined round 1`); continue; }
    const e = toProfile.get(r.wallet) ?? { channels: [], chanMeta: {} };
    e.channels.push("near-cert"); e.chanMeta.C = { nMarkets: r.nMarkets, nFills: r.nFills, usd: Math.round(r.usd), avgPrice: +r.avgPrice.toFixed(3) };
    toProfile.set(r.wallet, e);
  }
  console.log(`[profile] deep-profiling ${toProfile.size} wallets`);

  const profiles: any[] = [];
  for (const [addr, meta] of toProfile) {
    const [activity, trades, closed, profitArr, volArr, pnlSeries, profile] = await Promise.all([
      poly.userActivity(addr, { limit: 500 }).catch(() => []),
      poly.userTrades(addr, { limit: 500 }).catch(() => []),
      getJson<any[]>(`https://data-api.polymarket.com/closed-positions?user=${addr}&limit=500`),
      getJson<any[]>(`https://lb-api.polymarket.com/profit?window=all&limit=1&address=${addr}`),
      getJson<any[]>(`https://lb-api.polymarket.com/volume?window=all&limit=1&address=${addr}`),
      getJson<Array<{ t: number; p: number }>>(`https://user-pnl-api.polymarket.com/user-pnl?user_address=${addr}&interval=all&fidelity=1d`),
      getJson<any>(`https://gamma-api.polymarket.com/public-profile?address=${addr}`),
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
    const cryptoTrades = tr.filter((t) => /updown|btc|eth-|bitcoin|ethereum/.test(String(t.slug ?? "")));

    const cl = Array.isArray(closed) ? closed : [];
    const stats = walletStatsFromClosed(cl.map((c) => ({ realizedPnl: Number(c.realizedPnl), curPrice: Number(c.curPrice) })));
    const verify = verifyWalletStats(stats, { minResolved: 10, minRealizedPnlUsd: 0 });
    const catCounts: Record<string, number> = {};
    for (const c of cl) {
      const slug = String(c.eventSlug ?? c.slug ?? "");
      const cat = /updown|up-or-down/.test(slug) ? "crypto-updown"
        : /btc|eth|sol|xrp|doge|bitcoin|ethereum|crypto|above|dip/.test(slug) ? "crypto-other"
        : /atp|wta|nba|nhl|mlb|nfl|ufc|epl|liga|serie|bundesliga|league|cup|vs-|fc-|-fc|sox|yankees|f1|tennis|soccer|football|basketball|baseball|hockey|golf|valorant|cs2|dota|lol-/.test(slug) ? "sports"
        : /trump|biden|elect|senate|house|president|mayor|primary|nominee|impeach|cabinet|tariff|fed-|rate|gov|minister|coalition|parliament|iran|israel|ukraine|russia|nato/.test(slug) ? "politics-macro"
        : "other";
      catCounts[cat] = (catCounts[cat] ?? 0) + 1;
    }
    const highEntryWinners = cl.filter((c) => Number(c.avgPrice) >= 0.9 && Number(c.curPrice) >= 0.99).length;
    const highEntryShare = cl.length ? highEntryWinners / cl.length : 0;

    const series = Array.isArray(pnlSeries) ? pnlSeries : [];
    const spanDays = series.length >= 2 ? (series[series.length - 1].t - series[0].t) / 86400 : 0;
    let peak = -Infinity, maxDD = 0;
    for (const p of series) { peak = Math.max(peak, p.p); maxDD = Math.min(maxDD, p.p - peak); }
    const allProfit = Number(profitArr?.[0]?.amount ?? NaN);
    const allVolume = Number(volArr?.[0]?.amount ?? NaN);
    const margin = Number.isFinite(allProfit) && allVolume > 0 ? allProfit / allVolume : null;

    let cls = "taker";
    if (makerShare > 0.05 || (margin !== null && margin < 0.02 && allVolume > 5_000_000 && eventsPerHour > 5)) cls = "maker";
    else if (eventsPerHour > 20 || tradesPerDay > 300) cls = "bot-highfreq";

    // maker calibration stats from channel-A fills (if present)
    let calib: any = null;
    const aEntry = aAgg.get(addr);
    if (aEntry && aEntry.fills.length >= 10) {
      const fillUsd = aEntry.fills.map((f) => f.usd);
      const fillPrices = aEntry.fills.map((f) => f.price);
      const byWin = new Map<string, Fill[]>();
      for (const f of aEntry.fills) { const a2 = byWin.get(f.slug) ?? []; a2.push(f); byWin.set(f.slug, a2); }
      let twoSided = 0; const gaps: number[] = [];
      for (const [, fs] of byWin) {
        const sides = new Set(fs.map((f) => f.side));
        if (sides.size > 1) twoSided++;
        const ts = fs.map((f) => f.ts).sort((a, b) => a - b);
        for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
      }
      calib = {
        nFills: aEntry.fills.length, nWindows: byWin.size,
        fillsPerWindow: +(aEntry.fills.length / byWin.size).toFixed(1),
        medianClipUsd: +median(fillUsd).toFixed(0), p90ClipUsd: +pct(fillUsd, 0.9).toFixed(0),
        medianPrice: +median(fillPrices).toFixed(3), p10Price: +pct(fillPrices, 0.1).toFixed(3), p90Price: +pct(fillPrices, 0.9).toFixed(3),
        priceNearMidShare: +(fillPrices.filter((p) => p >= 0.4 && p <= 0.6).length / fillPrices.length).toFixed(2),
        twoSidedWindowShare: +(twoSided / byWin.size).toFixed(2),
        medianInterFillGapSec: median(gaps),
      };
    }

    profiles.push({
      addr, userName: meta.chanMeta?.B?.userName ?? profile?.name ?? profile?.pseudonym ?? null,
      channels: meta.channels, chanMeta: meta.chanMeta,
      activity: { n: acts.length, typeCounts, eventsPerHour: +eventsPerHour.toFixed(2), makerShare: +makerShare.toFixed(4) },
      trades: { n: tr.length, spanDays: +trSpanD.toFixed(1), tradesPerDay: +tradesPerDay.toFixed(1), medianClipUsd: +median(clips).toFixed(0), buyShare: tr.length ? +(buys.length / tr.length).toFixed(2) : 0, cryptoShare: tr.length ? +(cryptoTrades.length / tr.length).toFixed(2) : 0 },
      realized: { recentPnlUsd: +stats.realizedPnlUsd.toFixed(0), nResolved: stats.nResolved, winRate: +stats.winRate.toFixed(3), verified: verify.verified, reason: verify.reason, categories: catCounts, highEntryShare: +highEntryShare.toFixed(2) },
      allTime: { profitUsd: Number.isFinite(allProfit) ? Math.round(allProfit) : null, volumeUsd: Number.isFinite(allVolume) ? Math.round(allVolume) : null, marginOnVolume: margin !== null ? +margin.toFixed(4) : null },
      pnlCurve: { spanDays: +spanDays.toFixed(0), maxDrawdownUsd: Math.round(maxDD) },
      autoClass: cls, makerCalib: calib,
    });
    console.log(`[profile] ${addr.slice(0, 10)}… ${String(meta.chanMeta?.B?.userName ?? "").padEnd(18)} ch=${meta.channels.join("+").padEnd(28)} class=${cls.padEnd(12)} allTime=$${Number.isFinite(allProfit) ? Math.round(allProfit).toLocaleString() : "?"} margin=${margin !== null ? (margin * 100).toFixed(1) + "%" : "?"} span=${spanDays.toFixed(0)}d recent=$${Math.round(stats.realizedPnlUsd).toLocaleString()}/n=${stats.nResolved}/win=${stats.winRate.toFixed(2)}`);
    await sleep(250);
  }

  report.profiles = profiles;
  report.channelARecurringRaw = aRecurring.map(({ fills, ...rest }) => rest).slice(0, 30);
  report.channelCRecurringRaw = cRecurring.slice(0, 30);
  writeFileSync("data/sweep-2026-06-11-round2.json", JSON.stringify(report, null, 2));
  console.log(`[done] wrote data/sweep-2026-06-11-round2.json (${profiles.length} profiled)`);
})().catch((e) => { console.error("[sweep2] FATAL:", e); process.exit(1); });
