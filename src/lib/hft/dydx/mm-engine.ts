// Stateful market-making engine extracted from scripts/dydx-mm.ts so it can be
// driven from either the CLI or an API route.
//
// Lifecycle:
//   const engine = await MmEngine.create({ market, cfg, net });
//   engine.start();   // returns immediately; loop runs in background
//   engine.getStatus();
//   await engine.stop("user-requested");
//
// A single Node process should host at most one engine per (address, market)
// to avoid duplicate quotes. The API layer enforces a singleton.
import type { CompositeClient, IndexerClient, SubaccountInfo } from "@dydxprotocol/v4-client-js";
import {
  applyFill,
  computeQuotes,
  freshPnl,
  shouldReplace,
  type Fill,
  type MarketParams,
  type MmConfig,
  type PnlState,
} from "./mm";
import {
  computeMicroprice,
  computeOBI,
  obiWidenMultiplier,
  quotedSpreadBps,
  type BookLevel,
} from "./signals";
import { makeCompositeClient, makeIndexerClient } from "./clients";
import { loadWallet } from "./wallet";
import type { DydxNet } from "./network";
import { sdk } from "./_sdk";

const { OrderExecution, OrderSide, OrderTimeInForce, OrderType } = sdk;

export type Side = "BUY" | "SELL";

export type Resting = { clientId: number; price: number; size: number };

export type CycleSnapshot = {
  cycle: number;
  ts: number;
  oracle: number;
  microprice: number | null;
  fair: number;
  obi: number;
  quotedSpreadBps: number | null;
  widenMult: number;
  paused: false | "stale-data" | "spread-anomaly";
  position: number;
  inventoryUsd: number;
  bid: number | null;
  ask: number | null;
  skewBps: number;
  ms: number;
};

export type EngineStatus = {
  running: boolean;
  net: DydxNet;
  address: string;
  subaccountNumber: number;
  market: string;
  cfg: MmConfig;
  tickMs: number;
  goodTilSec: number;
  startedAt: number | null;
  stoppedAt: number | null;
  cycles: number;
  fillsCount: number;
  resting: { BUY: Resting | null; SELL: Resting | null };
  pnl: {
    position: number;
    vwap: number;
    realisedUsd: number;
    feesUsd: number;
    unrealisedUsd: number;
    mark: number;
  };
  lastError: string | null;
  recentCycles: CycleSnapshot[];
  recentFills: Fill[];
};

export type EngineConfig = {
  net: DydxNet;
  market: string;
  cfg: MmConfig;
  tickMs?: number;
  goodTilSec?: number;
  /** Cap on snapshots/fills retained in memory for the status endpoint. */
  historyCap?: number;
};

export class MmEngine {
  private composite!: CompositeClient;
  private indexer!: IndexerClient;
  private subaccount!: SubaccountInfo;
  private address!: string;
  private subaccountNumber!: number;
  private mkt: MarketParams | null = null;

  private resting: Record<Side, Resting | null> = { BUY: null, SELL: null };
  private pnl: PnlState = freshPnl();
  private seenFillIds = new Set<string>();
  private lastOracle = 0;
  private lastSuccessfulSnapshotAt: number | null = null;

  private running = false;
  private stopReason: string | null = null;
  private cycles = 0;
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;
  private lastError: string | null = null;
  private cycleLog: CycleSnapshot[] = [];
  private fillLog: Fill[] = [];

  private loopPromise: Promise<void> | null = null;

  private constructor(public readonly opts: Required<EngineConfig>) {}

  static async create(opts: EngineConfig): Promise<MmEngine> {
    const full: Required<EngineConfig> = {
      tickMs: 6000,
      goodTilSec: 120,
      historyCap: 200,
      ...opts,
    };
    const engine = new MmEngine(full);
    const w = await loadWallet(full.net);
    engine.address = w.address;
    engine.subaccountNumber = w.subaccountNumber;
    engine.subaccount = w.subaccount;
    engine.composite = await makeCompositeClient(full.net);
    engine.indexer = makeIndexerClient(full.net);
    return engine;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this.stoppedAt = null;
    this.stopReason = null;
    this.loopPromise = this.loop();
  }

