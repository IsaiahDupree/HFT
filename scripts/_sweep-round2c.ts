/**
 * Round-2 sweep, part 2 (2026-06-11): fixed channel C (near-cert takers) + extra channel-B profiles.
 *   npx tsx scripts/_sweep-round2c.ts    # writes data/sweep-2026-06-11-round2c.json
 * Channel C fix: gamma /markets?closed=true&volume_num_min=100000&end_date_min/max — the /events
 * endDate-desc stream is flooded with tiny updown/ITF markets so the first 300 never hit $100k.
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
function median(xs: number[]): number { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

const round1 = JSON.parse(readFileSync("data/sweep-2026-06-10.json", "utf8")) as Array<{ addr: string }>;
const round2 = JSON.parse(readFileSync("data/sweep-2026-06-11-round2.json", "utf8")) as any;
const EXCLUDE = new Set<string>(round1.map((w) => w.addr.toLowerCase()));
for (const p of round2.profiles ?? []) EXCLUDE.add(String(p.addr).toLowerCase());
EXCLUDE.add("0x55be7aa03ecfbe37aa5460db791205f7ac9ddca3");
const isExcluded = (a: string) => EXCLUDE.has(a) || a.startsWith("0xf8831548");

async function profileWallet(addr: string, channels: string[], chanMeta: any) {
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
  const highPriceBuys = buys.filter((t) => Number(t.price) >= 0.9);
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
  return {
    addr, userName: chanMeta?.B?.userName ?? profile?.name ?? profile?.pseudonym ?? null, channels, chanMeta,
    activity: { n: acts.length, typeCounts, eventsPerHour: +eventsPerHour.toFixed(2), makerShare: +makerShare.toFixed(4) },
    trades: { n: tr.length, spanDays: +trSpanD.toFixed(1), tradesPerDay: +tradesPerDay.toFixed(1), medianClipUsd: +median(clips).toFixed(0), buyShare: tr.length ? +(buys.length / tr.length).toFixed(2) : 0, highPriceBuyShare: buys.length ? +(highPriceBuys.length / buys.length).toFixed(2) : 0 },
    realized: { recentPnlUsd: +stats.realizedPnlUsd.toFixed(0), nResolved: stats.nResolved, winRate: +stats.winRate.toFixed(3), verified: verify.verified, reason: verify.reason, categories: catCounts, highEntryWinners },
    allTime: { profitUsd: Number.isFinite(allProfit) ? Math.round(allProfit) : null, volumeUsd: Number.isFinite(allVolume) ? Math.round(allVolume) : null, marginOnVolume: margin !== null ? +margin.toFixed(4) : null },
    pnlCurve: { spanDays: +spanDays.toFixed(0), maxDrawdownUsd: Math.round(maxDD) },
    autoClass: cls,
  };
}

(async () => {
  const out: any = { generatedAt: new Date().toISOString() };

  // ---- CHANNEL C (fixed): near-cert buyers on recently resolved $100k+ markets ----
  const nowIso = new Date().toISOString();
  const tenDaysAgo = new Date(Date.now() - 10 * 86400_000).toISOString();
  const mkts: Array<{ cond: string; slug: string; vol: number; endDate: string }> = [];
  for (let offset = 0; offset < 400 && mkts.length < 60; offset += 100) {
    const page = await getJson<any[]>(
      `https://gamma-api.polymarket.com/markets?closed=true&end_date_min=${tenDaysAgo}&end_date_max=${nowIso}&volume_num_min=100000&order=endDate&ascending=false&limit=100&offset=${offset}`);
    if (!Array.isArray(page) || !page.length) break;
    for (const m of page) {
      const slug = String(m.slug ?? "");
      if (/updown/.test(slug)) continue;
      if (mkts.length < 60) mkts.push({ cond: m.conditionId, slug, vol: Number(m.volumeNum ?? 0), endDate: m.endDate });
    }
    await sleep(150);
  }
  console.log(`[C] ${mkts.length} resolved markets (vol ≥ $100k, non-updown, last 10d)`);

  const cAgg = new Map<string, { markets: Set<string>; usd: number; n: number; prices: number[]; slugs: Set<string> }>();
  for (const m of mkts) {
    const trades = await getJson<any[]>(`https://data-api.polymarket.com/trades?market=${m.cond}&limit=500`);
    for (const t of trades ?? []) {
      const price = Number(t.price);
      if (String(t.side).toUpperCase() !== "BUY" || price < 0.94 || price > 0.995) continue;
      const w = String(t.proxyWallet).toLowerCase();
      const e = cAgg.get(w) ?? { markets: new Set<string>(), usd: 0, n: 0, prices: [], slugs: new Set<string>() };
      e.markets.add(m.cond); e.usd += Number(t.size) * price; e.n++; e.prices.push(price); e.slugs.add(m.slug);
      cAgg.set(w, e);
    }
    await sleep(120);
  }
  const cRecurring = [...cAgg.entries()]
    .map(([w, v]) => ({ wallet: w, nMarkets: v.markets.size, nFills: v.n, usd: Math.round(v.usd), avgPrice: +(v.prices.reduce((a, b) => a + b, 0) / Math.max(1, v.prices.length)).toFixed(3), sampleSlugs: [...v.slugs].slice(0, 5) }))
    .filter((x) => x.nMarkets >= 4 && x.usd >= 3000)
    .sort((a, b) => b.nMarkets - a.nMarkets);
  console.log(`[C] ${cAgg.size} distinct near-cert buyers → ${cRecurring.length} recurring (≥4 mkts, ≥$3k)`);
  out.nearCert = { marketsScanned: mkts.length, distinctNearCertBuyers: cAgg.size, recurring: cRecurring.length, recurringList: cRecurring.slice(0, 25) };

  // ---- profiles: channel C recurring + extra channel-B (low-vol/high-profit takers) ----
  const extraB: Array<[string, string]> = [
    ["0xdd9ed02bb67b2ec504be24b98febd651fdac49b3", "Binotto"],
    ["0x408fe71e6b5401ecd6733970cb6f1a25e984b2f4", "Winnerdinnerchickenjr"],
    ["0x2d90f5a2e4a03e42a1186f759ff3e051e0aa1310", "Aceplus2"],
    ["0x157efb90bf2f3bae9eea4f1e9d02abf12ff3add7", "resadasdasd8asd8dasd4"],
    ["0xa2cd4ccda9a1f95949df7a3355c4c2daa0642ba0", "0xA2cd4Ccd…"],
    ["0x65503c7f9e142ac88b1ce09df3363ff77f188451", "oieshfn345"],
  ];
  const profiles: any[] = [];
  for (const r of cRecurring.slice(0, 12)) {
    if (isExcluded(r.wallet)) { console.log(`[skip] ${r.wallet} already profiled`); continue; }
    const p = await profileWallet(r.wallet, ["near-cert"], { C: r });
    profiles.push(p);
    console.log(`[C-profile] ${r.wallet.slice(0, 10)}… ${String(p.userName ?? "").padEnd(18)} class=${p.autoClass.padEnd(12)} allTime=$${p.allTime.profitUsd?.toLocaleString() ?? "?"} margin=${p.allTime.marginOnVolume !== null ? (p.allTime.marginOnVolume * 100).toFixed(1) + "%" : "?"} span=${p.pnlCurve.spanDays}d nearCert: ${r.nMarkets} mkts $${r.usd.toLocaleString()}`);
    await sleep(250);
  }
  for (const [addr, name] of extraB) {
    if (isExcluded(addr)) continue;
    const p = await profileWallet(addr, ["vol-leaderboard"], { B: { userName: name } });
    profiles.push(p);
    console.log(`[B-profile] ${addr.slice(0, 10)}… ${name.padEnd(22)} class=${p.autoClass.padEnd(12)} allTime=$${p.allTime.profitUsd?.toLocaleString() ?? "?"} vol=$${p.allTime.volumeUsd?.toLocaleString() ?? "?"} margin=${p.allTime.marginOnVolume !== null ? (p.allTime.marginOnVolume * 100).toFixed(1) + "%" : "?"} span=${p.pnlCurve.spanDays}d recent=$${p.realized.recentPnlUsd.toLocaleString()}/n=${p.realized.nResolved}/win=${p.realized.winRate}`);
    await sleep(250);
  }
  out.profiles = profiles;
  writeFileSync("data/sweep-2026-06-11-round2c.json", JSON.stringify(out, null, 2));
  console.log(`[done] wrote data/sweep-2026-06-11-round2c.json (${profiles.length} profiled)`);
})().catch((e) => { console.error("[sweep2c] FATAL:", e); process.exit(1); });
