/**
 * Unit tests for the binary fair-value (digital option) pricer. Fully
 * deterministic — fixed inputs + closed-form expectations. We check:
 *   - normCdf against known standard-normal values
 *   - priceAboveStrike at-the-money / deep ITM / deep OTM / symmetry
 *   - the tau→0 and sigma→0 deterministic-step collapse ("the move already happened")
 *   - monotonicity in spot, strike, tau
 *   - the vol-scaling identity and the minute-closes convenience wrapper
 *   - NaN gating on bad inputs (never silently 0.5)
 */
import { describe, it, expect } from "vitest";
import {
  normCdf,
  priceAboveStrike,
  priceBelowStrike,
  scaleVol,
  fairValueFromMinuteCloses,
  estimateDriftPerBar,
  estimateHorizonSigma,
} from "@/lib/strategies/binary-fair-value";

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

describe("normCdf", () => {
  it("matches known standard-normal CDF values", () => {
    expect(near(normCdf(0), 0.5, 1e-9)).toBe(true);
    expect(near(normCdf(1), 0.8413447, 1e-6)).toBe(true);
    expect(near(normCdf(-1), 0.1586553, 1e-6)).toBe(true);
    expect(near(normCdf(1.959964), 0.975, 1e-5)).toBe(true); // 97.5th pctile
    expect(near(normCdf(-1.959964), 0.025, 1e-5)).toBe(true);
  });
  it("is symmetric: Φ(x) + Φ(−x) = 1", () => {
    for (const x of [0.1, 0.5, 1, 2, 3, 4]) {
      expect(near(normCdf(x) + normCdf(-x), 1, 1e-6)).toBe(true);
    }
  });
  it("saturates in the tails", () => {
    expect(normCdf(8)).toBeGreaterThan(0.999999);
    expect(normCdf(-8)).toBeLessThan(1e-6);
  });
});

describe("priceAboveStrike", () => {
  it("is exactly 0.5 at-the-money with zero drift (any sigma, any tau)", () => {
    expect(near(priceAboveStrike({ spot: 100, strike: 100, tau: 1, sigma: 0.2 }), 0.5)).toBe(true);
    expect(near(priceAboveStrike({ spot: 50_000, strike: 50_000, tau: 0.25, sigma: 0.05 }), 0.5)).toBe(true);
  });

  it("collapses to a deterministic step at tau=0 (the outcome is known)", () => {
    expect(priceAboveStrike({ spot: 101, strike: 100, tau: 0, sigma: 0.2 })).toBe(1);
    expect(priceAboveStrike({ spot: 99, strike: 100, tau: 0, sigma: 0.2 })).toBe(0);
    expect(priceAboveStrike({ spot: 100, strike: 100, tau: 0, sigma: 0.2 })).toBe(0.5);
  });

  it("collapses to a step when sigma=0 (no diffusion)", () => {
    expect(priceAboveStrike({ spot: 101, strike: 100, tau: 1, sigma: 0 })).toBe(1);
    expect(priceAboveStrike({ spot: 99, strike: 100, tau: 1, sigma: 0 })).toBe(0);
  });

  it("rises monotonically as spot increases (strike/tau/sigma fixed)", () => {
    const base = { strike: 100, tau: 0.5, sigma: 0.3 };
    let prev = -1;
    for (const spot of [80, 90, 95, 100, 105, 110, 120]) {
      const p = priceAboveStrike({ ...base, spot });
      expect(p).toBeGreaterThanOrEqual(prev);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
      prev = p;
    }
  });

  it("falls monotonically as strike increases (spot/tau/sigma fixed)", () => {
    const base = { spot: 100, tau: 0.5, sigma: 0.3 };
    let prev = 2;
    for (const strike of [80, 90, 100, 110, 120]) {
      const p = priceAboveStrike({ ...base, strike });
      expect(p).toBeLessThanOrEqual(prev);
      prev = p;
    }
  });

  it("pulls toward 0.5 as tau grows for an OTM strike (more time = more uncertainty)", () => {
    const base = { spot: 100, strike: 110, sigma: 0.3 };
    const short = priceAboveStrike({ ...base, tau: 0.01 });
    const long = priceAboveStrike({ ...base, tau: 5 });
    expect(short).toBeLessThan(long); // OTM gets MORE likely with more time
    expect(long).toBeLessThan(0.5);
  });

  it("deep ITM → ~1, deep OTM → ~0", () => {
    expect(priceAboveStrike({ spot: 200, strike: 100, tau: 0.1, sigma: 0.2 })).toBeGreaterThan(0.999);
    expect(priceAboveStrike({ spot: 50, strike: 100, tau: 0.1, sigma: 0.2 })).toBeLessThan(0.001);
  });

  it("above + below = 1 (complement identity)", () => {
    const inp = { spot: 105, strike: 100, tau: 0.5, sigma: 0.25 };
    expect(near(priceAboveStrike(inp) + priceBelowStrike(inp), 1)).toBe(true);
  });

  it("returns NaN on bad inputs (never silently 0.5)", () => {
    expect(Number.isNaN(priceAboveStrike({ spot: -1, strike: 100, tau: 1, sigma: 0.2 }))).toBe(true);
    expect(Number.isNaN(priceAboveStrike({ spot: 100, strike: 0, tau: 1, sigma: 0.2 }))).toBe(true);
    expect(Number.isNaN(priceAboveStrike({ spot: 100, strike: 100, tau: -1, sigma: 0.2 }))).toBe(true);
    expect(Number.isNaN(priceAboveStrike({ spot: 100, strike: 100, tau: 1, sigma: -0.2 }))).toBe(true);
  });

  it("a positive move makes the up-side richer — the core maker signal", () => {
    // BTC at the open of an hourly Up/Down market, then ticks up 0.6%.
    const open = 62_000;
    const tauHr = 0.5;
    const sigma = 0.04; // per-√hour
    const atOpen = priceAboveStrike({ spot: open, strike: open, tau: tauHr, sigma });
    const afterUp = priceAboveStrike({ spot: open * 1.006, strike: open, tau: tauHr, sigma });
    expect(near(atOpen, 0.5, 1e-9)).toBe(true);
    expect(afterUp).toBeGreaterThan(0.5);
    // A stale market still showing 0.50 is now mispriced by (afterUp − 0.50):
    expect(afterUp - 0.5).toBeGreaterThan(0.02);
  });
});

