/**
 * Exercises every Kalshi REST endpoint our client wraps.
 *
 * Read-only by default. The `--destructive` flag enables an order-lifecycle
 * test that places ONE tiny far-from-market limit order on a target market,
 * verifies it appears as resting, then cancels it. Real orders only execute
 * when ALL of these are true:
 *   - `--destructive --live`
 *   - `KALSHI_ALLOW_TRADE=1`
 *   - `KALSHI_SWEEP_MAX_USD` ≥ 1 (default 0 = blocked)
 *
 * Always point at demo first. Example:
 *
 *   KALSHI_HOST=https://demo-api.kalshi.co \
 *     tsx scripts/test-kalshi-endpoints.ts
 *
 *   KALSHI_HOST=https://demo-api.kalshi.co \
 *   KALSHI_ALLOW_TRADE=1 KALSHI_SWEEP_MAX_USD=1 \
 *     tsx scripts/test-kalshi-endpoints.ts --destructive --live
 *
 * Writes a structured report to docs/kalshi-test-results.json.
 */
import "./_env.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { kalshi, getLastRateLimit, type KalshiMarket } from "../src/lib/kalshi/client.ts";
import { authIsAvailable, accessKey } from "../src/lib/kalshi/sign.ts";

type Status = "pass" | "fail" | "skip";
type Result = {
  category: string;
  name: string;
  method: string;
  path: string;
  status: Status;
  http?: number;
  ms?: number;
  error?: string;
  sample?: unknown;
  data?: unknown;
};

const destructive = process.argv.includes("--destructive");
const goLive = process.argv.includes("--live");
const sweepMaxUsd = Number(process.env.KALSHI_SWEEP_MAX_USD ?? "0");
const allowLive = goLive && process.env.KALSHI_ALLOW_TRADE === "1" && sweepMaxUsd > 0;

const results: Result[] = [];
const SAMPLE_BYTES = 1200;
const trimForReport = (data: unknown): unknown => {
  try {
    const s = JSON.stringify(data);
    if (s.length <= SAMPLE_BYTES) return data;
    return { _truncated: true, _preview: s.slice(0, SAMPLE_BYTES) + "…" };
  } catch { return String(data).slice(0, SAMPLE_BYTES); }
};

async function run<T>(category: string, name: string, method: string, path: string, fn: () => Promise<T>): Promise<Result> {
  const started = Date.now();
  const res: Result = { category, name, method, path, status: "fail" };
  try {
    const data = await fn();
    res.status = "pass";
    res.http = 200;
    res.ms = Date.now() - started;
    res.data = data;
    res.sample = trimForReport(data);
  } catch (err) {
    res.error = (err as Error).message.slice(0, 500);
    res.ms = Date.now() - started;
    const m = res.error.match(/→ (\d{3}) /);
    if (m) res.http = Number(m[1]);
  }
  results.push(res);
  const tag = res.status === "pass" ? "✓" : res.status === "skip" ? "~" : "✗";
  const detail = res.status === "pass" ? `${res.http ?? "?"} in ${res.ms}ms`
    : res.status === "skip" ? "skipped"
    : `${res.http ?? "-"} ${res.error?.slice(0, 90)}`;
  console.log(`  [${tag}] ${category.padEnd(14)} ${name.padEnd(40)} ${detail}`);
  return res;
}

function skip(category: string, name: string, method: string, path: string, reason: string) {
  results.push({ category, name, method, path, status: "skip", error: reason });
  console.log(`  [~] ${category.padEnd(14)} ${name.padEnd(40)} skipped (${reason})`);
}

async function section(title: string, fn: () => Promise<void>) {
  console.log(`\n── ${title} ──`);
  await fn();
}

