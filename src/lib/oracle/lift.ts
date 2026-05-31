/**
 * Oracle signal lift (the HFT-work equivalent of the 2dollar-bot's
 * discover.signal_lift) — does a high agreement score / fresh Chainlink at
 * decide-time correlate with the favored (drift) direction actually winning?
 *
 * Oracle agreement + Chainlink staleness are RISK FILTERS, not direction
 * predictors: the hypothesis is that LOW agreement / a STRADDLE / a STALE feed
 * mark noisier windows where the favored side wins LESS often. This measures it,
 * Wilson-bounded so a 5-row "edge" isn't mistaken for real.
 *
 * Pure functions — unit-tested with vitest. The DB join lives in scripts/oracle-lift.ts.
 */

/** Wilson lower bound of a win rate (95% by default). */
export function wilsonLower(wins: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (center - margin) / denom);
}

export type OraclePair = {
  agreement_score: number | null;
  side_agree: boolean | null;
  chainlink_zone: string | null; // fresh | aging | stale | null
  favored_up: boolean; // the candle-drift side at decide-time
  resolved_up: boolean; // window outcome (close > open)
};

export type Bucket = { label: string; n: number; wins: number; win: number; winCiLow: number; winLift: number };

function block(label: string, sel: OraclePair[], baseWin: number): Bucket {
  const n = sel.length;
  const wins = sel.filter((p) => p.favored_up === p.resolved_up).length;
  const win = n ? wins / n : 0;
  return {
    label,
    n,
    wins,
    win: Number(win.toFixed(4)),
    winCiLow: Number(wilsonLower(wins, n).toFixed(4)),
    winLift: Number((win - baseWin).toFixed(4)),
  };
}

export type OracleLift = {
  baseline: Bucket;
  byAgreement: Bucket[];
  bySideAgree: Bucket[];
  byZone: Bucket[];
};

const AGREEMENT_BANDS: Array<[string, (s: number) => boolean]> = [
  ["agree <0.50", (s) => s < 0.5],
  ["agree 0.50–0.75", (s) => s >= 0.5 && s < 0.75],
  ["agree ≥0.75", (s) => s >= 0.75],
];

export function oracleLift(pairs: OraclePair[]): OracleLift {
  const baseWins = pairs.filter((p) => p.favored_up === p.resolved_up).length;
  const baseWin = pairs.length ? baseWins / pairs.length : 0;
  const base = block("baseline", pairs, baseWin);

  const byAgreement = AGREEMENT_BANDS.map(([label, pred]) =>
    block(label, pairs.filter((p) => p.agreement_score != null && pred(p.agreement_score)), baseWin),
  );
  const bySideAgree = [
    block("side agree", pairs.filter((p) => p.side_agree === true), baseWin),
    block("side STRADDLE", pairs.filter((p) => p.side_agree === false), baseWin),
  ];
  const byZone = ["fresh", "aging", "stale"].map((z) =>
    block(`chainlink ${z}`, pairs.filter((p) => p.chainlink_zone === z), baseWin),
  );
  return { baseline: base, byAgreement, bySideAgree, byZone };
}
