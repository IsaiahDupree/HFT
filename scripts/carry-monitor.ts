/**
 * carry-monitor — the standing watcher. Each run polls the live carry surface (Hyperliquid both-legs,
 * dYdX funding, Deribit dated-futures basis), runs every candidate through the SAME executor safety cores
 * (planCarryLegs / planCalendarLegs), maps each to a trigger state (off/watch/armed), and PERSISTS a
 * snapshot row per candidate to a LOCAL SQLite DB on the My Passport drive. When a candidate ESCALATES
 * (off→watch→armed) it writes an alert row + prints it loudly. Run hourly via launchd → you get told the
 * moment a carry crosses its deploy trigger, without watching screens. Dry-run intelligence only; places
 * no orders. Today's expected state: everything "off" (HYPE at the funding floor, basis below T-bills).
 *
 *   npm run carry:monitor              # poll, persist, report
 *   npm run carry:monitor -- --show    # print recent alerts + snapshot count, no new poll
 */
import "./_env.ts";
import { fundingStats } from "../src/lib/exec/funding-stats.ts";
import { planCarryLegs, type CarryOpp } from "../src/lib/exec/carry-plan.ts";
import { planCalendarLegs, type CalendarOpp } from "../src/lib/exec/calendar-plan.ts";
import { triggerState, isEscalation, FUNDING_TRIGGER, CALENDAR_TRIGGER, type TriggerState } from "../src/lib/exec/carry-triggers.ts";
import { openCarryDb, resolveCarryDbPath, insertSnapshot, insertAlert, lastStateFor, recentAlerts, snapshotCount } from "../src/lib/exec/carry-monitor-db.ts";

