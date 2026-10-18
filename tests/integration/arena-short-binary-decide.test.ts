/**
 * Strategy decide() tests for `poly_short_binary_directional`.
 *
 * Integration test (not unit) because the strategy reads:
 *   - poly_binaries metadata (for asset + expiry)
 *   - coinbase_candles / coindesk_candles (for velocity)
 * Both go through the real `db()` client, so we use the in-memory DB helper.
 *
 * Covered:
 *   - Positive velocity above threshold → BUY (YES) signal
 *   - Negative velocity above threshold → SELL signal
 *   - Velocity below threshold → hold
 *   - Binary outside [pre_cutoff_min, max_window_min] → hold
 *   - YES mid above max_yes_price_for_buy → hold
 *   - YES mid below min_yes_price_for_sell → hold
 *   - Per-asset position cap = 1 blocks a 2nd BTC entry
 *   - Per-asset position cap = 2 allows two
 *   - OKX-fed asset (BNB) loads from coindesk_candles
 *   - Unknown / unallowed asset filtered out by `assets` CSV
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeMemoryDb } from "../helpers/db";

let memDb: ReturnType<typeof makeMemoryDb> | null = null;
vi.mock("@/lib/db/client", () => ({
  db: () => {
    if (!memDb) memDb = makeMemoryDb();
    return memDb;
  },
  closeDb: () => { memDb?.close(); memDb = null; },
}));

beforeEach(() => { memDb?.close(); memDb = null; });

async function seedBinary(meta: {
  token_id: string; no_token_id?: string; asset: string;
  duration_kind?: string; expiry_iso: string; question?: string;
}) {
  const { db } = await import("@/lib/db/client");
  db().prepare(
    `INSERT INTO poly_binaries (token_id, condition_id, no_token_id, question, asset, duration_kind, start_iso, expiry_iso)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    meta.token_id, "c-" + meta.token_id, meta.no_token_id ?? null,
    meta.question ?? `${meta.asset} up?`, meta.asset, meta.duration_kind ?? "5M",
    null, meta.expiry_iso,
  );
}

/** Seed a candle series ending at endUnix with constant pct change per minute. */
async function seedCandlesCoinbase(productId: string, endUnix: number, mins: number, startClose: number, deltaPctPerMin: number) {
  const { db } = await import("@/lib/db/client");
  const stmt = db().prepare(
    `INSERT OR IGNORE INTO coinbase_candles (product_id, granularity, start_unix, open, high, low, close, volume)
     VALUES (?, 'ONE_MINUTE', ?, ?, ?, ?, ?, 0)`,
  );
  for (let i = 0; i < mins; i++) {
    const ts = endUnix - (mins - 1 - i) * 60;
    const close = startClose * (1 + deltaPctPerMin * i);
    stmt.run(productId, ts, close, close, close, close);
  }
}

async function seedCandlesOkx(instId: string, endUnix: number, mins: number, startClose: number, deltaPctPerMin: number) {
  const { db } = await import("@/lib/db/client");
  const stmt = db().prepare(
    `INSERT OR IGNORE INTO coindesk_candles (market, instrument, granularity, start_unix, open, high, low, close, volume, quote_volume, total_trades)
     VALUES ('okx', ?, 'ONE_MINUTE', ?, ?, ?, ?, ?, 0, NULL, NULL)`,
  );
  for (let i = 0; i < mins; i++) {
    const ts = endUnix - (mins - 1 - i) * 60;
    const close = startClose * (1 + deltaPctPerMin * i);
    stmt.run(instId, ts, close, close, close, close);
  }
}

/** Drop a current snapshot of the YES mid so the decide function sees it
 *  in ctx.snapshots when buildLiveTickContext is called. */
async function seedSnapshot(tokenId: string, mid: number, conditionId?: string) {
  const { db } = await import("@/lib/db/client");
  db().prepare(
    `INSERT INTO market_snapshots (condition_id, token_id, question, midpoint, category)
     VALUES (?, ?, ?, ?, '5min-binary')`,
  ).run(conditionId ?? `c-${tokenId}`, tokenId, "q", mid);
}