describe("scaleVol", () => {
  it("scales per-minute vol to per-hour by √60", () => {
    const perMin = 0.001;
    expect(near(scaleVol(perMin, 60, 3600), perMin * Math.sqrt(60))).toBe(true);
  });
  it("is identity when units match", () => {
    expect(near(scaleVol(0.05, 3600, 3600), 0.05)).toBe(true);
  });
  it("NaN on bad inputs", () => {
    expect(Number.isNaN(scaleVol(-1, 60, 3600))).toBe(true);
    expect(Number.isNaN(scaleVol(0.01, 0, 3600))).toBe(true);
  });
});

describe("fairValueFromMinuteCloses", () => {
  // Build a flat-ish price path with a tiny known per-minute vol.
  function path(n: number, start: number, step: number): number[] {
    const out: number[] = [];
    let p = start;
    for (let i = 0; i < n; i++) {
      p = p * (1 + (i % 2 === 0 ? step : -step)); // alternating ± → nonzero sample vol
      out.push(p);
    }
    return out;
  }

  it("returns a coherent fair value for an above-strike market", () => {
    const closes = path(60, 62_000, 0.0005);
    const spot = closes.at(-1)!;
    const res = fairValueFromMinuteCloses({
      spot,
      strike: 62_000,
      nowMs: 1_000_000_000_000,
      expiryMs: 1_000_000_000_000 + 30 * 60_000, // 30 min out
      minuteCloses: closes,
      volBars: 30,
    });
    expect(res).not.toBeNull();
    expect(res!.pFair).toBeGreaterThanOrEqual(0);
    expect(res!.pFair).toBeLessThanOrEqual(1);
    expect(near(res!.tauHours, 0.5, 1e-9)).toBe(true);
    expect(res!.sigmaPerHour).toBeGreaterThan(0);
  });

  it("returns null when expiry already passed or too few bars", () => {
    const closes = path(60, 62_000, 0.0005);
    expect(
      fairValueFromMinuteCloses({
        spot: 62_000, strike: 62_000, nowMs: 2_000, expiryMs: 1_000, minuteCloses: closes,
      }),
    ).toBeNull();
    expect(
      fairValueFromMinuteCloses({
        spot: 62_000, strike: 62_000, nowMs: 1_000, expiryMs: 1_000 + 60_000, minuteCloses: closes.slice(0, 5), volBars: 30,
      }),
    ).toBeNull();
  });

  it("a higher spot vs the same strike yields a higher pFair", () => {
    const closes = path(60, 62_000, 0.0005);
    const common = { strike: 62_000, nowMs: 1e12, expiryMs: 1e12 + 30 * 60_000, minuteCloses: closes, volBars: 30 };
    const lo = fairValueFromMinuteCloses({ ...common, spot: 61_800 })!;
    const hi = fairValueFromMinuteCloses({ ...common, spot: 62_300 })!;
    expect(hi.pFair).toBeGreaterThan(lo.pFair);
  });
});

