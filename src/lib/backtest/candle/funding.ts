/**
 * Funding-aware carry — use perp funding as a directional FILTER and a standalone carry
 * SIGNAL. Convention: positive funding = longs pay shorts (costly to hold long); negative
 * = shorts pay longs (you are PAID to hold long). Pure + NO-LOOKAHEAD: funding[i] is the
 * rate known at bar i; the position it conditions is held over bar i→i+1.
 */
import type { DailyCandle } from "./engine";

const finite = (x: number | undefined): x is number => x != null && Number.isFinite(x);

/**
 * Gate a long position by funding: keep it only when funding is NOT punitive (≤ maxFunding).
 * "Avoid longs when funding is punitive." Default cap 0 → hold only when you aren't paying to
 * be long. Non-finite funding → flat (conservative). Gate only SUBTRACTS.
 */
export function fundingGate(positions: number[], funding: ReadonlyArray<number | undefined>, opts: { maxFunding?: number } = {}): number[] {
  const cap = opts.maxFunding ?? 0;
  return positions.map((p, i) => (finite(funding[i]) && (funding[i] as number) <= cap ? p : 0));
}

/**
 * Standalone funding carry: go long to COLLECT funding when it is negative (you're paid),
 * flat when it turns positive. Hysteresis band [enter, exit] (long once funding ≤ enter,
 * flat once funding ≥ exit). NO-LOOKAHEAD.
 */
export function fundingCarrySignal(funding: ReadonlyArray<number | undefined>, opts: { enter?: number; exit?: number } = {}): number[] {
  const enter = opts.enter ?? 0, exit = opts.exit ?? 0;
  const pos: number[] = new Array(funding.length).fill(0);
  let cur = 0;
  for (let i = 0; i < funding.length; i++) {
    const f = funding[i];
    if (finite(f)) {
      if (f <= enter) cur = 1;
      else if (f >= exit) cur = 0;
    }
    pos[i] = cur;
  }
  return pos;
}

/**
 * DELTA-NEUTRAL funding carry — the real carry trade: hold the funding-RECEIVING leg of a
 * perp+spot hedge (short perp + long spot when funding > 0 so the short collects; long perp +
 * short spot when funding < 0), so the two price legs cancel and the return is the funding you
 * HARVEST minus turnover. Take a side only when |funding| ≥ `minFunding` (enough to clear the
 * round-trip cost). Per interval: +|funding| collected, minus `feeBps` × (legs changed) — a
 * fresh entry from flat moves 2 legs, a sign FLIP moves 4. Convention matches the rest of the
 * file (funding[i] known at i, applied over i→i+1; NO-LOOKAHEAD). Assumes negligible basis
 * drift between spot and perp (holds for liquid majors at the funding cadence) — that residual
 * basis risk is the model's main omission.
 */
export function deltaNeutralCarryReturns(funding: ReadonlyArray<number | undefined>, opts: { minFunding?: number; feeBps?: number } = {}): number[] {
  const minF = opts.minFunding ?? 0;
  const feeBps = opts.feeBps ?? 5;
  const out: number[] = [];
  let side = 0; // -1 = short perp (collect +funding), +1 = long perp (collect −funding), 0 = flat
  for (let i = 0; i < funding.length; i++) {
    const f = funding[i];
    const target = finite(f) && Math.abs(f) >= minF ? ((f as number) > 0 ? -1 : 1) : 0;
    const collect = target !== 0 && finite(f) ? Math.abs(f as number) : 0;
    const fee = Math.abs(target - side) * 2 * (feeBps / 1e4); // 2 legs per unit of side change
    out.push(collect - fee);
    side = target;
  }
  return out;
}

/**
 * BASIS-AWARE delta-neutral carry — the risk-honest version of deltaNeutralCarryReturns. Models
 * BOTH legs with their OWN prices, so the previously-omitted BASIS RISK (perp and spot don't move
 * identically — the basis widens/narrows) shows up in the return. Hold the funding-receiving side
 * (short perp + long spot when funding > 0), collect |funding|, and bear the basis change:
 *   net[i] = |funding| + perpSide·(perpRet − spotRet) − fee
 * where perpSide = −1 (short perp) when funding > 0. `spotClose`/`perpClose` are aligned daily
 * closes; `funding` the daily-summed rate. NO-LOOKAHEAD (position from funding[i], realized i→i+1).
 */
export function basisCarryReturns(spotClose: number[], perpClose: number[], funding: ReadonlyArray<number | undefined>, opts: { minFunding?: number; feeBps?: number } = {}): number[] {
  const minF = opts.minFunding ?? 0, feeBps = opts.feeBps ?? 5;
  const n = Math.min(spotClose.length, perpClose.length); // funding[i] is read undefined-safe below
  const out: number[] = [];
  let side = 0; // perp side: −1 short (funding>0), +1 long (funding<0)
  for (let i = 0; i < n - 1; i++) {
    const f = funding[i];
    const target = finite(f) && Math.abs(f) >= minF ? ((f as number) > 0 ? -1 : 1) : 0;
    const collected = target !== 0 && finite(f) ? Math.abs(f as number) : 0;
    const spotRet = spotClose[i] > 0 ? spotClose[i + 1] / spotClose[i] - 1 : 0;
    const perpRet = perpClose[i] > 0 ? perpClose[i + 1] / perpClose[i] - 1 : 0;
    const pricePnL = target * (perpRet - spotRet); // short perp + long spot ⇒ gains as the basis narrows
    const fee = Math.abs(target - side) * 2 * (feeBps / 1e4);
    out.push(collected + pricePnL - fee);
    side = target;
  }
  return out;
}

/**
 * Per-bar net PERP return of a position series: the price return MINUS the funding paid by a
 * long (a long pays positive funding, receives negative), minus the fee on turnover. This is
 * the carry-correct return model (variantReturns ignores funding). funding[i] is the rate
 * charged over bar i→i+1 aligned to candle i; a non-finite funding bar contributes 0 funding.
 */
export function netFundingReturns(candles: DailyCandle[], positions: number[], funding: ReadonlyArray<number | undefined>, feeBps = 10): number[] {
  const out: number[] = [];
  for (let i = 0; i < candles.length - 1; i++) {
    const pos = positions[i] ?? 0;
    const prev = i > 0 ? (positions[i - 1] ?? 0) : 0;
    const priceRet = candles[i + 1].close / candles[i].close - 1;
    const f = finite(funding[i]) ? (funding[i] as number) : 0;
    out.push(pos * (priceRet - f) - Math.abs(pos - prev) * (feeBps / 1e4)); // long pays +funding
  }
  return out;
}
