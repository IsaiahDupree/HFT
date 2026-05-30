/**
 * Microstructure signals for the L2 backtester (handbook §8): Order Flow
 * Imbalance (Cont-Kukanov-Stoikov), binary-normalized VPIN toxicity, a streaming
 * SignalEngine that computes {microprice, ofi, vpin} from a MarketEvent stream,
 * and the OFI→α calibration regression. Pure + deterministic; works identically
 * on synthetic events and real Polymarket L2 captures.
 */
import { microprice } from "@/lib/strategies/as-market-maker";
import type { MarketEvent } from "./engine";

/** Cont-Kukanov-Stoikov Order Flow Imbalance over a rolling time window. */
export class OFICalculator {
  private readonly windowSec: number;
  private events: Array<{ ts: number; e: number }> = [];
  private prevBidPx: number | null = null;
  private prevBidSz = 0;
  private prevAskPx = 0;
  private prevAskSz = 0;

  constructor(windowSec = 1.0) { this.windowSec = windowSec; }

  update(ts: number, bidPx: number, bidSz: number, askPx: number, askSz: number): number {
    if (this.prevBidPx === null) {
      this.prevBidPx = bidPx; this.prevBidSz = bidSz; this.prevAskPx = askPx; this.prevAskSz = askSz;
      return 0;
    }
    // bid contribution
    let eBid: number;
    if (bidPx > this.prevBidPx) eBid = bidSz;
    else if (bidPx < this.prevBidPx) eBid = -this.prevBidSz;
    else eBid = bidSz - this.prevBidSz;
    // ask contribution (sign flipped)
    let eAsk: number;
    if (askPx < this.prevAskPx) eAsk = -askSz;
    else if (askPx > this.prevAskPx) eAsk = this.prevAskSz;
    else eAsk = -(askSz - this.prevAskSz);

    this.events.push({ ts, e: eBid + eAsk });
    while (this.events.length && ts - this.events[0].ts > this.windowSec) this.events.shift();

    this.prevBidPx = bidPx; this.prevBidSz = bidSz; this.prevAskPx = askPx; this.prevAskSz = askSz;
    return this.events.reduce((s, x) => s + x.e, 0);
  }
}

/** Volume-bucketed, binary-normalized VPIN (adverse-selection toxicity), 0..1+. */
export class VPINCalculator {
  private readonly bucketVolume: number;
  private readonly nBuckets: number;
  private buckets: Array<{ buy: number; sell: number; p: number }> = [];
  private curBuy = 0;
  private curSell = 0;
  private curPSum = 0;
  private curN = 0;

  constructor(bucketVolume = 5000, nBuckets = 50) { this.bucketVolume = bucketVolume; this.nBuckets = nBuckets; }

  addTrade(volume: number, isBuy: boolean, p: number): void {
    if (isBuy) this.curBuy += volume; else this.curSell += volume;
    this.curPSum += p; this.curN += 1;
    while (this.curBuy + this.curSell >= this.bucketVolume) {
      const pMean = this.curPSum / Math.max(this.curN, 1);
      this.buckets.push({ buy: this.curBuy, sell: this.curSell, p: pMean });
      if (this.buckets.length > this.nBuckets) this.buckets.shift();
      const total = this.curBuy + this.curSell;
      const excess = total - this.bucketVolume;
      const ratio = total > 0 ? this.curSell / total : 0.5;
      this.curSell = excess * ratio; this.curBuy = excess * (1 - ratio);
      this.curPSum = pMean; this.curN = 1;
    }
  }

  vpin(): number {
    if (this.buckets.length === 0) return 0;
    let total = 0;
    for (const b of this.buckets) {
      const denom = Math.sqrt(Math.max(1e-12, b.p * (1 - b.p))) * (b.buy + b.sell);
      if (denom > 0) total += Math.abs(b.buy - b.sell) / denom;
    }
    return total / this.buckets.length;
  }
}

export type Signals = { ts: number; microprice: number; ofi: number; vpin: number };

/** Streaming engine: feed it the MarketEvent stream; it emits Signals on books. */
export class SignalEngine {
  private ofiCalc: OFICalculator;
  private vpinCalc: VPINCalculator;
  private lastMid = 0.5;

  constructor(opts: { ofiWindowSec?: number; vpinBucketVolume?: number; vpinBuckets?: number } = {}) {
    this.ofiCalc = new OFICalculator(opts.ofiWindowSec ?? 1.0);
    this.vpinCalc = new VPINCalculator(opts.vpinBucketVolume ?? 5000, opts.vpinBuckets ?? 50);
  }

  onEvent(ev: MarketEvent): Signals | null {
    if (ev.kind === "trade") {
      this.vpinCalc.addTrade(ev.size, ev.aggressor === "BUY", this.lastMid);
      return null;
    }
    const mp = microprice(ev.bidPx, ev.bidSz, ev.askPx, ev.askSz);
    this.lastMid = mp;
    const ofi = this.ofiCalc.update(ev.ts, ev.bidPx, ev.bidSz, ev.askPx, ev.askSz);
    return { ts: ev.ts, microprice: mp, ofi, vpin: this.vpinCalc.vpin() };
  }
}

/**
 * Fit Δx_{t+h} ≈ β·OFI_t over book events (x = logit microprice). Returns the
 * slope, R², residual std. R² > 0.2 in-sample is a LEAK warning, not a win —
 * the OFI→price relationship is genuinely weak per-event (handbook §8.5).
 */
export function calibrateOfiAlpha(events: MarketEvent[], opts: { horizonSec?: number; ofiWindowSec?: number } = {}): { alphaBeta: number; r2: number; residualStd: number; n: number } {
  const h = opts.horizonSec ?? 1.0;
  const ofiCalc = new OFICalculator(opts.ofiWindowSec ?? 1.0);
  const rows: Array<{ ts: number; x: number; ofi: number }> = [];
  for (const ev of events) {
    if (ev.kind !== "book") continue;
    const mp = Math.min(1 - 1e-6, Math.max(1e-6, microprice(ev.bidPx, ev.bidSz, ev.askPx, ev.askSz)));
    const x = Math.log(mp / (1 - mp));
    const ofi = ofiCalc.update(ev.ts, ev.bidPx, ev.bidSz, ev.askPx, ev.askSz);
    rows.push({ ts: ev.ts, x, ofi });
  }
  // forward Δx at horizon (last x with ts ≤ t+h)
  const pairs: Array<{ ofi: number; dx: number }> = [];
  let j = 0;
  for (let i = 0; i < rows.length; i++) {
    const tTarget = rows[i].ts + h;
    while (j < rows.length - 1 && rows[j + 1].ts <= tTarget) j++;
    if (rows[j].ts < rows[i].ts + 1e-9) continue; // no forward point
    pairs.push({ ofi: rows[i].ofi, dx: rows[j].x - rows[i].x });
  }
  // OLS through the origin: β = Σ(ofi·dx)/Σ(ofi²)
  let sxy = 0, sxx = 0, syy = 0;
  for (const p of pairs) { sxy += p.ofi * p.dx; sxx += p.ofi * p.ofi; syy += p.dx * p.dx; }
  const beta = sxx > 0 ? sxy / sxx : 0;
  let ssr = 0;
  for (const p of pairs) { const r = p.dx - beta * p.ofi; ssr += r * r; }
  const r2 = syy > 0 ? Math.max(0, 1 - ssr / syy) : 0;
  const residualStd = pairs.length > 1 ? Math.sqrt(ssr / (pairs.length - 1)) : 0;
  return { alphaBeta: beta, r2, residualStd, n: pairs.length };
}
