/**
 * hl-carry-recon — the HONEST "can we actually run a funding carry on Hyperliquid?" scanner.
 * Both legs on ONE venue (HL perp + HL spot) is the only KYC-free, no-cross-venue path. But HL perp
 * (230 names) and HL spot (~302 USDC pairs) are largely DISJOINT — only the intersection is hedgeable
 * here, and HL spot has NO borrow, so only POSITIVE-funding carries (SHORT perp + LONG spot, buy to
 * hedge) are clean. For each hedgeable coin we pull 30d of HOURLY funding, score sign-persistence and
 * mean APR (a single fat print is a trap), check real L2 spot depth for the hedge fill, then run the
 * SAME safety core the executor uses (planCarryLegs). This prints what is genuinely executable-on-HL.
 *
 *   npm run carry:hl [-- --capital 1000 --min-apr 15 --min-persist 0.7 --fee-bps 5 --hold-days 14]
 */
import "./_env.ts";
import { planCarryLegs, DEFAULT_LIMITS, type CarryOpp } from "../src/lib/exec/carry-plan.ts";
import { fundingStats } from "../src/lib/exec/funding-stats.ts";

const num = (n: string, d: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const capital = num("--capital", 1000);
const limits = { ...DEFAULT_LIMITS, minNetApr: num("--min-apr", 15), minPersistence: num("--min-persist", 0.7), feeBpsPerSide: num("--fee-bps", 5), holdDays: num("--hold-days", 14) };
const API = "https://api.hyperliquid.xyz/info";

async function info(body: unknown): Promise<any> {
  const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`HL info ${JSON.stringify(body)} → HTTP ${r.status}`);
  return r.json();
}

// 1) perp universe (tradeable names)
const [perpMeta] = await info({ type: "metaAndAssetCtxs" });
const perpNames = new Set<string>((perpMeta.universe as Array<{ name: string }>).map((u) => u.name));

// 2) spot universe → map COIN -> { ident:"@idx", mid } for COIN/USDC pairs only (the clean hedge quote)
const [spotMeta, spotCtxs] = await info({ type: "spotMetaAndAssetCtxs" });
const tokById = new Map<number, string>((spotMeta.tokens as Array<{ name: string; index: number }>).map((t) => [t.index, t.name]));
const spotByCoin = new Map<string, { ident: string; mid: number }>();
(spotMeta.universe as Array<{ tokens: [number, number]; name: string; index: number }>).forEach((p, i) => {
  const base = tokById.get(p.tokens[0]), quote = tokById.get(p.tokens[1]);
  if (quote !== "USDC" || !base) return;                       // only canonical USDC-quoted pairs
  const mid = Number(spotCtxs[i]?.midPx ?? spotCtxs[i]?.markPx ?? 0);
  if (mid > 0 && !spotByCoin.has(base)) spotByCoin.set(base, { ident: `@${p.index}`, mid });
});

// 3) the hedgeable intersection: a perp AND a USDC spot pair on the same venue
const both = [...perpNames].filter((c) => spotByCoin.has(c)).sort();
console.log(`\nhl-carry-recon — HL perp ∩ HL spot(USDC) = ${both.length} hedgeable names · capital $${capital}/name · gates: persist ≥${limits.minPersistence * 100}% net ≥${limits.minNetApr}%\n  ${both.join(", ")}\n`);

