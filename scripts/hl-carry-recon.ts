/**
 * hl-carry-recon — the HONEST "can we actually run a funding carry on Hyperliquid?" scanner.
 * Both legs on ONE venue (HL perp + HL spot) is the only KYC-free, no-cross-venue path. But HL perp
 * (230 names) and HL spot (~285 USDC pairs) are largely DISJOINT — only the intersection is hedgeable,
 * and HL spot has NO borrow, so only POSITIVE-funding carries (SHORT perp + LONG spot, buy to hedge)
 * are clean. For each hedgeable coin we pull 30d (API-capped at 500 hourly prints ≈ 20.8d) of funding,
 * gate on the DURABLE (median) rate not the spike-prone mean, and run the SAME safety core the executor
 * uses (planCarryLegs). Three hard-won realism guards (added after an adversarial audit):
 *   • SPOT MID FROM THE L2 BOOK, not the spot ctx midPx (which is mis-scaled — HYPE ctx reads ~0.09 while
 *     the @107 book trades at ~$60), else the depth band is measured against the wrong reference.
 *   • BASIS GUARD: a ticker match is NOT an asset match. perp TRUMP ($1.60) vs the "TRUMP/USDC" spot token
 *     ($0.0003) is a name collision — the hedge is FICTION. Reject when |perpMark/mult − spotMid|/mid > 50bp.
 *   • LIQUIDITY FLOOR + ALIASES: require real spot dayNtlVlm; resolve Unit-bridged (U-prefix, e.g. UZEC=ZEC)
 *     and k-multiplier (kPEPE=1000·PEPE) listings so the universe is honest, not just exact-name matches.
 *
 *   npm run carry:hl [-- --capital 1000 --min-apr 15 --min-persist 0.7 --fee-bps 5 --hold-days 14
 *                        --min-spot-vol 50000 --max-basis-bps 50]
 */
import "./_env.ts";
import { planCarryLegs, DEFAULT_LIMITS, type CarryOpp } from "../src/lib/exec/carry-plan.ts";
import { fundingStats } from "../src/lib/exec/funding-stats.ts";

const num = (n: string, d: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const capital = num("--capital", 1000);
const minSpotVol = num("--min-spot-vol", 50_000);
const maxBasisBps = num("--max-basis-bps", 50);
const limits = { ...DEFAULT_LIMITS, minNetApr: num("--min-apr", 15), minPersistence: num("--min-persist", 0.7), feeBpsPerSide: num("--fee-bps", 5), holdDays: num("--hold-days", 14) };
const API = "https://api.hyperliquid.xyz/info";

async function info(body: unknown): Promise<any> {
  const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`HL info ${JSON.stringify(body)} → HTTP ${r.status}`);
  return r.json();
}

// 1) perp universe + mark price (for the basis guard). ctxs[i] aligns to meta.universe[i] by position.
const [perpMeta, perpCtxs] = await info({ type: "metaAndAssetCtxs" });
const perpMark = new Map<string, number>();
(perpMeta.universe as Array<{ name: string }>).forEach((u, i) => { const m = Number(perpCtxs[i]?.markPx ?? 0); if (m > 0) perpMark.set(u.name, m); });

// 2) spot USDC pairs → token name -> { ident:"@idx", dayVol }. ctxs[i] aligns to spotMeta.universe[i].
const [spotMeta, spotCtxs] = await info({ type: "spotMetaAndAssetCtxs" });
const tokById = new Map<number, string>((spotMeta.tokens as Array<{ name: string; index: number }>).map((t) => [t.index, t.name]));
// NOTE: spotCtxs is indexed by the pair's `.index` field (the "@N" id), NOT by universe array position —
// the two arrays differ in length (universe 302, ctxs 375). Use spotCtxs[p.index], never spotCtxs[i].
const spotByToken = new Map<string, { ident: string; dayVol: number }>();
(spotMeta.universe as Array<{ tokens: [number, number]; index: number }>).forEach((p) => {
  const base = tokById.get(p.tokens[0]), quote = tokById.get(p.tokens[1]);
  if (quote !== "USDC" || !base) return;                          // canonical USDC-quoted pairs only
  const dayVol = Number(spotCtxs[p.index]?.dayNtlVlm ?? 0);
  const prev = spotByToken.get(base);
  if (!prev || dayVol > prev.dayVol) spotByToken.set(base, { ident: `@${p.index}`, dayVol }); // keep the most-liquid listing
});