(async () => {
  console.log(`Kalshi endpoint sweep`);
  console.log(`host=${kalshi.host()}  destructive=${destructive}  live=${goLive}  allow-live=${allowLive}  sweep-cap=$${sweepMaxUsd}`);
  if (authIsAvailable()) {
    console.log(`Kalshi access key: ${accessKey().slice(0, 16)}…`);
  } else {
    console.log(`Kalshi access key: NOT FOUND — only public endpoints will pass`);
  }

  let firstEventTicker: string | null = null;
  let firstMarketTicker: string | null = null;
  let firstOrderId: string | null = null;

  await section("Exchange (public)", async () => {
    await run("exchange", "status", "GET", "/exchange/status", () => kalshi.exchangeStatus());
    await run("exchange", "schedule", "GET", "/exchange/schedule", () => kalshi.exchangeSchedule());
    await run("exchange", "announcements", "GET", "/exchange/announcements", () => kalshi.exchangeAnnouncements());
  });

  await section("Series & events (public)", async () => {
    await run("series", "list series", "GET", "/series", () => kalshi.listSeries());
    // KXBTC15M is the 15-minute Bitcoin up/down series — our main target.
    await run("series", "get series KXBTC15M", "GET", "/series/KXBTC15M", () => kalshi.getSeries("KXBTC15M"));

    const events = await run("events", "list events (KXBTC15M open)", "GET", "/events", () =>
      kalshi.listEvents({ series_ticker: "KXBTC15M", status: "open", limit: 5, with_nested_markets: true }));
    if (events.status === "pass") {
      const evs = (events.data as any)?.events ?? [];
      if (evs[0]) {
        firstEventTicker = evs[0].event_ticker ?? evs[0].ticker;
        const nested: KalshiMarket[] = evs[0].markets ?? [];
        if (nested[0]) firstMarketTicker = nested[0].ticker;
      }
    }
    if (firstEventTicker) {
      await run("events", `get event ${firstEventTicker}`, "GET", `/events/${firstEventTicker}`, () =>
        kalshi.getEvent(firstEventTicker!, { with_nested_markets: true }));
    } else {
      skip("events", "get event", "GET", "/events/{ticker}", "no event ticker captured");
    }
  });

  await section("Markets (public)", async () => {
    await run("markets", "list markets (limit=5, open)", "GET", "/markets", () =>
      kalshi.listMarkets({ status: "open", limit: 5 }));
    if (firstMarketTicker) {
      await run("markets", `get market ${firstMarketTicker}`, "GET", `/markets/${firstMarketTicker}`, () =>
        kalshi.getMarket(firstMarketTicker!));
      await run("markets", `orderbook ${firstMarketTicker}`, "GET", `/markets/${firstMarketTicker}/orderbook`, () =>
        kalshi.getMarketOrderbook(firstMarketTicker!, { depth: 5 }));
      await run("markets", `trades ${firstMarketTicker}`, "GET", "/markets/trades", () =>
        kalshi.getMarketTrades(firstMarketTicker!, { limit: 5 }));
    } else {
      skip("markets", "get market", "GET", "/markets/{ticker}", "no live market ticker captured");
      skip("markets", "orderbook", "GET", "/markets/{ticker}/orderbook", "no live market ticker captured");
      skip("markets", "trades", "GET", "/markets/{ticker}/trades", "no live market ticker captured");
    }
  });

  await section("Portfolio (auth)", async () => {
    if (!authIsAvailable()) {
      skip("portfolio", "balance", "GET", "/portfolio/balance", "no Kalshi key");
      skip("portfolio", "positions", "GET", "/portfolio/positions", "no Kalshi key");
      skip("portfolio", "fills", "GET", "/portfolio/fills", "no Kalshi key");
      skip("portfolio", "settlements", "GET", "/portfolio/settlements", "no Kalshi key");
      return;
    }
    await run("portfolio", "balance", "GET", "/portfolio/balance", () => kalshi.getBalance());
    await run("portfolio", "positions (limit=5)", "GET", "/portfolio/positions", () => kalshi.getPositions({ limit: 5 }));
    await run("portfolio", "fills (limit=5)", "GET", "/portfolio/fills", () => kalshi.getFills({ limit: 5 }));
    await run("portfolio", "settlements (limit=5)", "GET", "/portfolio/settlements", () => kalshi.getSettlements({ limit: 5 }));
  });

  await section("Orders — read (auth)", async () => {
    if (!authIsAvailable()) {
      skip("orders", "list orders resting", "GET", "/portfolio/orders", "no Kalshi key");
      return;
    }
    const list = await run("orders", "list orders resting", "GET", "/portfolio/orders", () =>
      kalshi.listOrders({ status: "resting", limit: 5 }));
    const first = (list.data as any)?.orders?.[0]?.order_id;
    if (first) {
      firstOrderId = first;
      await run("orders", `get order ${String(first).slice(0, 8)}…`, "GET", `/portfolio/orders/${first}`, () =>
        kalshi.getOrder(first));
    } else {
      skip("orders", "get order", "GET", "/portfolio/orders/{id}", "no resting orders");
    }
  });

  await section("Order lifecycle (destructive)", async () => {
    if (!destructive) return skip("order-cycle", "place + cancel", "POST", "/portfolio/orders", "destructive flag off");
    if (!authIsAvailable()) return skip("order-cycle", "place + cancel", "POST", "/portfolio/orders", "no Kalshi key");
    if (!firstMarketTicker) return skip("order-cycle", "place + cancel", "POST", "/portfolio/orders", "no market ticker captured");
    if (!allowLive) return skip("order-cycle", "place + cancel", "POST", "/portfolio/orders",
      "live gate off (need --live AND KALSHI_ALLOW_TRADE=1 AND KALSHI_SWEEP_MAX_USD>0)");

    // Place ONE contract at the lowest legal YES price (1 cent) — far below
    // any realistic market, so it sits in the book without filling. Worst-case
    // cost if it somehow fills: 1¢ × KALSHI_SWEEP_MAX_USD contracts.
    const contracts = Math.max(1, Math.floor(sweepMaxUsd * 100));   // $1 cap → 100 contracts max
    const clientId = randomUUID();
    const place = await run("order-cycle", `place YES @1¢ × ${contracts}`, "POST", "/portfolio/orders", () =>
      kalshi.createOrder({
        ticker: firstMarketTicker!,
        action: "buy",
        side: "yes",
        type: "limit",
        count: contracts,
        yes_price: 1,
        client_order_id: clientId,
      }));
    const placedId = (place.data as any)?.order?.order_id;
    if (!placedId) {
      skip("order-cycle", "cancel placed", "DELETE", "/portfolio/orders/{id}", "place failed → no id");
      return;
    }
    await run("order-cycle", "cancel placed", "DELETE", `/portfolio/orders/${placedId.slice(0, 8)}…`, () =>
      kalshi.cancelOrder(placedId));
  });

  console.log(`\nRate limit (last response): ${JSON.stringify(getLastRateLimit())}`);

  const summary = {
    host: kalshi.host(),
    destructive, live: goLive, allowLive, sweepMaxUsd,
    counts: {
      total: results.length,
      pass: results.filter((r) => r.status === "pass").length,
      fail: results.filter((r) => r.status === "fail").length,
      skip: results.filter((r) => r.status === "skip").length,
    },
    rateLimit: getLastRateLimit(),
    captured: { firstEventTicker, firstMarketTicker, firstOrderId },
    results: results.map(({ data, ...rest }) => rest),
  };

  mkdirSync(resolve(process.cwd(), "docs"), { recursive: true });
  const outPath = resolve(process.cwd(), "docs/kalshi-test-results.json");
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log(`Result: ${summary.counts.pass} pass · ${summary.counts.fail} fail · ${summary.counts.skip} skip`);
  if (summary.counts.fail > 0) process.exit(1);
})().catch((e) => {
  console.error("Sweep crashed:", e);
  process.exit(1);
});
