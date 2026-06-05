/**
 * carry-now — the "fulfill profits today" scanner. Ranks LIVE funding-carry opportunities on dYdX
 * (keyless indexer, hedgeable perps) by deployable score = persistence × |funding APR|, with the
 * net daily carry after a realistic round-trip fee, the side to take, and a hedge note. dYdX funding
 * is HOURLY. A carry is real income only when the funding is PERSISTENT (one-sided) — a single fat
 * print is a trap — so we pull each candidate's recent history and score sign-stability, not just the
 * snapshot. This is the deployable engine: short the positive-funding perp / long the negative one,
 * hedge the price with spot, collect the funding.
 *
 *   npm run carry:now [-- --top 15 --min-apr 25 --fee-bps 5 --hold-days 14]
 */
import "./_env.ts";

const num = (n: string, d: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const top = num("--top", 15), minApr = num("--min-apr", 25), feeBps = num("--fee-bps", 5), holdDays = num("--hold-days", 14);
const IDX = "https://indexer.dydx.trade/v4";
// assets with deep, accessible spot for the hedge leg (Coinbase / Binance.US). Non-crypto (WTI) +
// thin memes can't be cleanly hedged → flagged.
const HEDGEABLE = new Set(["BTC", "ETH", "SOL", "AVAX", "LINK", "COMP", "AAVE", "UNI", "LTC", "DOGE", "ADA", "DOT", "ATOM", "XRP", "BCH", "ASTR", "NEAR", "ARB", "OP", "SUI", "SEI", "TIA", "INJ", "FIL", "APT", "MKR", "CRV", "LDO", "SNX", "ENA", "WLD", "JUP", "PYTH"]);

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${url.split("/v4/")[1]} → HTTP ${r.status}`);
  return r.json();
}

// 1) current funding across all dYdX perps
const markets = (await getJson(`${IDX}/perpetualMarkets`)).markets as Record<string, { nextFundingRate?: string; openInterest?: string; oraclePrice?: string }>;
const live = Object.entries(markets)
  .map(([ticker, m]) => ({ ticker, coin: ticker.replace("-USD", ""), hourly: m.nextFundingRate != null ? +m.nextFundingRate : NaN, oi: +(m.openInterest ?? 0) * +(m.oraclePrice ?? 0) }))
  .filter((x) => Number.isFinite(x.hourly) && Math.abs(x.hourly) * 24 * 365 * 100 >= minApr && x.oi > 1e6) // ≥$1M OI = tradeable
  .sort((a, b) => Math.abs(b.hourly) - Math.abs(a.hourly))
  .slice(0, top);

// 2) persistence from recent historical funding (≈7d of hourly prints)
type Opp = { coin: string; ticker: string; side: "SHORT perp" | "LONG perp"; curApr: number; meanApr: number; persistence: number; grossBpDay: number; netBpDay: number; netApr: number; oiM: number; hedge: string };
const opps: Opp[] = [];
for (const x of live) {
  try {
    const hist = (await getJson(`${IDX}/historicalFunding/${x.ticker}?limit=168`)).historicalFunding as Array<{ rate: string }>;
    const rates = hist.map((h) => +h.rate).filter(Number.isFinite);
    if (rates.length < 24) continue;
    const pos = rates.filter((r) => r > 0).length;
    const persistence = Math.max(pos, rates.length - pos) / rates.length;     // 0.5 coinflip … 1 always one side
    const meanHourly = rates.reduce((a, r) => a + r, 0) / rates.length;
    const meanApr = meanHourly * 24 * 365 * 100;
    // you take the funding-RECEIVING side: SHORT when funding >0 (longs pay), LONG when <0.
    const side = meanHourly >= 0 ? "SHORT perp" : "LONG perp";
    const grossBpDay = Math.abs(meanHourly) * 24 * 1e4;                        // funding harvested per day, bps
    const netBpDay = grossBpDay - (2 * feeBps) / holdDays;                     // amortize one round-trip over the hold
    const netApr = netBpDay * 365 / 100;
    opps.push({ coin: x.coin, ticker: x.ticker, side, curApr: x.hourly * 24 * 365 * 100, meanApr, persistence, grossBpDay, netBpDay, netApr, oiM: x.oi / 1e6, hedge: HEDGEABLE.has(x.coin) ? "spot ✓" : "no clean spot ✗" });
    await new Promise((r) => setTimeout(r, 80));
  } catch { /* skip */ }
}
// deployable = steady (persistence) × fat (|meanApr|), net-positive, hedgeable preferred
opps.sort((a, b) => (b.persistence * Math.abs(b.meanApr) + (b.hedge.includes("✓") ? 30 : 0)) - (a.persistence * Math.abs(a.meanApr) + (a.hedge.includes("✓") ? 30 : 0)));

console.log(`\ncarry-now — LIVE dYdX funding-carry opportunities (deployable = persistent + fat + hedgeable)\n  fee ${feeBps}bp/side · ${holdDays}d hold · min ${minApr}% APR · ≥$1M OI\n`);
console.log(`  ${"coin".padEnd(8)} ${"side".padEnd(11)} ${"7d-mean APR".padEnd(12)} ${"now APR".padEnd(9)} ${"persist".padEnd(8)} ${"net/day".padEnd(9)} ${"net APR".padEnd(9)} ${"OI".padEnd(8)} hedge`);
for (const o of opps) {
  console.log(`  ${o.coin.padEnd(8)} ${o.side.padEnd(11)} ${`${o.meanApr >= 0 ? "+" : ""}${o.meanApr.toFixed(0)}%`.padEnd(12)} ${`${o.curApr >= 0 ? "+" : ""}${o.curApr.toFixed(0)}%`.padEnd(9)} ${`${(o.persistence * 100).toFixed(0)}%`.padEnd(8)} ${`${o.netBpDay.toFixed(1)}bp`.padEnd(9)} ${`${o.netApr >= 0 ? "+" : ""}${o.netApr.toFixed(0)}%`.padEnd(9)} ${`$${o.oiM.toFixed(0)}M`.padEnd(8)} ${o.hedge}`);
}
const best = opps.filter((o) => o.persistence >= 0.7 && o.netApr > 0 && o.hedge.includes("✓")).slice(0, 3);
console.log(`\n  dYdX DEPLOYABLE TODAY (persistence ≥70%, net-positive, hedgeable):`);
if (!best.length) console.log(`    none right now — dYdX funding is transient/thin. Re-run later (funding rotates).`);
for (const o of best) console.log(`    ${o.side} ${o.coin}-USD on dYdX (collect ~${Math.abs(o.meanApr).toFixed(0)}% funding) + ${o.side === "SHORT perp" ? "LONG" : "SHORT"} ${o.coin} spot → delta-neutral, net ~${o.netApr.toFixed(0)}% APR`);

// --- the REAL deployable edge: persistence-selected Binance/HL alts (from the funding history) ---
const { readFileSync, existsSync, readdirSync } = await import("node:fs");
const { resolve } = await import("node:path");
const fdir = resolve(process.cwd(), "data", "funding");
const altFiles = existsSync(fdir) ? readdirSync(fdir).filter((f) => f.endsWith(".binance.jsonl")) : [];
type Alt = { coin: string; side: string; persistence: number; meanApr: number; recentApr: number; n: number };
const alts: Alt[] = [];
for (const f of altFiles) {
  try {
    const rates = readFileSync(resolve(fdir, f), "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => (JSON.parse(l) as { rate: number }).rate);
    if (rates.length < 90) continue;
    const pos = rates.filter((r) => r > 0).length, persistence = Math.max(pos, rates.length - pos) / rates.length;
    const meanApr = (rates.reduce((a, r) => a + Math.abs(r), 0) / rates.length) * 3 * 365 * 100; // Binance 3/day
    const recent = rates.slice(-21), recentApr = (recent.reduce((a, r) => a + Math.abs(r), 0) / recent.length) * 3 * 365 * 100;
    alts.push({ coin: f.replace(".binance.jsonl", ""), side: pos > rates.length / 2 ? "SHORT perp" : "LONG perp", persistence, meanApr, recentApr, n: rates.length });
  } catch { /* */ }
}
alts.sort((a, b) => b.persistence * b.meanApr - a.persistence * a.meanApr);
console.log(`\n  Binance/HL PERSISTENCE ALTS (the deployable funding-carry edge — needs proxy perp + spot hedge):`);
console.log(`  ${"coin".padEnd(10)} ${"side".padEnd(11)} ${"persist".padEnd(8)} ${"meanAPR".padEnd(9)} recentAPR`);
for (const a of alts.slice(0, 8)) console.log(`    ${a.coin.padEnd(8)} ${a.side.padEnd(11)} ${`${(a.persistence * 100).toFixed(0)}%`.padEnd(8)} ${`${a.meanApr.toFixed(0)}%`.padEnd(9)} ${a.recentApr.toFixed(0)}%`);
console.log(`\n  RISK: funding can flip (persistence mitigates), perp-spot basis can widen (a squeeze is the tail), borrow/size limited.`);
console.log(`  Start tiny ($200-1k/name), confirm the hedge fills, then scale. This is YIELD, not a moonshot.\n`);