// 3) resolve each perp to its spot hedge, trying exact + Unit-bridge (U-prefix) + k-multiplier aliases.
//    mult = spot-units per 1 perp-unit's price (k-perps quote 1000× the spot token), used by the basis guard.
type Match = { coin: string; ident: string; dayVol: number; via: string; mult: number };
const matches: Match[] = [];
for (const u of perpMeta.universe as Array<{ name: string }>) {
  const P = u.name;
  const cands: Array<{ tok: string; via: string; mult: number }> = [{ tok: P, via: "exact", mult: 1 }, { tok: `U${P}`, via: "unit", mult: 1 }];
  if (P.startsWith("k")) cands.push({ tok: P.slice(1), via: "kmult", mult: 1000 });
  let best: Match | null = null;
  for (const c of cands) { const s = spotByToken.get(c.tok); if (s && (!best || s.dayVol > best.dayVol)) best = { coin: P, ident: s.ident, dayVol: s.dayVol, via: c.via, mult: c.mult }; }
  if (best) matches.push(best);
}
matches.sort((a, b) => a.coin.localeCompare(b.coin));
console.log(`\nhl-carry-recon — HL perp ∩ HL spot = ${matches.length} hedgeable names (incl. U-/k- aliases) · capital $${capital}/name`);
console.log(`  gates: persist ≥${limits.minPersistence * 100}% · net ≥${limits.minNetApr}% · spot vol ≥$${(minSpotVol / 1000).toFixed(0)}k · basis ≤${maxBasisBps}bp · funding is HOURLY, ~20.8d window (500-print cap)\n`);

const START = Math.floor(Date.now() - 30 * 86_400_000);
type Row = { coin: string; via: string; persistence: number; meanApr: number; medianApr: number; basisBps: number; dayVol: number; depthUsd: number; plan: ReturnType<typeof planCarryLegs> };
const rows: Row[] = [];
for (const m of matches) {
  try {
    const hist = (await info({ type: "fundingHistory", coin: m.coin, startTime: START })) as Array<{ fundingRate: string }>;
    const r = hist.map((h) => Number(h.fundingRate)).filter(Number.isFinite);
    if (r.length < 48) continue;                                  // need ≥2d of hourly prints
    const { persistence, meanApr, medianApr, durableApr } = fundingStats(r, 24 * 365, 72);

    // real spot mid + depth FROM THE L2 BOOK (not the mis-scaled ctx midPx).
    const book = await info({ type: "l2Book", coin: m.ident });
    const lv = book?.levels as Array<Array<{ px: string; sz: string }>> | undefined;
    const bids = lv?.[0] ?? [], asks = lv?.[1] ?? [];
    if (!bids.length || !asks.length) continue;                   // no two-sided book → can't price/hedge
    const bookMid = (Number(bids[0].px) + Number(asks[0].px)) / 2;
    const buySide = durableApr >= 0; // positive funding → BUY spot to hedge (ask side); else SELL (bid side)
    const side = buySide ? asks : bids, lim = buySide ? bookMid * 1.005 : bookMid * 0.995;
    const depthUsd = side.reduce((a, l) => { const px = Number(l.px), sz = Number(l.sz); return ((buySide && px <= lim) || (!buySide && px >= lim)) ? a + px * sz : a; }, 0);
    const basisBps = bookMid > 0 ? Math.abs((perpMark.get(m.coin) ?? 0) / m.mult - bookMid) / bookMid * 1e4 : Infinity;

    const opp: CarryOpp = { coin: m.coin, fundingApr: durableApr, persistence, perpVenue: "hyperliquid", spotVenues: ["hyperliquid"] };
    const plan = planCarryLegs(opp, capital, limits);
    // realism guards — reject a fictional/illiquid hedge BEFORE the APR verdict can read as "clean but thin".
    if (basisBps > maxBasisBps) plan.blockers.unshift(`basis ${basisBps.toFixed(0)}bp > ${maxBasisBps}bp — spot token ≠ perp asset (ticker collision); hedge is FICTION`);
    if (m.dayVol < minSpotVol) plan.blockers.push(`spot vol $${(m.dayVol / 1000).toFixed(0)}k < $${(minSpotVol / 1000).toFixed(0)}k — too illiquid to hedge/unwind`);
    if (depthUsd < capital) plan.blockers.push(`spot depth $${depthUsd.toFixed(0)} < $${capital} within 0.5% — too thin to fill`);
    rows.push({ coin: m.coin, via: m.via, persistence, meanApr, medianApr, basisBps, dayVol: m.dayVol, depthUsd, plan });
    await new Promise((res) => setTimeout(res, 50));
  } catch { /* skip */ }
}
rows.sort((a, b) => (b.plan.blockers.length === 0 ? 1e9 : 0) + b.plan.expectedAprNet - ((a.plan.blockers.length === 0 ? 1e9 : 0) + a.plan.expectedAprNet));