const show = process.argv.includes("--show");
const HL = "https://api.hyperliquid.xyz/info";
const IDX = "https://indexer.dydx.trade/v4";
const DBT = "https://www.deribit.com/api/v2/public";
const US_SPOT = ["coinbase", "binanceus"];
async function jget(url: string, opts: RequestInit = {}): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000), ...opts });
  if (!r.ok) throw new Error(`${url.slice(0, 60)} → HTTP ${r.status}`);
  return r.json();
}
const hl = (body: unknown) => jget(HL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

type Cand = { strategy: "funding" | "calendar"; venue: string; candidate: string; grossApr: number; netApr: number; persistence: number | null; basisBps: number | null; depthUsd: number | null; executable: boolean; raw: unknown };

// ---- Hyperliquid both-legs funding candidates (the only KYC-free real carry surface) ----
async function collectHL(): Promise<Cand[]> {
  const out: Cand[] = [];
  try {
    const [perpMeta, perpCtxs] = await hl({ type: "metaAndAssetCtxs" });
    const perpMark = new Map<string, number>();
    (perpMeta.universe as Array<{ name: string }>).forEach((u, i) => { const m = Number(perpCtxs[i]?.markPx ?? 0); if (m > 0) perpMark.set(u.name, m); });
    const [spotMeta, spotCtxs] = await hl({ type: "spotMetaAndAssetCtxs" });
    const tok = new Map<number, string>((spotMeta.tokens as Array<{ name: string; index: number }>).map((t) => [t.index, t.name]));
    const spotByTok = new Map<string, { ident: string; dayVol: number }>();
    (spotMeta.universe as Array<{ tokens: [number, number]; index: number }>).forEach((p) => {
      const base = tok.get(p.tokens[0]), quote = tok.get(p.tokens[1]); if (quote !== "USDC" || !base) return;
      const dayVol = Number(spotCtxs[p.index]?.dayNtlVlm ?? 0);
      const prev = spotByTok.get(base); if (!prev || dayVol > prev.dayVol) spotByTok.set(base, { ident: `@${p.index}`, dayVol });
    });
    const matches: Array<{ coin: string; ident: string; dayVol: number; mult: number }> = [];
    for (const u of perpMeta.universe as Array<{ name: string }>) {
      const P = u.name;
      for (const c of [{ t: P, m: 1 }, { t: `U${P}`, m: 1 }, ...(P.startsWith("k") ? [{ t: P.slice(1), m: 1000 }] : [])]) {
        const s = spotByTok.get(c.t); if (s) { matches.push({ coin: P, ident: s.ident, dayVol: s.dayVol, mult: c.m }); break; }
      }
    }
    const START = Math.floor(Date.now() - 30 * 86_400_000);
    for (const m of matches) {
      try {
        const hist = (await hl({ type: "fundingHistory", coin: m.coin, startTime: START })) as Array<{ fundingRate: string }>;
        const r = hist.map((h) => Number(h.fundingRate)).filter(Number.isFinite); if (r.length < 48) continue;
        const fs = fundingStats(r, 24 * 365, 72);
        const book = await hl({ type: "l2Book", coin: m.ident });
        const lv = book?.levels as Array<Array<{ px: string; sz: string }>> | undefined;
        const bids = lv?.[0] ?? [], asks = lv?.[1] ?? []; if (!bids.length || !asks.length) continue;
        const mid = (Number(bids[0].px) + Number(asks[0].px)) / 2;
        const buy = fs.durableApr >= 0, side = buy ? asks : bids, lim = buy ? mid * 1.005 : mid * 0.995;
        const depthUsd = side.reduce((a, l) => { const px = Number(l.px), sz = Number(l.sz); return ((buy && px <= lim) || (!buy && px >= lim)) ? a + px * sz : a; }, 0);
        const basisBps = mid > 0 ? Math.abs((perpMark.get(m.coin) ?? 0) / m.mult - mid) / mid * 1e4 : Infinity;
        const opp: CarryOpp = { coin: m.coin, fundingApr: fs.durableApr, persistence: fs.persistence, perpVenue: "hyperliquid", spotVenues: ["hyperliquid"] };
        const plan = planCarryLegs(opp, 1000);
        const blockers = [...plan.blockers];
        if (basisBps > 50) blockers.push("basis fiction");
        if (m.dayVol < 50_000) blockers.push("illiquid spot");
        if (depthUsd < 1000) blockers.push("thin depth");
        out.push({ strategy: "funding", venue: "hyperliquid", candidate: m.coin, grossApr: fs.durableApr, netApr: plan.expectedAprNet, persistence: fs.persistence, basisBps, depthUsd, executable: blockers.length === 0, raw: { meanApr: fs.meanApr, dayVol: m.dayVol, blockers } });
        await new Promise((r) => setTimeout(r, 40));
      } catch { /* skip name */ }
    }
  } catch (e) { console.error(`  [HL] ${(e as Error).message}`); }
  return out;
}

// ---- dYdX funding candidates (top by |current funding|, durable-gated, hedgeable majors) ----
const HEDGEABLE = new Set(["BTC", "ETH", "SOL", "AVAX", "LINK", "DOGE", "ADA", "DOT", "LTC", "XRP", "ATOM", "AAVE", "UNI", "MKR", "CRV", "LDO", "ENA", "SEI", "TIA", "NEAR", "APT", "ARB", "OP", "SUI", "INJ", "FIL", "BCH"]);
async function collectDydx(): Promise<Cand[]> {
  const out: Cand[] = [];
  try {
    const markets = (await jget(`${IDX}/perpetualMarkets`, { headers: { "User-Agent": "Mozilla/5.0" } })).markets as Record<string, { nextFundingRate?: string; openInterest?: string; oraclePrice?: string }>;
    const top = Object.entries(markets).map(([t, m]) => ({ coin: t.replace("-USD", ""), ticker: t, hourly: m.nextFundingRate != null ? +m.nextFundingRate : NaN, oi: +(m.openInterest ?? 0) * +(m.oraclePrice ?? 0) }))
      .filter((x) => Number.isFinite(x.hourly) && x.oi > 1e6).sort((a, b) => Math.abs(b.hourly) - Math.abs(a.hourly)).slice(0, 18);
    for (const x of top) {
      try {
        const hist = (await jget(`${IDX}/historicalFunding/${x.ticker}?limit=168`, { headers: { "User-Agent": "Mozilla/5.0" } })).historicalFunding as Array<{ rate: string }>;
        const r = hist.map((h) => +h.rate).filter(Number.isFinite); if (r.length < 24) continue;
        const fs = fundingStats(r, 24 * 365, 24);
        const spotVenues = HEDGEABLE.has(x.coin) ? US_SPOT : [];
        const opp: CarryOpp = { coin: x.coin, fundingApr: fs.durableApr, persistence: fs.persistence, perpVenue: "dydx", spotVenues };
        const plan = planCarryLegs(opp, 1000);
        out.push({ strategy: "funding", venue: "dydx", candidate: x.coin, grossApr: fs.durableApr, netApr: plan.expectedAprNet, persistence: fs.persistence, basisBps: null, depthUsd: null, executable: plan.blockers.length === 0, raw: { meanApr: fs.meanApr, oiUsd: x.oi, blockers: plan.blockers } });
        await new Promise((r) => setTimeout(r, 50));
      } catch { /* skip */ }
    }
  } catch (e) { console.error(`  [dYdX] ${(e as Error).message}`); }
  return out;
}

// ---- Deribit calendar-basis candidates (BTC/ETH term structure) ----
async function collectDeribit(): Promise<Cand[]> {
  const out: Cand[] = []; const now = Date.now();
  for (const ccy of ["BTC", "ETH"]) {
    try {
      const [sum, inst] = await Promise.all([
        jget(`${DBT}/get_book_summary_by_currency?currency=${ccy}&kind=future`).then((d) => d.result as Array<{ instrument_name: string; mark_price: number; underlying_price?: number; estimated_delivery_price?: number; open_interest?: number }>),
        jget(`${DBT}/get_instruments?currency=${ccy}&kind=future&expired=false`).then((d) => d.result as Array<{ instrument_name: string; expiration_timestamp: number }>),
      ]);
      const exp = new Map(inst.map((i) => [i.instrument_name, i.expiration_timestamp]));
      for (const s of sum) {
        if (s.instrument_name.endsWith("PERPETUAL")) continue;
        const e = exp.get(s.instrument_name), idx = s.underlying_price ?? s.estimated_delivery_price; if (!e || !idx || !s.mark_price) continue;
        const dteDays = (e - now) / 86_400_000;
        if (dteDays < 7) continue;   // skip near-expiry: annualizing a near-zero basis over a few days explodes (artifact, not signal)
        const opp: CalendarOpp = { coin: ccy, futureSymbol: s.instrument_name, futurePrice: s.mark_price, spotPrice: idx, dteDays, futureOiUsd: s.open_interest ?? 0, spotVenues: US_SPOT };
        const plan = planCalendarLegs(opp, 1000);
        out.push({ strategy: "calendar", venue: "deribit", candidate: s.instrument_name, grossApr: plan.annualizedBasisPct, netApr: plan.expectedAprNet, persistence: null, basisBps: plan.basisPct * 100, depthUsd: s.open_interest ?? 0, executable: plan.blockers.length === 0, raw: { dteDays, blockers: plan.blockers } });
      }
    } catch (e) { console.error(`  [Deribit ${ccy}] ${(e as Error).message}`); }
  }
  return out;
}

// ---- main ----
const db = openCarryDb();
if (show) {
  console.log(`\ncarry-monitor — DB ${resolveCarryDbPath()} · ${snapshotCount(db)} snapshots logged\n`);
  const alerts = recentAlerts(db, 15);
  if (!alerts.length) console.log("  no escalation alerts yet (nothing has crossed a trigger).");
  for (const a of alerts) console.log(`  ⚑ ${a.iso}  ${a.strategy}/${a.candidate}  ${a.prevState ?? "—"}→${a.newState}  gross ${a.grossApr.toFixed(1)}%  ${a.message}`);
  console.log("");
  db.close();
} else {
  const ts = Math.floor(Date.now() / 1000), iso = new Date().toISOString();
  const cands = (await Promise.all([collectHL(), collectDydx(), collectDeribit()])).flat();
  const byState: Record<TriggerState, number> = { off: 0, watch: 0, armed: 0 };
  const escalations: string[] = [];
  for (const c of cands) {
    const cfg = c.strategy === "funding" ? FUNDING_TRIGGER : CALENDAR_TRIGGER;
    const { state, reason } = triggerState(c.grossApr, c.executable, cfg);
    byState[state]++;
    const prev = lastStateFor(db, c.strategy, c.candidate);
    if (isEscalation(prev, state)) {
      const msg = `${c.candidate} ${prev ?? "new"}→${state}: ${reason}`;
      insertAlert(db, { ts, iso, strategy: c.strategy, candidate: c.candidate, prevState: prev, newState: state, grossApr: c.grossApr, netApr: c.netApr, message: reason });
      escalations.push(`${state === "armed" ? "🟢 ARMED" : "🟡 WATCH"} ${c.strategy}/${c.candidate} gross ${Math.abs(c.grossApr).toFixed(1)}% net ${c.netApr.toFixed(1)}% — ${msg}`);
    }
    insertSnapshot(db, { ts, iso, strategy: c.strategy, venue: c.venue, candidate: c.candidate, grossApr: c.grossApr, netApr: c.netApr, persistence: c.persistence, basisBps: c.basisBps, depthUsd: c.depthUsd, executable: c.executable, state, reason, raw: c.raw });
  }
  // report
  const fattest = [...cands].sort((a, b) => Math.abs(b.grossApr) - Math.abs(a.grossApr)).slice(0, 6);
  console.log(`\ncarry-monitor ${iso} · ${cands.length} candidates · off ${byState.off} / watch ${byState.watch} / armed ${byState.armed} · DB ${resolveCarryDbPath()}`);
  console.log(`  fattest (gross APR):`);
  for (const c of fattest) console.log(`    ${c.strategy.padEnd(9)} ${c.venue.padEnd(11)} ${c.candidate.padEnd(14)} gross ${`${c.grossApr >= 0 ? "+" : ""}${c.grossApr.toFixed(1)}%`.padEnd(8)} net ${`${c.netApr.toFixed(1)}%`.padEnd(8)} ${c.executable ? "executable" : "blocked"}`);
  if (escalations.length) { console.log(`\n  🔔 ${escalations.length} ESCALATION(S):`); for (const e of escalations) console.log(`    ${e}`); }
  else console.log(`\n  no escalations — all candidates ≤ their prior state (expected: regime still thin).`);
  console.log("");
  db.close();
}
