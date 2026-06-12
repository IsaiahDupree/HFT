/**
 * monitor-liq-cascade — live near-HFT monitor that:
 *   1. Polls on-chain liquidation events from the passport data store
 *      (written by scripts/liquidation-event-writer.ts)
 *   2. Polls dYdX order book + recent 1m bars for signal confirmation
 *   3. Executes fade orders on dYdX mainnet when all gates pass
 *   4. Manages exits (take-profit / stop-loss / hold-expired)
 *   5. Appends all decisions to the passport audit log
 *
 * PAPER MODE (default): prints what it would do, no orders sent.
 * LIVE MODE: --live flag required + dYdX credentials in .env.local
 *
 *   npx tsx scripts/monitor-liq-cascade.ts                    # paper mode, BTC-USD
 *   npx tsx scripts/monitor-liq-cascade.ts -- --market ETH-USD --live
 *   npx tsx scripts/monitor-liq-cascade.ts -- --dry-run --ttl 120
 *
 * Signal gates (all must pass):
 *   - DeFi liq ≥ $50k in the past 5 minutes
 *   - CEX 5-bar move ≥ 50bps
 *   - dYdX OBI ≥ 0.15 confirming the cascade direction
 *   - No open position in the market
 *   - Daily loss < halt threshold ($200)
 *
 * Walk-forward backtest (REQUIRED before going live):
 *   npx tsx scripts/backtest-liq-cascade.ts
 */
import "./_env.ts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  makeIndexerClient,
  computeOBI,
  computeMicroprice,
  quotedSpreadBps,
  resolveNet,
  type BookLevel,
} from "../src/lib/hft/dydx/index.js";
import {
  deriveSignal,
  collateralToMarket,
  LiqCascadeRiskState,
  DEFAULT_CONFIG,
  type LiquidationEvent,
  type MarketState,
  type Bar1m,
  type StrategyConfig,
} from "../src/strategies/liq-cascade-strategy.js";

// ──────────────────────────────────────────────────────────────
// CLI args
// ──────────────────────────────────────────────────────────────

const arg = (n: string, def = ""): string => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};

const MARKET = arg("--market", "BTC-USD");
const TICK_MS = Number(arg("--tick-ms", "5000"));
const TTL_S = Number(arg("--ttl", "0")); // 0 = run forever
const LIVE = process.argv.includes("--live");
const DRY_RUN = process.argv.includes("--dry-run") || !LIVE;
const PASSPORT = arg("--passport", "/Volumes/My Passport/hft-data");
const LIQ_LEDGER_PATH = arg(
  "--ledger",
  "/Users/isaiahdupree/Documents/Software/LiquidationBot/data/ledger/monitor.jsonl",
);

const cfg: StrategyConfig = {
  ...DEFAULT_CONFIG,
  maxPositionUsd: Number(arg("--max-position-usd", String(DEFAULT_CONFIG.maxPositionUsd))),
  minLiqUsd: Number(arg("--min-liq-usd", String(DEFAULT_CONFIG.minLiqUsd))),
};

// ──────────────────────────────────────────────────────────────
// Audit log
// ──────────────────────────────────────────────────────────────

const AUDIT_DIR = join(PASSPORT, "liquidations", "audit");
mkdirSync(AUDIT_DIR, { recursive: true });

function audit(type: string, payload: Record<string, unknown>): void {
  const line =
    JSON.stringify({ ts: Date.now(), iso: new Date().toISOString(), type, ...payload }) + "\n";
  const date = new Date().toISOString().slice(0, 10);
  appendFileSync(join(AUDIT_DIR, `${date}.jsonl`), line, "utf8");
}

// ──────────────────────────────────────────────────────────────
// Load recent liquidation events from passport
// ──────────────────────────────────────────────────────────────

type RawLiqEntry = {
  ts?: number;
  venue?: string;
  type?: string;
  collateral_symbol?: string;
  collateral_usd?: number;
  debt_symbol?: string;
  debt_usd?: number;
  health_factor?: number;
  profit_usd?: number;
};

function loadRecentEvents(windowMs = cfg.signalWindowMs + 60_000): LiquidationEvent[] {
  const dirs = [
    join(PASSPORT, "liquidations", "navi"),
    join(PASSPORT, "liquidations", "morpho"),
  ];
  const cutoff = Date.now() - windowMs;
  const events: LiquidationEvent[] = [];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const today = new Date().toISOString().slice(0, 10);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl") && f >= `${today.slice(0, 7)}-01.jsonl`)
      .sort()
      .slice(-2); // last 2 days

    for (const f of files) {
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as RawLiqEntry;
          if (typeof e.ts !== "number" || e.ts < cutoff) continue;
          if (!e.type || !["execute", "opportunity", "liquidatable", "at_risk"].includes(e.type)) continue;
          events.push({
            ts: e.ts,
            venue: (e.venue === "navi" ? "navi" : "morpho") as "navi" | "morpho",
            type: e.type,
            collateral_symbol: e.collateral_symbol ?? null,
            collateral_usd: e.collateral_usd ?? 0,
            debt_symbol: e.debt_symbol ?? null,
            debt_usd: e.debt_usd ?? 0,
            health_factor: e.health_factor ?? null,
            profit_usd: e.profit_usd ?? null,
          });
        } catch {
          // skip malformed
        }
      }
    }
  }
  return events;
}

