/**
 * Personal leverage advisor — your-wallet only.
 *
 * Pure math over AaveAccountData. Computes:
 *   - max-safe-borrow at a target health factor (default 1.5)
 *   - remaining headroom against that target
 *   - a recommended action: borrow_more / hold / repay_some / repay_urgent
 *
 * Math (Aave V3):
 *   HF = (totalCollateralUsd × liquidationThreshold) / totalDebtUsd
 *   → at target HF: maxDebt = (Collateral × liqThreshold) / HF_target
 *
 * NOT a product. NOT a service offered to others. This computes what YOU
 * could safely do with YOUR OWN wallet on Aave. Pooled leverage products
 * offered to third parties cross into regulated activity (CFTC/SEC/FinCEN
 * depending on structure). Intentionally out of scope.
 *
 * Caveats are stamped on every report so the UI can't accidentally drop them.
 */
import type { AaveAccountData, AaveRiskTier } from "./aave";

export type LeverageAction = "borrow_more" | "hold" | "repay_some" | "repay_urgent";

export type LeverageAdvice = {
  wallet: string;
  current: {
    collateralUsd: number;
    debtUsd: number;
    healthFactor: number;
    riskTier: AaveRiskTier;
  };
  target: {
    healthFactor: number;
    maxDebtUsd: number;
    remainingHeadroomUsd: number;
  };
  recommendation: {
    action: LeverageAction;
    amountUsd: number;
    reason: string;
  };
  caveats: string[];
};

export type LeverageOptions = {
  /** Target health factor; default 1.5 (cautious). */
  targetHealthFactor?: number;
  /** Threshold below which the urgency rule fires. Default 1.1. */
  urgentHealthFactor?: number;
  /** Minimum headroom to recommend `borrow_more` over `hold`. Default $100. */
  minBorrowDeltaUsd?: number;
};

export function computeLeverageAdvice(
  data: AaveAccountData,
  opts: LeverageOptions = {},
): LeverageAdvice {
  const targetHF = opts.targetHealthFactor ?? 1.5;
  const urgentHF = opts.urgentHealthFactor ?? 1.1;
  const minDelta = opts.minBorrowDeltaUsd ?? 100;

  const liqThreshold = data.currentLiquidationThresholdBps / 10_000;
  const caveats: string[] = [];

  // Max debt at target HF. If liqThreshold is 0 (no eligible collateral), this is 0.
  const maxDebtUsd =
    liqThreshold > 0 && targetHF > 0 ? (data.totalCollateralUsd * liqThreshold) / targetHF : 0;
  const remainingHeadroomUsd = Math.max(0, maxDebtUsd - data.totalDebtUsd);

  let action: LeverageAction = "hold";
  let amountUsd = 0;
  let reason = "current position is within target health factor";

  if (data.riskTier === "no_position") {
    action = "hold";
    amountUsd = 0;
    reason = "no Aave position to advise on";
  } else if (data.healthFactor < urgentHF) {
    action = "repay_urgent";
    amountUsd = Math.max(0, data.totalDebtUsd - maxDebtUsd);
    reason = `HF=${data.healthFactor.toFixed(2)} below urgent threshold ${urgentHF}; repay $${amountUsd.toFixed(0)} to reach target HF=${targetHF}`;
  } else if (data.healthFactor < targetHF) {
    action = "repay_some";
    amountUsd = Math.max(0, data.totalDebtUsd - maxDebtUsd);
    reason = `HF=${data.healthFactor.toFixed(2)} below target ${targetHF}; repay $${amountUsd.toFixed(0)} to reach target`;
  } else if (remainingHeadroomUsd >= minDelta) {
    action = "borrow_more";
    amountUsd = remainingHeadroomUsd;
    reason = `safe to borrow up to $${remainingHeadroomUsd.toFixed(0)} more while staying at HF≥${targetHF}`;
  }

  caveats.push("read-only advisory — execute through your own wallet, not this app");
  caveats.push("HF math uses on-chain liquidationThreshold; volatile collateral can crash HF faster than this snapshot");
  caveats.push("personal use only — pooling other people's funds for leverage is regulated activity (CFTC/SEC/FinCEN)");

  return {
    wallet: data.wallet,
    current: {
      collateralUsd: data.totalCollateralUsd,
      debtUsd: data.totalDebtUsd,
      healthFactor: data.healthFactor,
      riskTier: data.riskTier,
    },
    target: {
      healthFactor: targetHF,
      maxDebtUsd,
      remainingHeadroomUsd,
    },
    recommendation: { action, amountUsd, reason },
    caveats,
  };
}