  async stop(reason = "stop"): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.stopReason = reason;
    try {
      if (this.loopPromise) await this.loopPromise;
    } finally {
      this.loopPromise = null;
    }
    await this.cancelAll();
    this.stoppedAt = Date.now();
  }

  getStatus(): EngineStatus {
    const mark = this.lastOracle;
    const unrealisedUsd =
      this.pnl.position === 0
        ? 0
        : this.pnl.position > 0
        ? (mark - this.pnl.vwap) * this.pnl.position
        : (this.pnl.vwap - mark) * -this.pnl.position;
    return {
      running: this.running,
      net: this.opts.net,
      address: this.address,
      subaccountNumber: this.subaccountNumber,
      market: this.opts.market,
      cfg: this.opts.cfg,
      tickMs: this.opts.tickMs,
      goodTilSec: this.opts.goodTilSec,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      cycles: this.cycles,
      fillsCount: this.fillLog.length,
      resting: { BUY: this.resting.BUY, SELL: this.resting.SELL },
      pnl: {
        position: this.pnl.position,
        vwap: this.pnl.vwap,
        realisedUsd: this.pnl.realisedUsd,
        feesUsd: this.pnl.feesUsd,
        unrealisedUsd,
        mark,
      },
      lastError: this.lastError,
      recentCycles: this.cycleLog.slice(-Math.min(60, this.opts.historyCap)),
      recentFills: this.fillLog.slice(-Math.min(40, this.opts.historyCap)),
    };
  }

  private async loop(): Promise<void> {
    await this.sweepLeftover();
    while (this.running) {
      this.cycles++;
      const t0 = Date.now();
      let paused: false | "stale-data" | "spread-anomaly" = false;
      let snapData: Awaited<ReturnType<typeof this.snapshot>> | undefined;
      try {
        snapData = await this.snapshot();
        this.lastOracle = snapData.oracle;
        this.lastSuccessfulSnapshotAt = Date.now();
        await this.ingestFills(snapData.fills);
      } catch (e) {
        this.lastError = (e as Error).message;
        // Stale-data halt: if we haven't had a clean snapshot for > 3× tick,
        // pull any resting quotes to avoid trading off cold data.
        const ageMs = Date.now() - (this.lastSuccessfulSnapshotAt ?? 0);
        if (this.lastSuccessfulSnapshotAt && ageMs > this.opts.tickMs * 3) {
          paused = "stale-data";
          await this.flatten("stale-data");
        }
      }

      if (!paused && snapData) {
        if (!this.mkt) throw new Error("market params missing");
        const snap = snapData;
        const microprice = computeMicroprice(snap.bids, snap.asks);
        const obi = computeOBI(snap.bids, snap.asks, 5);
        const qspread = quotedSpreadBps(snap.bids, snap.asks);

        // Spread anomaly halt: book is so wide that it's almost certainly an
        // event (or empty book). Pull quotes for this cycle.
        const anomalyBps = this.opts.cfg.spreadAnomalyBps ?? 0;
        if (anomalyBps > 0 && qspread !== null && qspread > anomalyBps) {
          paused = "spread-anomaly";
          await this.flatten("spread-anomaly");
        }

        const fair = this.opts.cfg.useMicroprice && microprice !== null
          ? microprice
          : snap.oracle;

        const threshold = this.opts.cfg.obiToxicityThreshold ?? 0;
        const maxMult = this.opts.cfg.obiToxicityMaxMultiplier ?? 1;
        const widenMult = threshold > 0 ? obiWidenMultiplier(obi, threshold, maxMult) : 1;
        const effectiveCfg: MmConfig = widenMult === 1
          ? this.opts.cfg
          : { ...this.opts.cfg, halfSpreadBps: this.opts.cfg.halfSpreadBps * widenMult };

        let bidPx: number | null = null;
        let askPx: number | null = null;
        let skewBps = 0;
        if (!paused) {
          const quotes = computeQuotes(fair, snap.inventoryUsd, effectiveCfg, this.mkt);
          skewBps = quotes.skewBps;
          bidPx = quotes.bid?.price ?? null;
          askPx = quotes.ask?.price ?? null;

          for (const side of ["BUY", "SELL"] as Side[]) {
            const target = side === "BUY" ? quotes.bid : quotes.ask;
            const have = this.resting[side];
            if (!target) {
              if (have) { await this.cancelOrder(have.clientId); this.resting[side] = null; }
              continue;
            }
            if (!have) {
              const placed = await this.placeQuote(side, target.price, target.size);
              if (placed) this.resting[side] = placed;
            } else if (shouldReplace(have.price, target.price, effectiveCfg.driftBps)) {
              await this.cancelOrder(have.clientId);
              const placed = await this.placeQuote(side, target.price, target.size);
              this.resting[side] = placed;
            }
          }
          this.lastError = null;
        }

        this.cycleLog.push({
          cycle: this.cycles, ts: Date.now(),
          oracle: snap.oracle, microprice, fair,
          obi, quotedSpreadBps: qspread, widenMult, paused,
          position: snap.positionUnits, inventoryUsd: snap.inventoryUsd,
          bid: this.resting.BUY?.price ?? bidPx, ask: this.resting.SELL?.price ?? askPx,
          skewBps, ms: Date.now() - t0,
        });
        if (this.cycleLog.length > this.opts.historyCap) this.cycleLog.shift();
      } else if (paused) {
        this.cycleLog.push({
          cycle: this.cycles, ts: Date.now(),
          oracle: this.lastOracle, microprice: null, fair: this.lastOracle,
          obi: 0, quotedSpreadBps: null, widenMult: 1, paused,
          position: 0, inventoryUsd: 0,
          bid: null, ask: null, skewBps: 0, ms: Date.now() - t0,
        });
        if (this.cycleLog.length > this.opts.historyCap) this.cycleLog.shift();
      }

      if (!this.running) break;
      const elapsed = Date.now() - t0;
      await new Promise((r) => setTimeout(r, Math.max(0, this.opts.tickMs - elapsed)));
    }
  }

  private async flatten(_reason: string): Promise<void> {
    for (const side of ["BUY", "SELL"] as Side[]) {
      const r = this.resting[side];
      if (r) { await this.cancelOrder(r.clientId); this.resting[side] = null; }
    }
  }

  private async snapshot() {
    const [m, sub, fillsResp, ob] = await Promise.all([
      this.indexer.markets.getPerpetualMarkets(this.opts.market),
      this.indexer.account.getSubaccount(this.address, this.subaccountNumber),
      this.indexer.account.getSubaccountFills(this.address, this.subaccountNumber, this.opts.market, undefined, 50),
      this.indexer.markets.getPerpetualMarketOrderbook(this.opts.market),
    ]);
    const mInfo = (m as any)?.markets?.[this.opts.market];
    if (!mInfo) throw new Error(`market ${this.opts.market} not found`);
    if (!this.mkt) this.mkt = { tickSize: Number(mInfo.tickSize), stepSize: Number(mInfo.stepSize) };
    const oracle = Number(mInfo.oraclePrice);
    const fills = (fillsResp as any)?.fills ?? [];
    const pos = ((sub as any)?.subaccount?.openPerpetualPositions ?? {})[this.opts.market];
    const positionUnits = pos ? (pos.side === "LONG" ? +Number(pos.size) : -Number(pos.size)) : 0;
    const inventoryUsd = positionUnits * oracle;
    const bids: BookLevel[] = ((ob as any)?.bids ?? []).slice(0, 10).map((b: any) => ({ price: Number(b.price), size: Number(b.size) }));
    const asks: BookLevel[] = ((ob as any)?.asks ?? []).slice(0, 10).map((a: any) => ({ price: Number(a.price), size: Number(a.size) }));
    return { oracle, fills, positionUnits, inventoryUsd, bids, asks };
  }

  private async ingestFills(fills: any[]) {
    for (const f of [...fills].reverse()) {
      if (this.seenFillIds.has(f.id)) continue;
      if (f.market && f.market !== this.opts.market) continue;
      this.seenFillIds.add(f.id);
      const fill: Fill = {
        side: f.side === "BUY" ? "BUY" : "SELL",
        price: Number(f.price),
        size: Number(f.size),
        feeUsd: Number(f.fee ?? "0"),
        ts: Date.parse(f.createdAt ?? new Date().toISOString()),
      };
      this.pnl = applyFill(this.pnl, fill);
      this.fillLog.push(fill);
      if (this.fillLog.length > this.opts.historyCap) this.fillLog.shift();
      const rest = this.resting[fill.side];
      if (rest && Math.abs(rest.price - fill.price) / fill.price < 0.001) {
        this.resting[fill.side] = null;
      }
    }
  }

  private async cancelOrder(clientId: number): Promise<void> {
    try {
      await this.composite.cancelOrder(this.subaccount, clientId, 64, this.opts.market, 0, this.opts.goodTilSec);
    } catch (e) {
      this.lastError = `cancel ${clientId}: ${(e as Error).message.slice(0, 120)}`;
    }
  }

  private async placeQuote(side: Side, price: number, size: number): Promise<Resting | null> {
    const clientId = Math.floor(Math.random() * 0xffffffff);
    try {
      await this.composite.placeOrder(
        this.subaccount, this.opts.market,
        OrderType.LIMIT,
        side === "BUY" ? OrderSide.BUY : OrderSide.SELL,
        price, size, clientId,
        OrderTimeInForce.GTT, this.opts.goodTilSec,
        OrderExecution.POST_ONLY, true, false,
      );
      return { clientId, price, size };
    } catch (e) {
      this.lastError = `place ${side}@${price}: ${(e as Error).message.slice(0, 120)}`;
      return null;
    }
  }

  private async sweepLeftover(): Promise<void> {
    try {
      const list = await this.indexer.account.getSubaccountOrders(this.address, this.subaccountNumber);
      const arr = Array.isArray(list) ? list : ((list as any)?.orders ?? []);
      for (const o of arr) {
        if (o.ticker !== this.opts.market) continue;
        if (o.status === "OPEN" || o.status === "BEST_EFFORT_OPENED") {
          await this.cancelOrder(Number(o.clientId));
        }
      }
    } catch {}
  }

  private async cancelAll(): Promise<void> {
    for (const side of ["BUY", "SELL"] as Side[]) {
      const r = this.resting[side];
      if (r) {
        await this.cancelOrder(r.clientId);
        this.resting[side] = null;
      }
    }
    await this.sweepLeftover();
  }
}