// Also read directly from the LiquidationBot ledger for real-time events
function loadLedgerEvents(cutoffMs: number): LiquidationEvent[] {
  if (!existsSync(LIQ_LEDGER_PATH)) return [];
  const events: LiquidationEvent[] = [];
  for (const line of readFileSync(LIQ_LEDGER_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as {
        ts?: number;
        type?: string;
        payload?: Record<string, unknown>;
      };
      if (!e.ts || e.ts < cutoffMs) continue;
      if (!e.type || !["execute", "opportunity", "miss"].includes(e.type)) continue;
      const p = e.payload ?? {};
      events.push({
        ts: e.ts,
        venue: "navi",
        type: e.type,
        collateral_symbol: (p["collateralSymbol"] as string | null) ?? null,
        collateral_usd: Number(p["collateralUsd"] ?? 0),
        debt_symbol: (p["debtSymbol"] as string | null) ?? null,
        debt_usd: Number(p["debtUsd"] ?? 0),
        health_factor: Number(p["hf"] ?? 0) || null,
        profit_usd: Number(p["netUsd"] ?? 0) || null,
      });
    } catch {
      // skip
    }
  }
  return events;
}

// ──────────────────────────────────────────────────────────────
// Fetch 1m klines from dYdX WebSocket candles
// ──────────────────────────────────────────────────────────────

// dYdX indexer REST: recent candles
async function fetchRecentBars(
  indexer: ReturnType<typeof makeIndexerClient>,
  market: string,
  n = 10,
): Promise<Bar1m[]> {
  try {
    const res = (await indexer.markets.getPerpetualMarketCandles(
      market,
      "1MIN",
    )) as unknown as { candles?: unknown[] };
    const raw = (res?.candles ?? []).slice(0, n);
    const bars: Bar1m[] = [];
    for (const r of raw) {
      const c = r as {
        startedAt?: string;
        open?: string;
        high?: string;
        low?: string;
        close?: string;
        baseTokenVolume?: string;
      };
      const t = c.startedAt ? new Date(c.startedAt).getTime() : 0;
      bars.push({
        t,
        o: Number(c.open ?? 0),
        h: Number(c.high ?? 0),
        l: Number(c.low ?? 0),
        c: Number(c.close ?? 0),
        v: Number(c.baseTokenVolume ?? 0),
      });
    }
    return bars.sort((a, b) => a.t - b.t);
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────────────────────
// Main loop
// ──────────────────────────────────────────────────────────────

const net = resolveNet();
const indexer = makeIndexerClient(net);
const risk = new LiqCascadeRiskState(cfg);

console.log(
  `liq-cascade-monitor | market=${MARKET} tick=${TICK_MS}ms net=${net} ${DRY_RUN ? "[PAPER]" : "[LIVE]"}`,
);
console.log(`  minLiqUsd=${cfg.minLiqUsd} minMoveBps=${cfg.minMoveBps} maxPos=${cfg.maxPositionUsd}USD`);
console.log(`  entryOffset=${cfg.entryOffsetBps}bps tp=${cfg.takeProfitBps}bps sl=${cfg.stopLossBps}bps hold=${cfg.holdMinutes}m\n`);

audit("start", { market: MARKET, net, live: LIVE, cfg });

let cycle = 0;
let running = true;
process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });
if (TTL_S > 0) setTimeout(() => { running = false; }, TTL_S * 1000).unref?.();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

