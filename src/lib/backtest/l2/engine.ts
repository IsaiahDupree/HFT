/**
 * Event-driven L2 backtester for binary-CLOB market making — TS port of the
 * zostaff handbook §10. Unlike the snapshot/mark-to-midpoint replayer in
 * ../engine.ts, this models QUEUE POSITION, partial fills, sequential causality,
 * injectable latency, and per-fill maker/taker accounting (Polymarket V2 fees).
 * That is what makes AS market-making *validatable* before any capital.
 *
 * Strategies are callbacks: each market event is applied to the book, then the
 * strategy is invoked and may place/cancel orders (which arrive after latency).
 * A strategy can never see a future event — enforced by the time-ordered heap.
 */
import { makerRebate, takerFee, type FeeCategory } from "@/lib/strategies/as-market-maker";

export type OrderSide = "bid" | "ask";

export type L2Event =
  | { ts: number; seq: number; kind: "book"; bidPx: number; bidSz: number; askPx: number; askSz: number }
  | { ts: number; seq: number; kind: "trade"; price: number; size: number; aggressor: "BUY" | "SELL" }
  | { ts: number; seq: number; kind: "place"; oid: number; side: OrderSide; price: number; size: number; queueAhead: number }
  | { ts: number; seq: number; kind: "cancel"; oid: number };

/** Market-data event without the engine-assigned seq (the caller supplies these). */
export type MarketEvent =
  | { ts: number; kind: "book"; bidPx: number; bidSz: number; askPx: number; askSz: number }
  | { ts: number; kind: "trade"; price: number; size: number; aggressor: "BUY" | "SELL" };

export type RestingOrder = { id: number; side: OrderSide; price: number; size: number; queueAhead: number; placedAt: number };
export type Fill = { ts: number; side: OrderSide; price: number; qty: number; isMaker: boolean; timeToFill: number };

export type BacktestSummary = {
  pnl: number;
  nFills: number;
  nMakerFills: number;
  nTakerFills: number;
  finalInventory: number;
  feesPaid: number;
  rebatesReceived: number;
  netFees: number;
  fills: Fill[];
};

export type Strategy = (bt: L2Backtester, ev: L2Event) => void;

// Binary min-heap keyed by (ts, seq) — stable time ordering with FIFO ties.
class MinHeap {
  private a: L2Event[] = [];
  get size(): number { return this.a.length; }
  private less(i: number, j: number): boolean {
    const x = this.a[i], y = this.a[j];
    return x.ts !== y.ts ? x.ts < y.ts : x.seq < y.seq;
  }
  push(e: L2Event): void {
    this.a.push(e);
    let i = this.a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (this.less(i, p)) { [this.a[i], this.a[p]] = [this.a[p], this.a[i]]; i = p; } else break; }
  }
  pop(): L2Event | undefined {
    const n = this.a.length;
    if (n === 0) return undefined;
    const top = this.a[0];
    const last = this.a.pop()!;
    if (n > 1) {
      this.a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2; let m = i;
        if (l < this.a.length && this.less(l, m)) m = l;
        if (r < this.a.length && this.less(r, m)) m = r;
        if (m === i) break;
        [this.a[i], this.a[m]] = [this.a[m], this.a[i]]; i = m;
      }
    }
    return top;
  }
}

export class L2Backtester {
  readonly latencyMs: number;
  readonly feeCategory: FeeCategory;
  readonly tick: number;
  /** Flat per-notional fees (bps) for CONTINUOUS venues (dYdX/Coinbase $). When
   *  set, overrides the Polymarket V2 binary fee curve. Negative maker = rebate. */
  readonly feeBps?: { maker: number; taker: number };
  book = { bidPx: 0, bidSz: 0, askPx: 1, askSz: 0 };
  orders = new Map<number, RestingOrder>();
  nextOrderId = 1;
  inventory = 0;
  cash = 0;
  fills: Fill[] = [];
  feesPaid = 0;
  rebatesReceived = 0;
  private heap = new MinHeap();
  private seq = 0;

  constructor(opts: { latencyMs?: number; feeCategory?: FeeCategory; tick?: number; feeBps?: { maker: number; taker: number } } = {}) {
    this.latencyMs = opts.latencyMs ?? 50;
    this.feeCategory = opts.feeCategory ?? "geopolitics"; // default fee-free
    this.tick = opts.tick ?? 0.001;
    this.feeBps = opts.feeBps;
  }

  mid(): number { return (this.book.bidPx + this.book.askPx) / 2; }

