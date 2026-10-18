// Pure compute for spot-perp basis analysis. No I/O — caller pulls prices
// and funding from whichever venue and feeds them in.
//
// Basis = perp − spot. Positive basis ("contango") implies expected funding
// payments to shorts; negative basis ("backwardation") implies payments to
// longs. dYdX v4 settles funding every block; the documented `nextFundingRate`
// is the 1-hour rate as a fraction.

export type BasisInputs = {
  spot: number;
  perp: number;
  /** Next funding rate, expressed as a fraction over `fundingHorizonHours`. */
  nextFundingRate: number;
  /** Hours covered by `nextFundingRate`. dYdX = 1, Hyperliquid = 8, etc. */
  fundingHorizonHours: number;
};

export type BasisResult = {
  basis: number;
  basisBps: number;
  fundingBpsHourly: number;
  fundingApr: number;
  /** Combined carry if you hold the basis position for 24h, in bps. Assumes
   *  the published funding rate persists for the full window — generous. */
  carry24hBps: number;
  /** "long-basis" = long spot + short perp; collects basis as perp → spot.
   *  "short-basis" = the opposite. */
  preferredLeg: "long-basis" | "short-basis" | "flat";
};

export function computeBasis(i: BasisInputs): BasisResult {
  const basis = i.perp - i.spot;
  const basisBps = i.spot > 0 ? (basis / i.spot) * 10000 : 0;
  const fundingBpsHourly = (i.nextFundingRate / Math.max(1, i.fundingHorizonHours)) * 10000;
  const fundingApr = fundingBpsHourly * 24 * 365 / 10000;
  // 24h carry: basis convergence component is ignored (we don't know the
  // mark-to-market path); funding component scales linearly.
  const carry24hBps = fundingBpsHourly * 24;
  // Picking the leg: if basis > 0 AND funding pays shorts (i.e. positive
  // funding from longs to shorts), short the perp / long the spot.
  // For simplicity here, use basis sign as the dominant signal — funding
  // sign is the next-order refinement the caller can layer in.
  const preferredLeg: BasisResult["preferredLeg"] =
    basisBps > 2 ? "long-basis" : basisBps < -2 ? "short-basis" : "flat";

  return { basis, basisBps, fundingBpsHourly, fundingApr, carry24hBps, preferredLeg };
}
