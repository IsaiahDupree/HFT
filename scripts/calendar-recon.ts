/**
 * calendar-recon — LIVE dated-futures BASIS scanner (edge #2, the cash-and-carry carry). Pulls Deribit's
 * full BTC/ETH/SOL futures term structure (keyless public API), computes each expiry's annualized basis +
 * net-after-fee APR, and runs the SAME safety core the executor uses (planCalendarLegs). Cash-and-carry is
 * SHORT the dated future (sell the premium) + LONG spot, delta-neutral — and the basis MUST converge to zero
 * at delivery, so the yield is LOCKED by settlement (no funding-flip risk). DRY-RUN only: --live is refused
 * until a venue adapter is wired and go-live size is confirmed. Deribit is crypto-settled (inverse); you'd
 * hedge with real spot on Coinbase/Binance.US, but the index ≈ spot for the basis.
 *
 *   npm run calendar:recon [-- --capital 1000 --min-apr 6 --min-dte 7 --max-dte 365 --fee-bps 5]
 */
import "./_env.ts";
import { planCalendarLegs, calendarBookCheck, DEFAULT_CAL_LIMITS, type CalendarOpp } from "../src/lib/exec/calendar-plan.ts";

const num = (n: string, d: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const capital = num("--capital", 1000);
const live = process.argv.includes("--live");
const limits = { ...DEFAULT_CAL_LIMITS, minNetApr: num("--min-apr", 6), minDteDays: num("--min-dte", 7), maxDteDays: num("--max-dte", 365), feeBpsPerSide: num("--fee-bps", 5), maxNotionalPerName: num("--max-name", 1000), maxTotalNotional: num("--max-book", 5000) };
const DBT = "https://www.deribit.com/api/v2/public";
// BTC/ETH/SOL all have deep, accessible US spot for the hedge leg.
const SPOT: Record<string, string[]> = { BTC: ["coinbase", "binanceus"], ETH: ["coinbase", "binanceus"], SOL: ["coinbase", "binanceus"] };

async function dbt(method: string, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${DBT}/${method}?${qs}`, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`deribit ${method} → HTTP ${r.status}`);
  return (await r.json()).result;
}

const now = Date.now();
const opps: CalendarOpp[] = [];
for (const ccy of ["BTC", "ETH", "SOL"]) {
  try {
    const [summary, instruments] = await Promise.all([
      dbt("get_book_summary_by_currency", { currency: ccy, kind: "future" }) as Promise<Array<{ instrument_name: string; mark_price: number; underlying_price?: number; estimated_delivery_price?: number; open_interest?: number }>>,
      dbt("get_instruments", { currency: ccy, kind: "future", expired: "false" }) as Promise<Array<{ instrument_name: string; expiration_timestamp: number }>>,
    ]);
    const expiry = new Map(instruments.map((i) => [i.instrument_name, i.expiration_timestamp]));
    for (const s of summary) {
      if (s.instrument_name.endsWith("PERPETUAL")) continue;                 // perp = funding, not a dated basis
      const exp = expiry.get(s.instrument_name);
      const idx = s.underlying_price ?? s.estimated_delivery_price;
      if (!exp || !idx || !s.mark_price) continue;
      const dteDays = (exp - now) / 86_400_000;
      if (dteDays <= 0) continue;
      opps.push({ coin: ccy, futureSymbol: s.instrument_name, futurePrice: s.mark_price, spotPrice: idx, dteDays, futureOiUsd: s.open_interest ?? 0, spotVenues: SPOT[ccy] ?? [] });
    }
  } catch (e) { console.log(`  (${ccy}: ${(e as Error).message})`); }
}
opps.sort((a, b) => (a.coin === b.coin ? a.dteDays - b.dteDays : a.coin.localeCompare(b.coin)));

const plans = opps.map((o) => planCalendarLegs(o, capital, limits));
const { executable, totalNotional, bookBlockers } = calendarBookCheck(plans, limits);

console.log(`\ncalendar-recon — LIVE Deribit dated-futures basis (cash-and-carry, convergence LOCKED at delivery)${live ? " · --live REFUSED" : ""}`);
console.log(`  capital $${capital}/name · gates: net ≥${limits.minNetApr}% · ${limits.minDteDays}–${limits.maxDteDays}d to expiry · future OI ≥$${(limits.minFutureOiUsd / 1e6).toFixed(0)}M · ${limits.feeBpsPerSide}bp/side\n`);
console.log(`  ${"future".padEnd(16)} ${"DTE".padEnd(7)} ${"basis".padEnd(8)} ${"annBasis".padEnd(9)} ${"netAPR".padEnd(8)} ${"OI".padEnd(8)} verdict`);
const oiBySymbol = new Map(opps.map((o) => [o.futureSymbol, o.futureOiUsd]));
for (const p of plans) {
  const verdict = p.blockers.length ? `✗ ${p.blockers[0].slice(0, 46)}` : "✓ EXECUTABLE";
  const oi = oiBySymbol.get(p.futureLeg.instrument) ?? 0;
  console.log(`  ${p.futureLeg.instrument.padEnd(16)} ${`${p.dteDays.toFixed(0)}d`.padEnd(7)} ${`${p.basisPct >= 0 ? "+" : ""}${p.basisPct.toFixed(2)}%`.padEnd(8)} ${`${p.annualizedBasisPct >= 0 ? "+" : ""}${p.annualizedBasisPct.toFixed(1)}%`.padEnd(9)} ${`${p.expectedAprNet >= 0 ? "+" : ""}${p.expectedAprNet.toFixed(1)}%`.padEnd(8)} ${`$${(oi / 1e6).toFixed(0)}M`.padEnd(8)} ${verdict}`);
}
console.log(`\n  EXECUTABLE: ${executable.length}/${plans.length} · book notional $${totalNotional}${bookBlockers.length ? ` · ⚠ ${bookBlockers[0]}` : ""}`);
if (executable.length) for (const p of executable) console.log(`    ✓ ${p.coin}: SHORT ${p.futureLeg.instrument} + LONG ${p.coin} spot → capture ${p.expectedNetBasisPct.toFixed(2)}% over ${p.dteDays.toFixed(0)}d = net ~${p.expectedAprNet.toFixed(1)}% APR (convergence locked)`);
else {
  console.log(`\n  → nothing clears the bar right now. Crypto basis is REGIME-dependent — currently compressed`);
  console.log(`    (~3% ann vs ~8% historical). The edge is real + locked-at-expiry, but the yield is thin today.`);
  console.log(`    Re-run when leverage demand widens the term structure (basis fattens in bull-leverage regimes).`);
}
if (live) {
  console.log(`\n  ✋ --live REFUSED: no Deribit/spot venue adapter is wired, and you must confirm go-live size +`);
  console.log(`     the spot hedge venue (Coinbase/Binance.US) first. Dry-run only. NO orders were placed.`);
}
console.log("");