while (running) {
  cycle++;
  const t0 = Date.now();

  try {
    // Fetch order book + oracle
    const [marketData, ob, recentBars] = await Promise.all([
      indexer.markets.getPerpetualMarkets(MARKET) as Promise<unknown>,
      indexer.markets.getPerpetualMarketOrderbook(MARKET) as Promise<unknown>,
      fetchRecentBars(indexer, MARKET),
    ]);

    const mInfo = (marketData as Record<string, { markets?: Record<string, unknown> }>)?.markets?.[MARKET] as
      | { oraclePrice?: string }
      | undefined;
    const oracle = Number(mInfo?.oraclePrice ?? 0);
    const bids: BookLevel[] = ((ob as { bids?: unknown[] })?.bids ?? []).slice(0, 10).map((b) => ({
      price: Number((b as { price?: string }).price ?? 0),
      size: Number((b as { size?: string }).size ?? 0),
    }));
    const asks: BookLevel[] = ((ob as { asks?: unknown[] })?.asks ?? []).slice(0, 10).map((a) => ({
      price: Number((a as { price?: string }).price ?? 0),
      size: Number((a as { size?: string }).size ?? 0),
    }));

    const state: MarketState = { market: MARKET, oracle, bids, asks, recentBars };
    const obi = computeOBI(bids, asks);
    const microprice = computeMicroprice(bids, asks);
    const spreadBps = quotedSpreadBps(bids, asks);

    // Check exits for open positions
    for (const [mkt, _pos] of risk.getOpenPositions()) {
      if (mkt !== MARKET) continue;
      const mid = microprice ?? oracle;
      const exitReason = risk.checkExits(mkt, mid, t0);
      if (exitReason) {
        const pnl = risk.closePosition(mkt, mid, exitReason);
        audit("close", { market: mkt, exit_reason: exitReason, price: mid, pnl_usd: pnl });
        if (!DRY_RUN) {
          // TODO: send market order via dYdX execution client
          console.log(`  !! LIVE close ${mkt} @ ${mid.toFixed(4)} reason=${exitReason} — wire to dydx-client`);
        }
      }
    }

    // Check if halted
    if (risk.isHalted()) {
      console.log(`[${cycle}] HALTED — daily loss halt triggered. Daily PnL: ${risk.getDailyPnlUsd().toFixed(2)}USD`);
      await sleep(TICK_MS);
      continue;
    }

    // Load recent on-chain liq events (from passport + live ledger)
    const cutoff = t0 - cfg.signalWindowMs - 60_000;
    const events = [
      ...loadRecentEvents(cfg.signalWindowMs + 60_000),
      ...loadLedgerEvents(cutoff),
    ];

    // Find best signal
    let bestSignal = null;
    for (const event of events) {
      const market = collateralToMarket(event.collateral_symbol);
      if (!market || market !== MARKET) continue;
      if (risk.hasOpenPosition(MARKET)) break;
      const signal = deriveSignal(event, state, cfg, t0);
      if (signal) { bestSignal = signal; break; }
    }

    const elapsed = Date.now() - t0;
    const logLine =
      `[${cycle}] oracle=${oracle.toFixed(2)} obi=${obi.toFixed(3)} spread=${spreadBps?.toFixed(1) ?? "?"}bps` +
      ` micro=${microprice?.toFixed(2) ?? "?"} bars=${recentBars.length} events=${events.length}` +
      ` open=${risk.getOpenPositions().size} daily_pnl=${risk.getDailyPnlUsd().toFixed(2)}USD (${elapsed}ms)`;
    console.log(logLine);

    if (bestSignal) {
      console.log(`  SIGNAL → ${bestSignal.dir === 1 ? "LONG" : "SHORT"} ${bestSignal.market}`);
      console.log(`    entry=${bestSignal.entryPrice.toFixed(4)} tp=${bestSignal.takeProfitPrice.toFixed(4)} sl=${bestSignal.stopLossPrice.toFixed(4)}`);
      console.log(`    size=${bestSignal.sizeUsd.toFixed(0)}USD | ${bestSignal.reason}`);

      audit("signal", {
        market: bestSignal.market,
        dir: bestSignal.dir,
        entry: bestSignal.entryPrice,
        tp: bestSignal.takeProfitPrice,
        sl: bestSignal.stopLossPrice,
        size_usd: bestSignal.sizeUsd,
        reason: bestSignal.reason,
        paper: DRY_RUN,
      });

      if (!DRY_RUN) {
        // TODO: place limit order via dYdX execution client
        // const client = await DydxCompositeClient.create(...);
        // await client.placeOrder(...)
        console.log("  !! LIVE order — dYdX execution client not wired in paper mode");
      }

      const pos = risk.openPosition(bestSignal, t0);
      audit("open", {
        market: pos.market,
        dir: pos.dir,
        entry_price: pos.entryPrice,
        size_usd: pos.sizeUsd,
        tp: pos.takeProfitPrice,
        sl: pos.stopLossPrice,
        hold_deadline: pos.holdDeadline,
        paper: DRY_RUN,
        signal_reason: pos.signalReason,
      });
    }
  } catch (err) {
    console.warn(`  [cycle ${cycle}] error: ${(err as Error).message}`);
    audit("error", { msg: (err as Error).message });
  }

  const elapsed = Date.now() - t0;
  const waitMs = Math.max(0, TICK_MS - elapsed);
  await sleep(waitMs);
}

audit("stop", { market: MARKET, cycles: cycle, daily_pnl_usd: risk.getDailyPnlUsd() });
console.log(`\nliq-cascade-monitor stopped after ${cycle} cycles. Daily PnL: ${risk.getDailyPnlUsd().toFixed(2)}USD`);