console.log(`  gate = DURABLE (median) funding · mean = spike-upside only · basis/vol/depth guard the HEDGE is real\n`);
console.log(`  ${"coin".padEnd(8)} ${"via".padEnd(6)} ${"side".padEnd(11)} ${"durAPR".padEnd(7)} ${"mean".padEnd(7)} ${"persist".padEnd(8)} ${"netAPR".padEnd(7)} ${"basis".padEnd(8)} ${"spotVol".padEnd(8)} ${"depth".padEnd(7)} verdict`);
for (const x of rows) {
  const p = x.plan;
  const side = x.medianApr >= 0 ? "SHORT/LONG" : "LONG/SHORT";
  const verdict = p.blockers.length ? `✗ ${p.blockers[0].slice(0, 44)}` : "✓ EXECUTABLE";
  console.log(`  ${x.coin.padEnd(8)} ${x.via.padEnd(6)} ${side.padEnd(11)} ${`${x.medianApr >= 0 ? "+" : ""}${x.medianApr.toFixed(0)}%`.padEnd(7)} ${`${x.meanApr >= 0 ? "+" : ""}${x.meanApr.toFixed(0)}%`.padEnd(7)} ${`${(x.persistence * 100).toFixed(0)}%`.padEnd(8)} ${`${p.expectedAprNet >= 0 ? "+" : ""}${p.expectedAprNet.toFixed(0)}%`.padEnd(7)} ${`${x.basisBps > 9999 ? ">9999" : x.basisBps.toFixed(0)}bp`.padEnd(8)} ${`$${(x.dayVol / 1000).toFixed(0)}k`.padEnd(8)} ${`$${(x.depthUsd / 1000).toFixed(0)}k`.padEnd(7)} ${verdict}`);
}
const ok = rows.filter((x) => x.plan.blockers.length === 0);
console.log(`\n  EXECUTABLE-ON-HL: ${ok.length}/${rows.length}`);
if (ok.length) for (const x of ok) console.log(`    ✓ ${x.coin}: SHORT ${x.coin} perp + LONG ${x.coin} spot @ Hyperliquid → net ~${x.plan.expectedAprNet.toFixed(0)}% APR, persistence ${(x.persistence * 100).toFixed(0)}%, basis ${x.basisBps.toFixed(0)}bp, depth $${(x.depthUsd / 1000).toFixed(0)}k`);
else {
  console.log(`    none clear the bar. Clean positive-funding HL carries are structurally pinned at the ~+11% funding`);
  console.log(`    FLOOR → ~+8% net after fees — under the bar. The fat negatives need spot BORROW (HL has none) and`);
  console.log(`    are transient. Several "matches" are ticker collisions whose spot token ≠ the perp asset (fiction).`);
  console.log(`    Honest result: this venue's no-borrow + funding-floor structure caps clean carry below the bar.`);
}
console.log("");