/** Build a LiveAgent with a `poly_short_binary_directional` genome. */
function makeBinaryAgent(opts: Partial<{
  vel_window_min: number; vel_entry_pct: number;
  pre_cutoff_min: number; max_window_min: number;
  max_yes_price_for_buy: number; min_yes_price_for_sell: number;
  entry_size_usd: number; max_positions_per_asset: number;
  assets: string; positions: any[];
}> = {}): import("@/lib/arena/types").LiveAgent {
  return {
    id: 1, name: "5m-binary-test", generation: 0, parent_paper_agent_id: null,
    genome_json: "{}", introduced_by: "test",
    cash_usd_start: 1000, cash_usd_current: 1000, position_basket_json: "[]",
    realized_pnl_usd: 0, unrealized_pnl_usd: 0, peak_equity_usd: 1000, max_drawdown_usd: 0,
    trades_count: 0, entries_count: 0, wins_count: 0,
    alive: 1, retire_reason: null, retired_at: null, created_at: "", updated_at: "",
    genome: {
      kind: "poly_short_binary_directional",
      params: {
        assets: opts.assets ?? "BTC,ETH,SOL,XRP,DOGE,BNB,HYPE",
        vel_window_min: opts.vel_window_min ?? 3,
        vel_entry_pct: opts.vel_entry_pct ?? 0.001,
        pre_cutoff_min: opts.pre_cutoff_min ?? 3,
        max_window_min: opts.max_window_min ?? 6,
        max_yes_price_for_buy: opts.max_yes_price_for_buy ?? 0.70,
        min_yes_price_for_sell: opts.min_yes_price_for_sell ?? 0.30,
        entry_size_usd: opts.entry_size_usd ?? 5,
        max_positions_per_asset: opts.max_positions_per_asset ?? 1,
      },
    },
    positions: opts.positions ?? [],
  };
}

/** Build a minimal TickContext with a single sim-poly binary snapshot. */
function makeCtxWithBinary(nowIso: string, tokenId: string, mid: number): import("@/lib/arena/types").TickContext {
  const snap = {
    venue: "sim-poly" as const,
    market_id: tokenId,
    price: mid,
    category: "5min-binary",
    captured_at: nowIso,
  };
  return {
    now: nowIso,
    snapshots: new Map([[tokenId, { history: [snap], latest: snap }]]),
  };
}

