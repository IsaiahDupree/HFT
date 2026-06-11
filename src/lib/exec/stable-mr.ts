/**
 * stable-mr — mean-reversion on stablecoin pegs. The catalog's hard-won lesson is "crypto is MOMENTUM, not
 * pairs-MR" — every stat-arb/pairs family died because crypto trends. Stablecoins are the structural EXCEPTION:
 * a collateralized stable (USDC/DAI/TUSD/FDUSD vs USDT) is pinned near 1.0 by redemption + arbitrage, so a
 * deviation from peg is a *temporary* dislocation that reverts — the same kind of locked structural anchor that
 * makes calendar-basis carry real. We fade the deviation: long the stable when it trades below peg, short when
 * above, exit as it reconverges. Edge = the reversion; risk = a depeg that NEVER recovers (terminal collapse —
 * the UST tail). Pure + no-lookahead; the script fetches real klines and runs the gauntlet.
 */

export type Bar = { time: number; close: number };

/** Deviation of the stable/USDT ratio from its $1 peg. */
export const pegDeviation = (close: number, peg = 1): number => close - peg;

export type MrParams = { entry: number; exit: number; maxHold: number };

/**
 * No-lookahead position series: position[i] is the side held from bar i → i+1, decided using only data ≤ i.
 * Enter a FADE when |dev| crosses the entry band (long if below peg, short if above); exit when the deviation
 * reconverges inside the exit band (or crosses the peg), or after maxHold bars. side ∈ {−1, 0, +1}.
 */
export function mrPositions(bars: readonly Bar[], p: MrParams, peg = 1): number[] {
  const pos = new Array<number>(bars.length).fill(0);
  let cur = 0, entryBar = -1;
  for (let i = 0; i < bars.length; i++) {
    const dev = bars[i].close - peg;
    if (cur === 0) {
      if (dev <= -p.entry) { cur = 1; entryBar = i; }
      else if (dev >= p.entry) { cur = -1; entryBar = i; }
    } else {
      const held = i - entryBar;
      const exitLong = cur === 1 && dev >= -p.exit;   // risen back near/through the peg
      const exitShort = cur === -1 && dev <= p.exit;
      if (exitLong || exitShort || held >= p.maxHold) cur = 0;
    }
    pos[i] = cur;
  }
  return pos;
}

export type MrResult = { net: number[]; gross: number[]; positions: number[]; nTrades: number; turnover: number };

/** Per-bar strategy returns. Price return of holding `position[i]` over i→i+1, minus fee charged on position CHANGES. */
export function mrReturns(bars: readonly Bar[], p: MrParams, feeBps: number, peg = 1): MrResult {
  const positions = mrPositions(bars, p, peg);
  const gross: number[] = [], net: number[] = [];
  let prev = 0, turnover = 0, nTrades = 0;
  for (let i = 0; i < bars.length - 1; i++) {
    const r = positions[i] * (bars[i + 1].close - bars[i].close) / bars[i].close;
    const dPos = Math.abs(positions[i] - prev);
    if (positions[i] !== 0 && prev === 0) nTrades++;          // count entries
    turnover += dPos;
    const cost = dPos * (feeBps / 1e4);
    gross.push(r); net.push(r - cost);
    prev = positions[i];
  }
  return { net, gross, positions, nTrades, turnover };
}

/** Beta baseline: just HOLD the stable long. For a pinned asset this is ~0 — so MR return is ~pure alpha. */
export function holdReturns(bars: readonly Bar[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < bars.length - 1; i++) out.push((bars[i + 1].close - bars[i].close) / bars[i].close);
  return out;
}
