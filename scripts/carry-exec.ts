/**
 * carry-exec — DRY-RUN funding-carry executor. Scans the persistence-alt opportunities, builds the
 * two-leg plan for each (planCarryLegs), runs every safety gate, and prints what it WOULD trade. It
 * does NOT place orders: --live is refused until a venue adapter is confirmed + wired. This exists to
 * make the execution reality concrete — including the honest gap that the fattest carries are on
 * coins with NO accessible spot to hedge, so the gates correctly refuse them.
 *
 *   npm run carry:exec                 # dry-run, default limits
 *   npm run carry:exec -- --capital 1000 --max-name 1000 --max-book 5000 --min-persist 0.7
 */
import "./_env.ts";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { planCarryLegs, bookSafetyCheck, DEFAULT_LIMITS, type CarryOpp, type SpotVenue } from "../src/lib/exec/carry-plan.ts";

const num = (n: string, d: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const capital = num("--capital", 1000);
const live = process.argv.includes("--live");
const limits = { ...DEFAULT_LIMITS, maxNotionalPerName: num("--max-name", 1000), maxTotalNotional: num("--max-book", 5000), minPersistence: num("--min-persist", 0.7), minNetApr: num("--min-apr", 15) };

// Assets with accessible US SPOT (Coinbase / Binance.US) — the hedge leg. Conservative majors list;
// the fat-funding alts (LAB/BEAT/AERGO/...) are NOT here → unhedgeable → the plan blocks them.
const SPOT_LISTED: Record<string, SpotVenue[]> = Object.fromEntries(
  ["BTC", "ETH", "SOL", "AVAX", "LINK", "DOGE", "ADA", "DOT", "LTC", "XRP", "ATOM", "AAVE", "COMP", "UNI", "MKR", "CRV", "LDO", "SNX", "ENA", "SEI", "TIA", "NEAR", "APT", "ARB", "OP", "SUI", "INJ", "FIL", "CHZ", "TRX", "DASH", "1000PEPE"].map((c) => [c, ["coinbase", "binanceus"] as SpotVenue[]]),
);

// ---- opportunities from the persistence-alt funding history (current = recent mean) ----
const fdir = resolve(process.cwd(), "data", "funding");
const files = existsSync(fdir) ? readdirSync(fdir).filter((f) => f.endsWith(".binance.jsonl")) : [];
const opps: CarryOpp[] = [];
for (const f of files) {
  const rates = readFileSync(resolve(fdir, f), "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => (JSON.parse(l) as { rate: number }).rate);
  if (rates.length < 90) continue;
  const coin = f.replace(".binance.jsonl", "");
  const pos = rates.filter((r) => r > 0).length, persistence = Math.max(pos, rates.length - pos) / rates.length;
  const recent = rates.slice(-21), meanHourlyEquiv = recent.reduce((a, r) => a + r, 0) / recent.length; // 8-hourly mean
  const fundingApr = meanHourlyEquiv * 3 * 365 * 100; // signed APR
  opps.push({ coin, fundingApr, persistence, perpVenue: "hyperliquid", spotVenues: SPOT_LISTED[coin] ?? [] });
}
opps.sort((a, b) => b.persistence * Math.abs(b.fundingApr) - a.persistence * Math.abs(a.fundingApr));

const plans = opps.slice(0, 12).map((o) => planCarryLegs(o, capital, limits));
const { executable, totalNotional, bookBlockers } = bookSafetyCheck(plans, limits);

console.log(`\ncarry-exec — DRY RUN${live ? " (--live REFUSED, see below)" : ""} · capital $${capital}/name · caps $${limits.maxNotionalPerName}/name $${limits.maxTotalNotional}/book\n`);
console.log(`  ${"coin".padEnd(8)} ${"plan".padEnd(28)} ${"net APR".padEnd(9)} verdict`);
for (const p of plans) {
  const plan = p.spotLeg ? `${p.perpLeg.positionSide} perp@${p.perpLeg.venue} + ${p.spotLeg.positionSide} spot@${p.spotLeg.venue}` : `${p.perpLeg.positionSide} perp@${p.perpLeg.venue} (UNHEDGEABLE)`;
  const verdict = p.blockers.length ? `✗ ${p.blockers[0].slice(0, 60)}` : "✓ EXECUTABLE";
  console.log(`  ${p.coin.padEnd(8)} ${plan.padEnd(28)} ${`${p.expectedAprNet >= 0 ? "+" : ""}${p.expectedAprNet.toFixed(0)}%`.padEnd(9)} ${verdict}`);
}
console.log(`\n  EXECUTABLE: ${executable.length}/${plans.length} plans · book notional $${totalNotional}${bookBlockers.length ? ` · ⚠ ${bookBlockers[0]}` : ""}`);
if (!executable.length) {
  console.log(`\n  → NOTHING executable right now — the honest venue gap:`);
  console.log(`    the FAT carries (LAB/BEAT/AERGO/...) have NO accessible US spot to hedge → blocked (won't run naked).`);
  console.log(`    the HEDGEABLE majors have funding too small/transient to clear the net-APR bar.`);
  console.log(`    To capture the fat alt carry you'd need spot on the SAME venue family (e.g. Hyperliquid spot / an alt-listing CEX).`);
}
if (live) {
  console.log(`\n  ✋ --live REFUSED: no venue adapter is wired yet, and you must confirm the perp venue (dYdX / Hyperliquid)`);
  console.log(`     + the spot hedge venue + go-live size first. Dry-run only until then. NO orders were placed.`);
}
console.log("");