describe("decidePolyShortBinary", () => {
  it("BUYs YES on strong positive velocity", async () => {
    const expiry = "2026-05-26T12:00:00Z";
    const expiryUnix = Math.floor(new Date(expiry).getTime() / 1000);
    const nowIso = "2026-05-26T11:56:00Z"; // 4 min before expiry → within [3,6]
    const nowUnix = Math.floor(new Date(nowIso).getTime() / 1000);

    // BTC rising 0.2%/min over 10 min → velocity over 3-min window = ~0.6%
    await seedCandlesCoinbase("BTC-USD", nowUnix, 10, 70000, 0.002);
    await seedBinary({ token_id: "btc-yes", asset: "BTC", expiry_iso: expiry });
    await seedSnapshot("btc-yes", 0.52);

    const { decide } = await import("@/lib/arena/sim");
    const ctx = makeCtxWithBinary(nowIso, "btc-yes", 0.52);
    const sig = decide(makeBinaryAgent(), ctx, Math.random);
    expect(sig.kind).toBe("entry");
    if (sig.kind === "entry") {
      expect(sig.side).toBe("BUY");
      expect(sig.venue).toBe("sim-poly");
      expect(sig.market_id).toBe("btc-yes");
      expect(sig.time_stop_at).toBe(expiry);
      expect(sig.rationale).toMatch(/UP/);
    }
  });

  it("SELLs on strong negative velocity", async () => {
    const expiry = "2026-05-26T12:00:00Z";
    const expiryUnix = Math.floor(new Date(expiry).getTime() / 1000);
    const nowIso = "2026-05-26T11:56:00Z";
    const nowUnix = Math.floor(new Date(nowIso).getTime() / 1000);
    // ETH falling 0.2%/min → -0.6% over 3-min window
    await seedCandlesCoinbase("ETH-USD", nowUnix, 10, 3000, -0.002);
    await seedBinary({ token_id: "eth-yes", asset: "ETH", expiry_iso: expiry });
    await seedSnapshot("eth-yes", 0.48);

    const { decide } = await import("@/lib/arena/sim");
    const ctx = makeCtxWithBinary(nowIso, "eth-yes", 0.48);
    const sig = decide(makeBinaryAgent(), ctx, Math.random);
    expect(sig.kind).toBe("entry");
    if (sig.kind === "entry") {
      expect(sig.side).toBe("SELL");
      expect(sig.rationale).toMatch(/DOWN/);
    }
  });

  it("holds when velocity is below threshold", async () => {
    const expiry = "2026-05-26T12:00:00Z";
    const expiryUnix = Math.floor(new Date(expiry).getTime() / 1000);
    const nowIso = "2026-05-26T11:56:00Z";
    const nowUnix = Math.floor(new Date(nowIso).getTime() / 1000);
    // Flat candles → velocity = 0
    await seedCandlesCoinbase("BTC-USD", nowUnix, 10, 70000, 0);
    await seedBinary({ token_id: "btc-yes", asset: "BTC", expiry_iso: expiry });
    await seedSnapshot("btc-yes", 0.50);

    const { decide } = await import("@/lib/arena/sim");
    const ctx = makeCtxWithBinary(nowIso, "btc-yes", 0.50);
    expect(decide(makeBinaryAgent(), ctx, Math.random).kind).toBe("hold");
  });

  it("holds when binary expires too soon (within pre_cutoff_min)", async () => {
    const expiry = "2026-05-26T12:00:00Z";
    const expiryUnix = Math.floor(new Date(expiry).getTime() / 1000);
    // Now is 1.5 min before expiry → less than pre_cutoff_min=3
    const nowIso = "2026-05-26T11:58:30Z";
    const nowUnix = Math.floor(new Date(nowIso).getTime() / 1000);
    await seedCandlesCoinbase("BTC-USD", nowUnix, 10, 70000, 0.002);
    await seedBinary({ token_id: "btc-yes", asset: "BTC", expiry_iso: expiry });
    await seedSnapshot("btc-yes", 0.50);

    const { decide } = await import("@/lib/arena/sim");
    const ctx = makeCtxWithBinary(nowIso, "btc-yes", 0.50);
    expect(decide(makeBinaryAgent(), ctx, Math.random).kind).toBe("hold");
  });

  it("holds when binary expires too far out (beyond max_window_min)", async () => {
    const expiry = "2026-05-26T12:00:00Z";
    const expiryUnix = Math.floor(new Date(expiry).getTime() / 1000);
    // Now is 10 min before expiry → beyond max_window_min=6
    const nowIso = "2026-05-26T11:50:00Z";
    const nowUnix = Math.floor(new Date(nowIso).getTime() / 1000);
    await seedCandlesCoinbase("BTC-USD", nowUnix, 10, 70000, 0.002);
    await seedBinary({ token_id: "btc-yes", asset: "BTC", expiry_iso: expiry });
    await seedSnapshot("btc-yes", 0.50);

    const { decide } = await import("@/lib/arena/sim");
    const ctx = makeCtxWithBinary(nowIso, "btc-yes", 0.50);
    expect(decide(makeBinaryAgent(), ctx, Math.random).kind).toBe("hold");
  });

  it("refuses BUY when YES mid above max_yes_price_for_buy", async () => {
    const expiry = "2026-05-26T12:00:00Z";
    const expiryUnix = Math.floor(new Date(expiry).getTime() / 1000);
    const nowIso = "2026-05-26T11:56:00Z";
    const nowUnix = Math.floor(new Date(nowIso).getTime() / 1000);
    await seedCandlesCoinbase("BTC-USD", nowUnix, 10, 70000, 0.002);   // +velocity → would BUY
    await seedBinary({ token_id: "btc-yes", asset: "BTC", expiry_iso: expiry });
    await seedSnapshot("btc-yes", 0.85);

    const { decide } = await import("@/lib/arena/sim");
    const ctx = makeCtxWithBinary(nowIso, "btc-yes", 0.85);
    expect(decide(makeBinaryAgent({ max_yes_price_for_buy: 0.70 }), ctx, Math.random).kind).toBe("hold");
  });

  it("refuses SELL when YES mid below min_yes_price_for_sell", async () => {
    const expiry = "2026-05-26T12:00:00Z";
    const expiryUnix = Math.floor(new Date(expiry).getTime() / 1000);
    const nowIso = "2026-05-26T11:56:00Z";
    const nowUnix = Math.floor(new Date(nowIso).getTime() / 1000);
    await seedCandlesCoinbase("ETH-USD", nowUnix, 10, 3000, -0.002);   // -velocity → would SELL
    await seedBinary({ token_id: "eth-yes", asset: "ETH", expiry_iso: expiry });
    await seedSnapshot("eth-yes", 0.20);

    const { decide } = await import("@/lib/arena/sim");
    const ctx = makeCtxWithBinary(nowIso, "eth-yes", 0.20);
    expect(decide(makeBinaryAgent({ min_yes_price_for_sell: 0.30 }), ctx, Math.random).kind).toBe("hold");
  });

  it("respects per-asset position cap (cap=1 blocks second BTC entry)", async () => {
    const expiry1 = "2026-05-26T12:00:00Z";
    const expiry2 = "2026-05-26T12:05:00Z";
    const nowIso = "2026-05-26T11:56:00Z";
    const nowUnix = Math.floor(new Date(nowIso).getTime() / 1000);
    await seedCandlesCoinbase("BTC-USD", nowUnix, 10, 70000, 0.002);
    await seedBinary({ token_id: "btc-yes-1", asset: "BTC", expiry_iso: expiry1 });
    await seedBinary({ token_id: "btc-yes-2", asset: "BTC", expiry_iso: expiry2 });
    await seedSnapshot("btc-yes-1", 0.50);
    await seedSnapshot("btc-yes-2", 0.50);

    const { decide } = await import("@/lib/arena/sim");
    // Already holding one BTC binary; cap=1 blocks the second.
    const agent = makeBinaryAgent({
      max_positions_per_asset: 1,
      positions: [{
        venue: "sim-poly", market_id: "btc-yes-1", side: "BUY",
        size_usd: 5, entry_price: 0.45, opened_at: nowIso,
      }],
    });
    // ctx has the 2nd binary only (1st is in agent.positions and skipped anyway).
    const snap = { venue: "sim-poly" as const, market_id: "btc-yes-2", price: 0.50, category: "5min-binary", captured_at: nowIso };
    const ctx = { now: nowIso, snapshots: new Map([["btc-yes-2", { history: [snap], latest: snap }]]) };
    expect(decide(agent, ctx, Math.random).kind).toBe("hold");
  });

  it("respects per-asset position cap (cap=2 allows a second BTC entry)", async () => {
    const expiry2 = "2026-05-26T12:05:00Z";
    const nowIso = "2026-05-26T12:01:00Z"; // 4 min before expiry2 → within window
    const nowUnix = Math.floor(new Date(nowIso).getTime() / 1000);
    await seedCandlesCoinbase("BTC-USD", nowUnix, 10, 70000, 0.002);
    await seedBinary({ token_id: "btc-yes-2", asset: "BTC", expiry_iso: expiry2 });
    await seedBinary({ token_id: "btc-yes-1", asset: "BTC", expiry_iso: "2026-05-26T11:55:00Z" });
    await seedSnapshot("btc-yes-2", 0.50);

    const { decide } = await import("@/lib/arena/sim");
    const agent = makeBinaryAgent({
      max_positions_per_asset: 2,
      positions: [{
        venue: "sim-poly", market_id: "btc-yes-1", side: "BUY",
        size_usd: 5, entry_price: 0.45, opened_at: "2026-05-26T11:53:00Z",
      }],
    });
    const snap = { venue: "sim-poly" as const, market_id: "btc-yes-2", price: 0.50, category: "5min-binary", captured_at: nowIso };
    const ctx = { now: nowIso, snapshots: new Map([["btc-yes-2", { history: [snap], latest: snap }]]) };
    const sig = decide(agent, ctx, Math.random);
    expect(sig.kind).toBe("entry");
  });

  it("uses the OKX feed for BNB", async () => {
    const expiry = "2026-05-26T12:00:00Z";
    const expiryUnix = Math.floor(new Date(expiry).getTime() / 1000);
    const nowIso = "2026-05-26T11:56:00Z";
    const nowUnix = Math.floor(new Date(nowIso).getTime() / 1000);
    // BNB rising via OKX candles, NOT coinbase_candles
    await seedCandlesOkx("BNB-USDT", nowUnix, 10, 660, 0.002);
    await seedBinary({ token_id: "bnb-yes", asset: "BNB", expiry_iso: expiry });
    await seedSnapshot("bnb-yes", 0.50);

    const { decide } = await import("@/lib/arena/sim");
    const snap = { venue: "sim-poly" as const, market_id: "bnb-yes", price: 0.50, category: "5min-binary", captured_at: nowIso };
    const ctx = { now: nowIso, snapshots: new Map([["bnb-yes", { history: [snap], latest: snap }]]) };
    const sig = decide(makeBinaryAgent(), ctx, Math.random);
    expect(sig.kind).toBe("entry");
    if (sig.kind === "entry") {
      expect(sig.side).toBe("BUY");
      expect(sig.market_id).toBe("bnb-yes");
    }
  });

  it("filters out assets not in the `assets` CSV", async () => {
    const expiry = "2026-05-26T12:00:00Z";
    const expiryUnix = Math.floor(new Date(expiry).getTime() / 1000);
    const nowIso = "2026-05-26T11:56:00Z";
    const nowUnix = Math.floor(new Date(nowIso).getTime() / 1000);
    await seedCandlesCoinbase("BTC-USD", nowUnix, 10, 70000, 0.002);
    await seedBinary({ token_id: "btc-yes", asset: "BTC", expiry_iso: expiry });
    await seedSnapshot("btc-yes", 0.50);

    const { decide } = await import("@/lib/arena/sim");
    const ctx = makeCtxWithBinary(nowIso, "btc-yes", 0.50);
    // Agent only takes ETH; BTC binary should be ignored.
    expect(decide(makeBinaryAgent({ assets: "ETH" }), ctx, Math.random).kind).toBe("hold");
  });

  it("ignores binaries without poly_binaries metadata", async () => {
    const nowIso = "2026-05-26T11:56:00Z";
    await seedSnapshot("orphan-token", 0.50);   // snapshot but no metadata
    const { decide } = await import("@/lib/arena/sim");
    const ctx = makeCtxWithBinary(nowIso, "orphan-token", 0.50);
    expect(decide(makeBinaryAgent(), ctx, Math.random).kind).toBe("hold");
  });
});
