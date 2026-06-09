/**
 * move-detector — "detect when a wallet makes a move, and decide whether copying it live is real or a trap."
 * Diffs a wallet's positions between two polls into discrete MOVES (open/increase/reduce/close/flip), then
 * decides if each move is actionable to copy — gated by the ONE thing that decides it: is the wallet's edge a
 * thesis that plays out over hours/days (copyable) or pure latency that's gone before its fill is even public
 * (the HFT trap)? For a slow wallet a 60-second detection lag is nothing against an 8-hour hold; for a scalper
 * it's everything. So this never emits a "copy now" on an un-copyable wallet — it suppresses it WITH the reason,
 * so we don't fool ourselves into buying the exit liquidity of someone faster than us.
 *
 * Pure + deterministic. The script polls fills/positions and feeds successive snapshots in.
 */
import type { CopyMode } from "./strategy-profile.ts";

export type Position = { coin: string; notionalUsd: number }; // signed: + long, − short
export type MoveType = "open" | "increase" | "reduce" | "close" | "flip";
export type Move = { coin: string; type: MoveType; prevNotional: number; curNotional: number; side: "long" | "short" | "flat"; deltaUsd: number };

/** Diff two position snapshots into discrete moves. Sub-threshold wiggles are ignored (not every tick is a move). */
export function detectMoves(prev: readonly Position[], cur: readonly Position[], minDeltaUsd = 1_000): Move[] {
  const p = new Map(prev.map((x) => [x.coin, x.notionalUsd]));
  const c = new Map(cur.map((x) => [x.coin, x.notionalUsd]));
  const moves: Move[] = [];
  for (const coin of new Set([...p.keys(), ...c.keys()])) {
    const a = p.get(coin) ?? 0, b = c.get(coin) ?? 0;
    if (Math.abs(b - a) < minDeltaUsd) continue;
    const side = b > 0 ? "long" : b < 0 ? "short" : "flat";
    let type: MoveType;
    if (a === 0 && b !== 0) type = "open";
    else if (a !== 0 && b === 0) type = "close";
    else if (Math.sign(a) !== Math.sign(b)) type = "flip";
    else type = Math.abs(b) > Math.abs(a) ? "increase" : "reduce";
    moves.push({ coin, type, prevNotional: a, curNotional: b, side, deltaUsd: b - a });
  }
  return moves.sort((x, y) => Math.abs(y.deltaUsd) - Math.abs(x.deltaUsd));
}

/** Fraction of the move's own horizon still AHEAD of you at detection — your edge as a follower. */
export function alphaAhead(medianHoldMs: number, detectionLagMs: number): number {
  if (medianHoldMs <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - detectionLagMs / medianHoldMs));
}

export type Urgency = "now" | "soon" | "none";
export type CopySignal = { move: Move; actionable: boolean; latencyTrap: boolean; urgency: Urgency; alphaAhead: number; reason: string };

/**
 * Decide whether a detected move is worth copying LIVE. The gate is the wallet's copy mode (its measured edge),
 * not the move's size:
 *   • none (HFT/scalper) → NEVER actionable; latencyTrap=true. The fill is public only after the edge is spent.
 *   • trade-copy        → mirror the specific trade NOW, IF detection lag is small vs the wallet's hold.
 *   • position-copy     → adjust the mirrored NET book SOON (not trade-for-trade); slower, coarser.
 * If the detection lag has eaten most of the wallet's horizon (alphaAhead too low), even a slow wallet is a pass.
 */
export function copySignal(move: Move, copyMode: CopyMode, medianHoldMs: number, detectionLagMs: number, minAlphaAhead = 0.5): CopySignal {
  const ahead = alphaAhead(medianHoldMs, detectionLagMs);
  if (copyMode === "none") {
    return { move, actionable: false, latencyTrap: true, urgency: "none", alphaAhead: ahead,
      reason: `HFT/scalper — the fill is public only after the edge is spent; copying it buys after the move (you'd be exit liquidity).` };
  }
  if (ahead < minAlphaAhead) {
    return { move, actionable: false, latencyTrap: false, urgency: "none", alphaAhead: ahead,
      reason: `detection lag ate ${((1 - ahead) * 100).toFixed(0)}% of the wallet's hold horizon — too late to capture the move.` };
  }
  const urgency: Urgency = copyMode === "trade-copy" ? "now" : "soon";
  const how = copyMode === "trade-copy"
    ? `mirror this ${move.type} on ${move.coin} (${move.side}) now — ${(ahead * 100).toFixed(0)}% of the hold horizon still ahead of you`
    : `adjust the mirrored NET book toward ${move.coin} ${move.side} (position-copy, not trade-for-trade)`;
  return { move, actionable: true, latencyTrap: false, urgency, alphaAhead: ahead, reason: how };
}
