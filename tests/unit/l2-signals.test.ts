/**
 * Unit tests for the microstructure signals: OFI (Cont-Kukanov-Stoikov), VPIN
 * toxicity, the streaming SignalEngine, and the OFI→α calibration regression.
 */
import { describe, it, expect } from "vitest";
import { OFICalculator, VPINCalculator, SignalEngine, calibrateOfiAlpha } from "@/lib/backtest/l2/signals";
import { generateSyntheticEvents } from "@/lib/backtest/l2/synthetic";
import type { MarketEvent } from "@/lib/backtest/l2/engine";

describe("OFI", () => {
  it("rising bid size → positive flow; rising ask size → negative flow", () => {
    const up = new OFICalculator(10);
    up.update(0, 0.49, 100, 0.51, 100); // prime
    expect(up.update(1, 0.49, 180, 0.51, 100)).toBeGreaterThan(0); // bid grew → buy pressure
    const dn = new OFICalculator(10);
    dn.update(0, 0.49, 100, 0.51, 100);
    expect(dn.update(1, 0.49, 100, 0.51, 180)).toBeLessThan(0); // ask grew → sell pressure
  });
  it("a bid price uptick contributes the full new bid size", () => {
    const o = new OFICalculator(10);
    o.update(0, 0.49, 100, 0.51, 100);
    expect(o.update(1, 0.50, 70, 0.51, 100)).toBe(70); // bidPx up → e_bid = new bidSz
  });
});

describe("VPIN", () => {
  it("balanced flow → low, one-sided flow → high toxicity", () => {
    const balanced = new VPINCalculator(100, 10);
    for (let i = 0; i < 10; i++) { balanced.addTrade(50, true, 0.5); balanced.addTrade(50, false, 0.5); }
    const toxic = new VPINCalculator(100, 10);
    for (let i = 0; i < 10; i++) toxic.addTrade(100, true, 0.5);
    expect(toxic.vpin()).toBeGreaterThan(balanced.vpin());
  });
});

describe("SignalEngine", () => {
  it("emits signals on book events and folds trades into VPIN", () => {
    const eng = new SignalEngine({ vpinBucketVolume: 50, vpinBuckets: 5 });
    const events: MarketEvent[] = [
      { ts: 0, kind: "book", bidPx: 0.49, bidSz: 100, askPx: 0.51, askSz: 100 },
      { ts: 1, kind: "trade", price: 0.51, size: 60, aggressor: "BUY" },
      { ts: 2, kind: "book", bidPx: 0.49, bidSz: 120, askPx: 0.51, askSz: 100 },
    ];
    const out = events.map((e) => eng.onEvent(e));
    expect(out[0]).not.toBeNull();
    expect(out[1]).toBeNull(); // trade → no signal emitted, but feeds VPIN
    expect(out[2]!.vpin).toBeGreaterThan(0); // one-sided buy registered
    expect(out[2]!.microprice).toBeGreaterThan(0);
  });
});

describe("calibrateOfiAlpha", () => {
  it("returns a finite slope, R² in [0,1], and a positive sample count", () => {
    const c = calibrateOfiAlpha(generateSyntheticEvents({ n: 1000, seed: 3 }), { horizonSec: 1 });
    expect(Number.isFinite(c.alphaBeta)).toBe(true);
    expect(c.r2).toBeGreaterThanOrEqual(0);
    expect(c.r2).toBeLessThanOrEqual(1);
    expect(c.n).toBeGreaterThan(0);
  });

  it("logprice space measures OFI→price on dollar-priced (continuous) books; logit clamps to ~0", () => {
    // dollar-scale prices (>1) so the logit clamp pins every x to ~log(1/1e-6).
    // Bid-size growth (positive OFI) precedes an up-tick; ask-size growth precedes a down-tick.
    const events: MarketEvent[] = [];
    let px = 100;
    for (let t = 0; t < 200; t++) {
      const buyPressure = t % 2 === 0;
      events.push({ ts: t, kind: "book", bidPx: px - 0.05, bidSz: buyPressure ? 200 : 100, askPx: px + 0.05, askSz: buyPressure ? 100 : 200 });
      px += buyPressure ? 0.02 : -0.02;
    }
    const lp = calibrateOfiAlpha(events, { horizonSec: 1, ofiWindowSec: 1, space: "logprice" });
    const lo = calibrateOfiAlpha(events, { horizonSec: 1, ofiWindowSec: 1, space: "logit" });
    expect(lp.n).toBeGreaterThan(0);
    expect(Math.abs(lp.alphaBeta)).toBeGreaterThan(0); // real signal recovered in price space
    expect(lp.r2).toBeGreaterThan(0);
    expect(lo.r2).toBe(0);                              // logit clamp → degenerate on dollar prices
  });
});
