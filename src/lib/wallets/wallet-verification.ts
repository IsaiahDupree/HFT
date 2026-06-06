/**
 * wallet-verification — gate a Polymarket wallet's CONSENSUS vote on its REAL realized track record, not its
 * leaderboard claim. The policy audit found the dangerous gap: detectConsensus() counted every tracked wallet's
 * vote without checking whether the wallet is actually profitable — so a blown-up or fake "leaderboard" wallet
 * could carry a consensus signal into the decision pipeline. This computes per-wallet realized stats from its
 * resolved (closed) positions and a verification predicate (the Polymarket analog of HL's isVerifiedProfitable):
 * a wallet votes only if its closed positions show REAL net profit over enough resolved markets. Pure.
 */

export type ClosedPositionRow = { realizedPnl: number; curPrice: number };  // curPrice ∈ {0,1} on a resolved market

export type WalletRealized = { realizedPnlUsd: number; nResolved: number; winRate: number };

/** Realized stats from a wallet's CLOSED (resolved) positions. winRate = fraction that resolved in the money. */
export function walletStatsFromClosed(rows: readonly ClosedPositionRow[]): WalletRealized {
  const resolved = rows.filter((r) => Number.isFinite(r.curPrice));
  const n = resolved.length;
  if (n === 0) return { realizedPnlUsd: 0, nResolved: 0, winRate: 0 };
  const realizedPnlUsd = resolved.reduce((a, r) => a + (Number.isFinite(r.realizedPnl) ? r.realizedPnl : 0), 0);
  const wins = resolved.filter((r) => r.curPrice >= 0.99).length;
  return { realizedPnlUsd, nResolved: n, winRate: wins / n };
}

export type VerifyOpts = { minResolved?: number; minRealizedPnlUsd?: number };

/**
 * Is the wallet's track record good enough to count its vote? Requires REAL net realized profit over a minimum
 * number of resolved markets. This is a cohort-QUALITY filter (exclude fakes/blowups) — NOT a forward-edge claim
 * (that still needs the forward paper-track). Mirrors the HL `isVerifiedProfitable` discipline.
 */
export function verifyWalletStats(s: WalletRealized, opts: VerifyOpts = {}): { verified: boolean; reason: string } {
  const minResolved = opts.minResolved ?? 10, minPnl = opts.minRealizedPnlUsd ?? 0;
  if (s.nResolved < minResolved) return { verified: false, reason: `only ${s.nResolved} resolved markets < ${minResolved} — too little track record` };
  if (s.realizedPnlUsd <= minPnl) return { verified: false, reason: `realized $${s.realizedPnlUsd.toFixed(0)} ≤ $${minPnl} — not actually profitable` };
  return { verified: true, reason: `realized $${s.realizedPnlUsd.toFixed(0)} over ${s.nResolved} resolved (win ${(s.winRate * 100).toFixed(0)}%)` };
}