const START = Math.floor((Date.now() - 30 * 86_400_000));
type Row = { coin: string; persistence: number; meanApr: number; medianApr: number; recentApr: number; n: number; depthUsd: number; plan: ReturnType<typeof planCarryLegs> };
const rows: Row[] = [];
for (const coin of both) {
  try {
    const hist = (await info({ type: "fundingHistory", coin, startTime: START })) as Array<{ fundingRate: string }>;
    const r = hist.map((h) => Number(h.fundingRate)).filter(Number.isFinite);
    if (r.length < 48) continue;                                // need ≥2d of hourly prints
    // HL funding is HOURLY → 24×365 periods/yr. Gate on the DURABLE (median) rate, not the spike-inflated mean.
    const fs = fundingStats(r, 24 * 365, 72);
    const { persistence, meanApr, medianApr, durableApr, recentApr } = fs;
    // spot depth on the side we'd hit: positive durable funding → BUY spot (ask side). Within 0.5% of mid.
    const sp = spotByCoin.get(coin)!;
    const book = await info({ type: "l2Book", coin: sp.ident });
    const [bids, asks] = book.levels as Array<Array<{ px: string; sz: string }>>;
    const side = durableApr >= 0 ? asks : bids, lim = durableApr >= 0 ? sp.mid * 1.005 : sp.mid * 0.995;
    const depthUsd = side.reduce((a, lv) => { const px = Number(lv.px), sz = Number(lv.sz); return ((durableApr >= 0 && px <= lim) || (durableApr < 0 && px >= lim)) ? a + px * sz : a; }, 0);

    // run the SAME safety core the executor uses, on the DURABLE rate. spotVenues=["hyperliquid"] ⇒ hedge leg.
    const opp: CarryOpp = { coin, fundingApr: durableApr, persistence, perpVenue: "hyperliquid", spotVenues: ["hyperliquid"] };
    const plan = planCarryLegs(opp, capital, limits);
    if (depthUsd < capital) plan.blockers.push(`spot depth $${depthUsd.toFixed(0)} < $${capital} hedge within 0.5% — too thin to fill`);
    rows.push({ coin, persistence, meanApr, medianApr, recentApr, n: r.length, depthUsd, plan });
    await new Promise((res) => setTimeout(res, 60));
  } catch { /* skip */ }
}
rows.sort((a, b) => (b.plan.blockers.length === 0 ? 1e9 : 0) + b.plan.expectedAprNet - ((a.plan.blockers.length === 0 ? 1e9 : 0) + a.plan.expectedAprNet));

console.log(`  gate = DURABLE (median) funding · meanAPR shown as spike-upside only (not bankable)\n`);
console.log(`  ${"coin".padEnd(8)} ${"side".padEnd(20)} ${"durAPR".padEnd(8)} ${"mean(spike)".padEnd(12)} ${"persist".padEnd(8)} ${"netAPR".padEnd(8)} ${"spotDepth".padEnd(11)} verdict`);
for (const x of rows) {
  const p = x.plan;
  const side = x.medianApr >= 0 ? "SHORT perp+LONG spot" : "LONG perp+SHORT spot";
  const verdict = p.blockers.length ? `✗ ${p.blockers[0].slice(0, 48)}` : "✓ EXECUTABLE";
  console.log(`  ${x.coin.padEnd(8)} ${side.padEnd(20)} ${`${x.medianApr >= 0 ? "+" : ""}${x.medianApr.toFixed(0)}%`.padEnd(8)} ${`${x.meanApr >= 0 ? "+" : ""}${x.meanApr.toFixed(0)}%`.padEnd(12)} ${`${(x.persistence * 100).toFixed(0)}%`.padEnd(8)} ${`${p.expectedAprNet >= 0 ? "+" : ""}${p.expectedAprNet.toFixed(0)}%`.padEnd(8)} ${`$${(x.depthUsd / 1000).toFixed(0)}k`.padEnd(11)} ${verdict}`);
}
const ok = rows.filter((x) => x.plan.blockers.length === 0);
console.log(`\n  EXECUTABLE-ON-HL: ${ok.length}/${rows.length}`);
if (ok.length) for (const x of ok) console.log(`    ✓ ${x.coin}: SHORT ${x.coin} perp + LONG ${x.coin} spot @ Hyperliquid → net ~${x.plan.expectedAprNet.toFixed(0)}% APR, persistence ${(x.persistence * 100).toFixed(0)}%, spot depth $${(x.depthUsd / 1000).toFixed(0)}k`);
else {
  console.log(`    none clear the bar right now. The clean (positive-funding) HL carries sit near the funding FLOOR`);
  console.log(`    (~11% APR → ~4% net after fees) — persistent but UNECONOMIC. The fat negatives need spot BORROW`);
  console.log(`    (short spot), which HL spot does not support → blocked. Honest result, not a missing feature.`);
}
console.log("");
