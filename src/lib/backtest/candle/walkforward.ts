/**
 * Walk-forward / out-of-sample validation for candle strategies. Pick the best
 * params on the in-sample slice (first `isFrac`), then score those SAME params on
 * the held-out out-of-sample slice. If OOS performance collapses vs IS, the IS
 * winner was overfit. Strategies use only trailing data, so OOS positions never
 * peek — the IS data is legitimate lookback for the OOS slice.
 */
import { runCandleBacktest, type CandleResult, type DailyCandle } from "./engine";

export type Variant = { label: string; positions: number[] };
export type WalkForwardResult = { label: string; is: CandleResult; oos: CandleResult; splitAt: number; oosBars: number };

/** Pick the best variant by IN-SAMPLE Sharpe; report it on the OOS slice. */
export function walkForward(candles: DailyCandle[], variants: Variant[], opts: { isFrac?: number; feeBps?: number } = {}): WalkForwardResult {
  const isFrac = opts.isFrac ?? 0.7;
  const split = Math.floor(candles.length * isFrac);
  const isCandles = candles.slice(0, split);
  const oosCandles = candles.slice(split);

  let best: Variant = variants[0];
  let bestIs: CandleResult = runCandleBacktest(isCandles, variants[0].positions.slice(0, split), { feeBps: opts.feeBps });
  for (const v of variants.slice(1)) {
    const r = runCandleBacktest(isCandles, v.positions.slice(0, split), { feeBps: opts.feeBps });
    if (r.sharpe > bestIs.sharpe) { best = v; bestIs = r; }
  }
  const oos = runCandleBacktest(oosCandles, best.positions.slice(split), { feeBps: opts.feeBps });
  return { label: best.label, is: bestIs, oos, splitAt: split, oosBars: oosCandles.length };
}
