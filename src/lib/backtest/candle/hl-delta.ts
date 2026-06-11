/**
 * hl-delta — same-venue (Hyperliquid) 1:1 spot+perp delta-neutral funding capture. The tightest-hedge member of
 * the PROVEN funding-carry family: short the perp + long the spot on the SAME venue, so the price legs cancel
 * (zero transfer/settlement/basis risk — the exact risk that capped cross-venue funding at ~3% APR), and you
 * harvest the perp funding. A coin is eligible only while its funding is durably positive (≥ gate APR); we hold
 * the best eligible coin and ROTATE when another clears the current one by more than the rotation cost
 * (hysteresis — so we don't churn ourselves to death). Pure + no-lookahead: the position at i is chosen from
 * funding known at i; the funding actually earned over [i,i+1] is the realized print settling after entry.
 */

/** HL funding is hourly; annualize a per-hour rate. */
export const annualizeHourly = (hourlyRate: number): number => hourlyRate * 24 * 365;

export type RotateParams = {
  gateApr: number;        // enter a coin only if its annualized funding ≥ this (durable-funding filter)
  exitFloorApr: number;   // drop a held coin once its annualized funding falls below this
  hysteresisApr: number;  // rotate to a better coin only if it beats the current by more than this (cost guard)
};
export const DEFAULT_ROTATE: RotateParams = { gateApr: 0.05, exitFloorApr: 0.0, hysteresisApr: 0.10 };

export type HlDeltaResult = { coinPath: (string | null)[]; gross: number[]; net: number[]; nRotations: number; hoursDeployed: number };

/**
 * Backtest the rotation. `rates[coin][i]` = the funding rate KNOWN at time i for that coin (hourly, signed).
 * Decision at i uses rates[·][i] only; the funding collected over [i,i+1] is rates[heldCoin][i+1] (settled after
 * entry — no lookahead). Rotation cost (close+open both legs ≈ 4 fills) is charged as a fraction on every coin change.
 */
export function hlDeltaBacktest(
  coins: readonly string[],
  rates: Record<string, number[]>,
  n: number,
  p: RotateParams,
  rotationCostBps: number,
): HlDeltaResult {
  const coinPath: (string | null)[] = []; // one decision PER BAR (length n) — keeps it lookahead-checkable
  const gross: number[] = [], net: number[] = [];
  let held: string | null = null, nRotations = 0, hoursDeployed = 0;
  const aprAt = (c: string, i: number) => annualizeHourly(rates[c]?.[i] ?? -Infinity);

  for (let i = 0; i < n; i++) {
    // best eligible coin by current (≤ i) funding
    let best: string | null = null, bestApr = -Infinity;
    for (const c of coins) { const a = aprAt(c, i); if (a >= p.gateApr && a > bestApr) { best = c; bestApr = a; } }

    const prev = held;
    if (held === null) held = best;                                   // flat → enter best eligible (or stay flat)
    else if (aprAt(held, i) < p.exitFloorApr) held = best;           // held coin decayed → exit (to best or flat)
    else if (best && best !== held && bestApr - aprAt(held, i) > p.hysteresisApr) held = best; // rotate past the cost guard

    const rotated = held !== prev && held !== null;                  // entered or switched into a coin
    if (rotated) nRotations++;
    coinPath.push(held);

    if (i < n - 1) {
      const g = held ? (rates[held]?.[i + 1] ?? 0) : 0;             // funding settled over [i,i+1] (no lookahead)
      if (held) hoursDeployed++;
      const cost = rotated ? rotationCostBps / 10_000 : 0;          // charge entry/rotation
      gross.push(g);
      net.push(g - cost);
    }
  }
  return { coinPath, gross, net, nRotations, hoursDeployed };
}

/** Always-hold-one-coin baseline (no rotation) — the sign-aware beta benchmark the rotation must beat. */
export function holdSingleCoin(coin: string, rates: Record<string, number[]>, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n - 1; i++) out.push(rates[coin]?.[i + 1] ?? 0); // collect realized funding every hour
  return out;
}