// ── deterministic synthetic paths for the estimator tests ──

/** Trending path with alternating noise: per-bar log-return = drift ± noise. */
function trendPath(n: number, start: number, driftPerBar: number, noise: number): number[] {
  const out: number[] = [];
  let lnP = Math.log(start);
  for (let i = 0; i < n; i++) {
    lnP += driftPerBar + (i % 2 === 0 ? noise : -noise);
    out.push(Math.exp(lnP));
  }
  return out;
}

/** Block-persistent path: same-sign return runs of `block` bars (positive autocorrelation). */
function blockPath(n: number, start: number, step: number, block: number): number[] {
  const out: number[] = [];
  let lnP = Math.log(start);
  for (let i = 0; i < n; i++) {
    const sign = Math.floor(i / block) % 2 === 0 ? 1 : -1;
    lnP += sign * step;
    out.push(Math.exp(lnP));
  }
  return out;
}

describe("estimateDriftPerBar", () => {
  it("finds a sustained trend (positive mu, shrink → 1)", () => {
    // drift 4x the noise per bar — unambiguous trend
    const closes = trendPath(200, 62_000, 0.0008, 0.0002);
    const de = estimateDriftPerBar(closes)!;
    expect(de).not.toBeNull();
    expect(de.muPerBar).toBeGreaterThan(0);
    expect(de.shrink).toBeGreaterThan(0.9);
    expect(de.muShrunkPerBar).toBeGreaterThan(0.0005);
  });

  it("shrinks a flat choppy tape to ~zero (no false momentum)", () => {
    // pure alternating ±: EWMA mean ≈ 0, t ≈ 0 → shrink kills it
    const closes = trendPath(200, 62_000, 0, 0.0005);
    const de = estimateDriftPerBar(closes)!;
    expect(Math.abs(de.muShrunkPerBar)).toBeLessThan(1e-5);
    expect(de.shrink).toBeLessThan(0.5);
  });

  it("shrink is always in [0,1)", () => {
    for (const drift of [-0.001, 0, 0.0003, 0.002]) {
      const de = estimateDriftPerBar(trendPath(150, 100, drift, 0.0004))!;
      expect(de.shrink).toBeGreaterThanOrEqual(0);
      expect(de.shrink).toBeLessThan(1);
    }
  });

  it("returns null on too-few bars or bad half-life", () => {
    expect(estimateDriftPerBar([100, 101, 102])).toBeNull();
    expect(estimateDriftPerBar(trendPath(100, 100, 0.001, 0.0002), { halfLifeBars: 0 })).toBeNull();
  });

  it("zero-vol path → zero drift signal, not NaN", () => {
    const flat = Array.from({ length: 50 }, () => 100);
    const de = estimateDriftPerBar(flat)!;
    expect(de.muShrunkPerBar).toBe(0);
    expect(Number.isFinite(de.tStat)).toBe(true);
  });
});

describe("estimateHorizonSigma", () => {
  it("alternating (mean-reverting) returns → VR < 1, H clamps below 0.5", () => {
    const closes = trendPath(300, 62_000, 0, 0.0005); // pure ± alternation
    const hs = estimateHorizonSigma(closes, { aggBars: 10 })!;
    expect(hs.varianceRatio).toBeLessThan(1);
    expect(hs.hurst).toBeLessThan(0.5);
    expect(hs.hurst).toBeGreaterThanOrEqual(0.35); // clamped
  });

  it("block-persistent returns → VR > 1, H above 0.5", () => {
    const closes = blockPath(300, 62_000, 0.0004, 20); // 20-bar same-sign runs
    const hs = estimateHorizonSigma(closes, { aggBars: 10 })!;
    expect(hs.varianceRatio).toBeGreaterThan(1);
    expect(hs.hurst).toBeGreaterThan(0.5);
    expect(hs.hurst).toBeLessThanOrEqual(0.7); // clamped
  });

  it("falls back to H=0.5 when the buffer is too short for the VR", () => {
    const closes = trendPath(30, 62_000, 0, 0.0005);
    const hs = estimateHorizonSigma(closes, { aggBars: 15 })!; // needs ≥ 60 returns
    expect(hs.hurst).toBe(0.5);
    expect(hs.varianceRatio).toBe(1);
  });

  it("returns null on bad inputs", () => {
    expect(estimateHorizonSigma([100, 101], { aggBars: 10 })).toBeNull();
    expect(estimateHorizonSigma(trendPath(100, 100, 0, 0.001), { aggBars: 1 })).toBeNull();
  });
});