  /** Strategy API: place a resting limit; arrival delayed by latency. Returns oid. */
  placeLimit(tDecision: number, side: OrderSide, price: number, size: number): number {
    const oid = this.nextOrderId++;
    const queueAhead = side === "bid" ? this.book.bidSz : this.book.askSz;
    this.heap.push({ ts: tDecision + this.latencyMs / 1000, seq: this.seq++, kind: "place", oid, side, price, size, queueAhead });
    return oid;
  }
  /** Strategy API: cancel a resting order; arrival delayed by latency. */
  cancel(tDecision: number, oid: number): void {
    this.heap.push({ ts: tDecision + this.latencyMs / 1000, seq: this.seq++, kind: "cancel", oid });
  }

  run(events: MarketEvent[], strategy: Strategy): BacktestSummary {
    for (const ev of events) this.heap.push({ ...ev, seq: this.seq++ } as L2Event);
    for (;;) {
      const ev = this.heap.pop();
      if (!ev) break;
      switch (ev.kind) {
        case "book":
          this.book = { bidPx: ev.bidPx, bidSz: ev.bidSz, askPx: ev.askPx, askSz: ev.askSz };
          this.updateQueuePositions();
          break;
        case "trade": this.processTrade(ev); break;
        case "place": this.orders.set(ev.oid, { id: ev.oid, side: ev.side, price: ev.price, size: ev.size, queueAhead: ev.queueAhead, placedAt: ev.ts }); break;
        case "cancel": this.orders.delete(ev.oid); break;
      }
      strategy(this, ev);
    }
    return this.summary();
  }

  private processTrade(ev: Extract<L2Event, { kind: "trade" }>): void {
    const mySide: OrderSide = ev.aggressor === "BUY" ? "ask" : "bid"; // buy aggressor hits asks
    let remaining = ev.size;
    for (const order of Array.from(this.orders.values())) {
      if (order.side !== mySide) continue;
      if (mySide === "bid" && ev.price > order.price) continue; // trade above our bid → not hit
      if (mySide === "ask" && ev.price < order.price) continue; // trade below our ask → not hit
      if (remaining <= order.queueAhead) { order.queueAhead -= remaining; remaining = 0; break; }
      remaining -= order.queueAhead; order.queueAhead = 0;
      const fill = Math.min(remaining, order.size);
      this.recordFill(order, fill, ev.ts, true);
      order.size -= fill; remaining -= fill;
      if (order.size <= 1e-9) this.orders.delete(order.id);
      if (remaining <= 1e-9) break;
    }
  }

  private recordFill(order: RestingOrder, qty: number, ts: number, isMaker: boolean): void {
    const sign = order.side === "bid" ? 1 : -1; // bid fill → long, ask fill → short
    const notional = qty * order.price;
    if (isMaker) {
      // flat-bps (continuous venues): negative maker bps = rebate; else binary curve.
      const rebate = this.feeBps ? -this.feeBps.maker / 1e4 * notional : makerRebate(order.price, qty, this.feeCategory);
      this.rebatesReceived += rebate;
      this.cash += -sign * notional + rebate;
    } else {
      const fee = this.feeBps ? this.feeBps.taker / 1e4 * notional : takerFee(order.price, qty, this.feeCategory);
      this.feesPaid += fee;
      this.cash += -sign * notional - fee;
    }
    this.inventory += sign * qty;
    this.fills.push({ ts, side: order.side, price: order.price, qty, isMaker, timeToFill: ts - order.placedAt });
  }

  /** Heuristic queue advance on book updates (handbook §10; swap for full L2 later). */
  private updateQueuePositions(): void {
    for (const order of this.orders.values()) {
      const levelSize = order.side === "bid" ? this.book.bidSz : this.book.askSz;
      const totalBefore = order.queueAhead + order.size;
      if (levelSize < totalBefore) {
        const shrink = totalBefore - levelSize;
        const fromFront = shrink * 0.5;
        const fromAnywhere = shrink * 0.5 * (order.queueAhead / Math.max(totalBefore, 1e-9));
        order.queueAhead = Math.max(0, order.queueAhead - fromFront - fromAnywhere);
      }
    }
  }

  summary(): BacktestSummary {
    const mid = this.mid();
    const pnl = this.cash + this.inventory * mid;
    const nMaker = this.fills.filter((f) => f.isMaker).length;
    return {
      pnl,
      nFills: this.fills.length,
      nMakerFills: nMaker,
      nTakerFills: this.fills.length - nMaker,
      finalInventory: this.inventory,
      feesPaid: this.feesPaid,
      rebatesReceived: this.rebatesReceived,
      netFees: this.feesPaid - this.rebatesReceived,
      fills: this.fills,
    };
  }
}
