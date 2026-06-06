/**
 * capital-flow — account for wallets moving money IN and OUT of the trading account, which silently corrupts
 * the smart-money data two ways:
 *   1. ROI INFLATION: a wallet that withdraws most of its profit has a tiny accountValue but a huge ROI on the
 *      remainder — the leaderboard's "$0 account / 200000% ROI" explosions are withdrawals, not skill.
 *   2. FAKE DIRECTIONAL SIGNAL: a position REDUCED because the trader is cashing out (de-risking to withdraw) is
 *      a capital-flow event, NOT a bearish view — copy/consensus must not read it as a short signal.
 * HL exposes this via `userNonFundingLedgerUpdates` (deposit / withdraw / transfers). Pure: parse + judge; the
 * scripts do the fetch and decide to flag / exclude a flow-distorted wallet.
 */

export type LedgerUpdate = { time?: number; delta?: { type?: string; usdc?: string | number; amount?: string | number } };

export type CapitalFlow = { deposits: number; withdrawals: number; net: number; nFlows: number };

const amt = (d: { usdc?: string | number; amount?: string | number }): number => {
  const v = Number(d.usdc ?? d.amount ?? 0);
  return Number.isFinite(v) ? Math.abs(v) : 0;
};

/** Net USDC moved in/out over the ledger window. Withdrawals + outbound transfers count as money LEAVING. */
export function netCapitalFlow(updates: readonly LedgerUpdate[]): CapitalFlow {
  let deposits = 0, withdrawals = 0, nFlows = 0;
  for (const u of updates) {
    const t = u?.delta?.type ?? "";
    if (/deposit/i.test(t)) { deposits += amt(u.delta!); nFlows++; }
    else if (/withdraw/i.test(t)) { withdrawals += amt(u.delta!); nFlows++; }
  }
  return { deposits, withdrawals, net: deposits - withdrawals, nFlows };
}

export type FlowDistortion = { withdrawRatio: number; distorted: boolean; reason: string };

/**
 * Judge whether a wallet's metrics/signals are corrupted by capital flows. withdrawRatio = withdrawals as a
 * share of the capital that WAS in the account (accountValue + withdrawals). Above `maxRatio` the ROI is
 * inflated and recent position cuts may be cash-outs rather than directional — flag it.
 */
export function flowDistortion(flow: CapitalFlow, accountValue: number, maxRatio = 0.25): FlowDistortion {
  const denom = Math.max(accountValue + flow.withdrawals, 1);
  const withdrawRatio = flow.withdrawals / denom;
  if (withdrawRatio > maxRatio) {
    return { withdrawRatio, distorted: true, reason: `withdrew $${(flow.withdrawals / 1000).toFixed(0)}k = ${(withdrawRatio * 100).toFixed(0)}% of account capital — ROI inflated + position cuts may be cash-outs, not signal` };
  }
  return { withdrawRatio, distorted: false, reason: `net flow $${(flow.net / 1000).toFixed(0)}k, withdrawals ${(withdrawRatio * 100).toFixed(0)}% of capital — clean` };
}