describe("fairValueFromMinuteCloses — momentum + horizonVol upgrades", () => {
  const NOW = 1e12;

  it("defaults (both OFF) are bit-identical to the original model", () => {
    const closes = trendPath(200, 62_000, 0.0006, 0.0002);
    const spot = closes.at(-1)!;
    const common = { spot, strike: 62_500, nowMs: NOW, expiryMs: NOW + 4 * 3_600_000, minuteCloses: closes, volBars: 30 };
    const base = fairValueFromMinuteCloses(common)!;
    const explicit = fairValueFromMinuteCloses({ ...common, momentum: false, horizonVol: false })!;
    expect(base.pFair).toBe(explicit.pFair);
    expect(base.muPerHour).toBe(0);
    expect(base.hurst).toBe(0.5);
  });

  it("momentum on an uptrend raises pFair above the zero-drift baseline", () => {
    const closes = trendPath(200, 62_000, 0.0006, 0.0002);
    const spot = closes.at(-1)!;
    const common = { spot, strike: spot, nowMs: NOW, expiryMs: NOW + 2 * 3_600_000, minuteCloses: closes, volBars: 30 };
    const base = fairValueFromMinuteCloses(common)!;
    const mom = fairValueFromMinuteCloses({ ...common, momentum: true })!;
    expect(near(base.pFair, 0.5, 1e-6)).toBe(true); // ATM, zero drift
    expect(mom.pFair).toBeGreaterThan(base.pFair);
    expect(mom.muPerHour).toBeGreaterThan(0);
  });

  it("momentum on a flat choppy tape ≈ baseline (shrinkage holds)", () => {
    const closes = trendPath(200, 62_000, 0, 0.0004);
    const spot = closes.at(-1)!;
    const common = { spot, strike: spot, nowMs: NOW, expiryMs: NOW + 2 * 3_600_000, minuteCloses: closes, volBars: 30 };
    const base = fairValueFromMinuteCloses(common)!;
    const mom = fairValueFromMinuteCloses({ ...common, momentum: true })!;
    expect(Math.abs(mom.pFair - base.pFair)).toBeLessThan(0.01);
  });

  it("the drift cap binds: total tilt never exceeds capSigmaMult·σ_total (Φ(±cap) bound)", () => {
    // violent trend, tiny noise → uncapped drift would push pFair → 1
    const closes = trendPath(200, 62_000, 0.003, 0.0003);
    const spot = closes.at(-1)!;
    const common = { spot, strike: spot, nowMs: NOW, expiryMs: NOW + 6 * 3_600_000, minuteCloses: closes, volBars: 30 };
    const cap1 = fairValueFromMinuteCloses({ ...common, momentum: { capSigmaMult: 1 } })!;
    // |drift_total| ≤ 1·σ_total ⇒ d = drift_total/σ_total ≤ 1 ⇒ pFair ≤ Φ(1)
    expect(cap1.pFair).toBeLessThanOrEqual(normCdf(1) + 1e-9);
    const cap0 = fairValueFromMinuteCloses({ ...common, momentum: { capSigmaMult: 0 } })!;
    const base = fairValueFromMinuteCloses(common)!;
    expect(near(cap0.pFair, base.pFair, 1e-9)).toBe(true); // cap 0 ⇒ momentum disabled
  });

  it("horizonVol on a mean-reverting tape shrinks σ → OTM pFair drops vs baseline", () => {
    const closes = trendPath(300, 62_000, 0, 0.0005); // alternating ⇒ H < 0.5
    const spot = closes.at(-1)!;
    const common = { spot, strike: spot * 1.01, nowMs: NOW, expiryMs: NOW + 8 * 3_600_000, minuteCloses: closes, volBars: 30 };
    const base = fairValueFromMinuteCloses(common)!;
    const hv = fairValueFromMinuteCloses({ ...common, horizonVol: true })!;
    expect(hv.hurst).toBeLessThan(0.5);
    expect(hv.sigmaPerHour).toBeLessThan(base.sigmaPerHour);
    expect(hv.pFair).toBeLessThan(base.pFair); // less vol ⇒ OTM less likely
  });

  it("horizonVol on a persistent tape grows σ → OTM pFair rises vs baseline", () => {
    const closes = blockPath(300, 62_000, 0.0004, 20); // H > 0.5
    const spot = closes.at(-1)!;
    const common = { spot, strike: spot * 1.01, nowMs: NOW, expiryMs: NOW + 8 * 3_600_000, minuteCloses: closes, volBars: 30 };
    const base = fairValueFromMinuteCloses(common)!;
    const hv = fairValueFromMinuteCloses({ ...common, horizonVol: true })!;
    expect(hv.hurst).toBeGreaterThan(0.5);
    expect(hv.sigmaPerHour).toBeGreaterThan(base.sigmaPerHour);
    expect(hv.pFair).toBeGreaterThan(base.pFair);
  });
});
