/**
 * vol-surface — measure the structural premia in the options vol surface, the untested siblings of the confirmed
 * vol-risk-premium (EDGE #3). Two premia we want to harvest:
 *   • SKEW (25-delta risk reversal): IV(25Δ put) − IV(25Δ call). Persistently POSITIVE = the market overpays for
 *     downside crash insurance — a structural premium you can sell (put spreads / risk-reversals).
 *   • TERM structure: ATM IV across expiries. Upward slope (contango) = front vol is cheap relative to back =
 *     selling front / owning back has a roll premium; inversion = stress.
 * Free Deribit gives the option chain with mark_iv but no greeks, so we derive Black-Scholes delta ourselves
 * (r=q=0) to locate the 25Δ and ATM points. Pure + deterministic; the script does the live fetch + forward log.
 *
 * Honest boundary: free APIs give no historical surface, so the GAUNTLET here is a forward paper-track of the
 * live premium, not a backtest (skew/term backtest needs paid options history — CryptoCompare/Tardis).
 */
import { normalCdf } from "../backtest/candle/stats.ts";

export type OptType = "C" | "P";
export type OptionQuote = { strike: number; type: OptType; iv: number; expiryMs: number };
export type Instrument = { currency: string; expiryMs: number; strike: number; type: OptType };

const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
/** Parse a Deribit option name like "BTC-27JUN25-100000-P" → typed instrument (UTC 08:00 expiry). */
export function parseInstrument(name: string): Instrument | null {
  const m = /^([A-Z]+)-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-([CP])$/.exec(name);
  if (!m) return null;
  const [, currency, dd, mon, yy, strike, type] = m;
  if (!(mon in MONTHS)) return null;
  const expiryMs = Date.UTC(2000 + Number(yy), MONTHS[mon], Number(dd), 8, 0, 0);
  return { currency, expiryMs, strike: Number(strike), type: type as OptType };
}

/** Black-Scholes delta (r=q=0). Call ∈ (0,1); put ∈ (−1,0). T in years, iv annualized. */
export function bsDelta(type: OptType, spot: number, strike: number, tYears: number, iv: number): number {
  if (spot <= 0 || strike <= 0 || tYears <= 0 || iv <= 0) return type === "C" ? 0 : 0;
  const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * tYears) / (iv * Math.sqrt(tYears));
  return type === "C" ? normalCdf(d1) : normalCdf(d1) - 1;
}

export type DeltaPoint = { absDelta: number; iv: number };
/** Interpolate IV at a target |delta| from a set of same-type points (linear; clamps outside the range). */
export function ivAtDelta(points: readonly DeltaPoint[], targetAbsDelta: number): number | null {
  const pts = points.filter((p) => p.iv > 0 && p.absDelta > 0 && p.absDelta < 1).sort((a, b) => a.absDelta - b.absDelta);
  if (pts.length === 0) return null;
  if (pts.length === 1) return pts[0].iv;
  if (targetAbsDelta <= pts[0].absDelta) return pts[0].iv;
  if (targetAbsDelta >= pts[pts.length - 1].absDelta) return pts[pts.length - 1].iv;
  for (let i = 1; i < pts.length; i++) {
    if (targetAbsDelta <= pts[i].absDelta) {
      const a = pts[i - 1], b = pts[i], w = (targetAbsDelta - a.absDelta) / (b.absDelta - a.absDelta);
      return a.iv + w * (b.iv - a.iv);
    }
  }
  return pts[pts.length - 1].iv;
}

export type ExpiryMetrics = { expiryMs: number; tYears: number; atmIv: number | null; putIv25: number | null; callIv25: number | null; riskReversal25: number | null; nOptions: number };

/** Compute ATM IV + 25Δ risk-reversal for one expiry's option set, given the underlying spot + valuation time. */
export function expiryMetrics(opts: readonly OptionQuote[], spot: number, nowMs: number): ExpiryMetrics {
  const expiryMs = opts[0]?.expiryMs ?? 0;
  const tYears = Math.max((expiryMs - nowMs) / (365 * 86_400_000), 1e-6);
  const withDelta = opts.filter((o) => o.iv > 0).map((o) => ({ ...o, absDelta: Math.abs(bsDelta(o.type, spot, o.strike, tYears, o.iv)) }));
  const calls = withDelta.filter((o) => o.type === "C").map((o) => ({ absDelta: o.absDelta, iv: o.iv }));
  const puts = withDelta.filter((o) => o.type === "P").map((o) => ({ absDelta: o.absDelta, iv: o.iv }));
  const atmIv = ((ivAtDelta(calls, 0.5) ?? NaN) + (ivAtDelta(puts, 0.5) ?? NaN)) / 2;
  const callIv25 = ivAtDelta(calls, 0.25);
  const putIv25 = ivAtDelta(puts, 0.25);
  const riskReversal25 = callIv25 != null && putIv25 != null ? putIv25 - callIv25 : null;
  return { expiryMs, tYears, atmIv: Number.isFinite(atmIv) ? atmIv : null, putIv25, callIv25, riskReversal25, nOptions: opts.length };
}

export type TermStructure = { slope: number | null; frontIv: number | null; backIv: number | null; contango: boolean | null };
/** Term-structure slope of ATM IV: (back − front) / Δyears. Positive ⇒ contango (front vol cheap vs back). */
export function termStructure(metrics: readonly ExpiryMetrics[]): TermStructure {
  const m = metrics.filter((x) => x.atmIv != null && x.tYears > 0).sort((a, b) => a.tYears - b.tYears);
  if (m.length < 2) return { slope: null, frontIv: m[0]?.atmIv ?? null, backIv: null, contango: null };
  const front = m[0], back = m[m.length - 1];
  const slope = (back.atmIv! - front.atmIv!) / (back.tYears - front.tYears);
  return { slope, frontIv: front.atmIv, backIv: back.atmIv, contango: back.atmIv! > front.atmIv! };
}

/** Annualized realized vol from a series of close prices (log returns × √periodsPerYear). */
export function realizedVol(closes: readonly number[], periodsPerYear: number): number {
  if (closes.length < 3) return 0;
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) if (closes[i] > 0 && closes[i - 1] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, r.length - 1);
  return Math.sqrt(v * periodsPerYear);
}
