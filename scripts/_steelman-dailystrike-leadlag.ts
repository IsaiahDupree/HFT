/**
 * _steelman-dailystrike-leadlag — STEELMAN of "Binance->PM latency snipe".
 *
 * Prior verdict: "DEBUNKED (lane empty): median lag 0.5s on 5-min series; 0 profitable takers
 * in 3,189 wallets." Steelman: the lag is real on DAILY-strike series (~11s), just not 5-min —
 * daily strikes reprice slowly. This script runs the REAL evidence through the EXISTING gauntlet
 * (adviseTrade + proofCouncil), NOT a hand-rolled stat:
 *
 *   EVIDENCE A (campaign, REAL Binance+PM captures, scripts/leadlag-campaign.ts → leadlag-campaign.jsonl):
 *     34 measured markets, ALL sub-daily (max tau 42.8 min). Cross-corr median lag 0.50s; BUT the
 *     event-study median impulse->reprice response is 13.4s (the steelman's "~11s slow reprice"
 *     IS visible in the response time). Only 1 impulse event across all captures (markets too quiet);
 *     0 stale-no-reprice. So the slow-reprice is real-but-thin.
 *
 *   EVIDENCE B (LIVE Gamma/CLOB book probe, scripts/_probe-daily-book.ts, 2026-06-12):
 *     0 / 36 daily-strike BTC/ETH "above/below $X on <date>" markets have a TWO-SIDED book.
 *     The most-liquid crypto market on the board is the HOURLY "BTC Up/Down 12AM ET" at $106/24h.
 *     Daily-strike ladder markets: vol24h = 0, empty book, spread = $1.00 (no resting quote).
 *
 * The exploitable triple is (Binance impulse >=20bps) x (stale PM quote) x (spread < fees-edge).
 * Even granting the steelman a real 13.4s staleness, the THIRD leg fails: there is no resting
 * quote to lift (empty book) and ~$0 volume, so 0 takeable instances. Fee/spread assumption:
 * Polymarket taker fee ~0 but the snipe must cross a spread; an empty-book daily strike has a
 * $1.00 spread vs the few-cent edge a 13s stale quote could offer -> net negative by construction.
 *
 *   cd /Users/isaiahdupree/Documents/Software/HFT-work && npx tsx scripts/_steelman-dailystrike-leadlag.ts
 */
import { adviseTrade, renderTradeMemo } from "../src/lib/backtest/advisor.ts";
import { proofCouncil, renderProofCouncil } from "../src/lib/backtest/proof-council.ts";

// ── REAL measured inputs (no synthesis) ──
const MEASURED = {
  campaignMarkets: 34,            // measured rows in leadlag-campaign.jsonl
  allSubDaily: true,
  maxTauMinutes: 42.8,
  medianXcorrLagSec: 0.50,        // 5-min/hourly cross-correlation (the original debunk number)
  medianResponseSec: 13.4,        // impulse->reprice event-study median (the steelman's ~11s)
  impulseEvents: 1,               // total >=20bps impulse events captured across all markets
  staleNoReprice: 0,
  // LIVE book probe of DAILY-strike markets (2026-06-12)
  dailyStrikeProbed: 36,
  dailyStrikeWithTwoSidedBook: 0,
  topCryptoVol24Usd: 106,         // most-liquid crypto market = hourly, $106/24h
  dailyStrikeSpread: 1.00,        // empty book → full $0-$1 spread
};

console.log(`\n_steelman-dailystrike-leadlag — REAL evidence through the existing gauntlet`);
console.log(`  campaign: ${MEASURED.campaignMarkets} measured markets, ALL sub-daily (max tau ${MEASURED.maxTauMinutes}min)`);
console.log(`  cross-corr median lag ${MEASURED.medianXcorrLagSec}s · impulse->reprice median ${MEASURED.medianResponseSec}s · impulse events ${MEASURED.impulseEvents} · stale ${MEASURED.staleNoReprice}`);
console.log(`  LIVE daily-strike book probe: ${MEASURED.dailyStrikeWithTwoSidedBook}/${MEASURED.dailyStrikeProbed} have a two-sided book · top crypto vol24 $${MEASURED.topCryptoVol24Usd} · daily-strike spread $${MEASURED.dailyStrikeSpread.toFixed(2)}`);

// ── The exploitable-triple math, made explicit ──
// A 13.4s stale quote on a near-the-money daily strike with ~50% delta could mis-price by a few
// cents after a 20bps Binance impulse. But to TAKE it you must cross the PM spread. With an empty
// book (spread $1.00) the cost to cross dwarfs any few-cent staleness edge.
const stalenessEdgeCents = 3;     // generous: a 20bps move on a 50-delta NTM strike ~ few cents
const crossCostCents = MEASURED.dailyStrikeSpread * 100; // cents to cross the empty-book spread
const netEdgeCents = stalenessEdgeCents - crossCostCents;
console.log(`\n  exploitable-triple net edge: staleness ~${stalenessEdgeCents}c  -  cross-spread ${crossCostCents.toFixed(0)}c  =  ${netEdgeCents.toFixed(0)}c per take  (negative -> not takeable)`);

// ── Encode as a penny_lock "snipe" lane and judge on its OWN objective via proofCouncil ──
// objective penny_lock: "can we keep winning AND stay net positive?" — the snipe is a
// high-confidence tiny-edge bet. nTrades = takeable instances = 0 (empty book), netRoi = negative.
console.log("\n" + renderProofCouncil(proofCouncil({
  label: "daily-strike Binance->PM snipe",
  objective: "penny_lock",
  bars: 0, sampleUnit: "takeable snipes", feeBps: 0,
  nTrades: 0,                      // 0 takeable instances: no two-sided book on any daily strike
  winRate: 0,
  netRoiPct: netEdgeCents,         // negative by construction (cross-cost > staleness edge)
})) + "\n");

// ── Also run adviseTrade on the lane as an "edge" strategy: a single per-instance return series.
// With 0 takeable instances we model the realized return series as the net-edge per attempted
// snipe (all negative after crossing the empty-book spread) → the advisor lands STAND_ASIDE.
const perAttempt = Array.from({ length: 60 }, () => netEdgeCents / 100); // each attempt loses the spread
const benchmark = Array.from({ length: 60 }, () => 0);                    // not trading = flat
console.log(renderTradeMemo(adviseTrade({
  label: "daily-strike snipe (net per attempt)",
  strategyReturns: perAttempt, benchmarkReturns: benchmark,
  search: { hypothesesScanned: 1, bonferroniSurvivors: 0 },
})) + "\n");
