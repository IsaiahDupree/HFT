/**
 * Exercises every Coinbase Advanced Trade endpoint our client wraps.
 *
 * Read-only by default. Mutating endpoints (POST /orders, batch_cancel,
 * portfolios, convert, intx/allocate, cfm sweeps) only run with `--destructive`
 * AND `COINBASE_ALLOW_TRADE=1` AND a non-zero `COINBASE_SWEEP_MAX_USD` (default
 * blocked at $0). Writes a structured report to docs/coinbase-test-results.json.
 *
 * Usage:
 *   tsx scripts/test-coinbase-endpoints.ts                       # read-only
 *   tsx scripts/test-coinbase-endpoints.ts --destructive         # preview-only (no real orders)
 *   COINBASE_ALLOW_TRADE=1 COINBASE_SWEEP_MAX_USD=2 \
 *     tsx scripts/test-coinbase-endpoints.ts --destructive --live   # WILL place tiny real orders
 */
import "./_env.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { cb, getLastRateLimit } from "../src/lib/coinbase/client.ts";
import { authIsAvailable, keyName } from "../src/lib/coinbase/auth.ts";

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
const sweepMaxUsd = Number(process.env.COINBASE_SWEEP_MAX_USD ?? "0");
const allowLive = goLive && process.env.COINBASE_ALLOW_TRADE === "1" && sweepMaxUsd > 0;

const results: Result[] = [];
const SAMPLE_BYTES = 1200;
const trimForReport = (data: unknown): unknown => {
  try {
    const s = JSON.stringify(data);
    if (s.length <= SAMPLE_BYTES) return data;
    return { _truncated: true, _preview: s.slice(0, SAMPLE_BYTES) + "…" };
  } catch {
    return String(data).slice(0, SAMPLE_BYTES);
  }
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
  const detail = res.status === "pass" ? `${res.http ?? "?"} in ${res.ms}ms` : res.status === "skip" ? "skipped" : `${res.http ?? "-"} ${res.error?.slice(0, 90)}`;
  console.log(`  [${tag}] ${category.padEnd(14)} ${name.padEnd(36)} ${detail}`);
  return res;
}

function skip(category: string, name: string, method: string, path: string, reason: string) {
  results.push({ category, name, method, path, status: "skip", error: reason });
  console.log(`  [~] ${category.padEnd(14)} ${name.padEnd(36)} skipped (${reason})`);
}

async function section(title: string, fn: () => Promise<void>) {
  console.log(`\n── ${title} ──`);
  await fn();
}

(async () => {
  console.log(`Coinbase Advanced Trade endpoint sweep`);
  console.log(`destructive=${destructive}  live=${goLive}  allow-live=${allowLive}  sweep-cap=$${sweepMaxUsd}`);
  if (authIsAvailable()) {
    console.log(`CDP key: ${keyName().slice(0, 64)}…`);
  } else {
    console.log(`CDP key: NOT FOUND — only public endpoints will pass`);
  }

  // Shared state populated during the sweep, used by later calls.
  let firstAccountUuid: string | null = null;
  let firstPortfolioUuid: string | null = null;
  let firstPaymentMethodId: string | null = null;
  let firstOrderId: string | null = null;
  const targetProductId = process.env.COINBASE_SWEEP_PRODUCT ?? "BTC-USD";

  await section("Public market data (no auth)", async () => {
    await run("public", "server time", "GET", "/time", () => cb.time());
    await run("public", "market list products (limit=3)", "GET", "/market/products", () => cb.publicListProducts({ limit: 3 }));
    await run("public", `market product ${targetProductId}`, "GET", `/market/products/${targetProductId}`, () => cb.publicGetProduct(targetProductId));
    await run("public", `market book ${targetProductId} (limit=5)`, "GET", "/market/product_book", () => cb.publicGetProductBook({ product_id: targetProductId, limit: 5 }));
    await run("public", `market trades ${targetProductId} (limit=5)`, "GET", `/market/products/${targetProductId}/ticker`, () => cb.publicGetMarketTrades(targetProductId, { limit: 5 }));
    const nowSec = Math.floor(Date.now() / 1000);
    await run("public", `market candles ${targetProductId} 1h`, "GET", `/market/products/${targetProductId}/candles`, () => cb.publicGetProductCandles(targetProductId, {
      start: String(nowSec - 3600 * 24),
      end: String(nowSec),
      granularity: "ONE_HOUR",
    }));
  });

  await section("Key permissions (auth)", async () => {
    if (!authIsAvailable()) return skip("auth", "key permissions", "GET", "/key_permissions", "no CDP key");
    await run("auth", "key permissions", "GET", "/key_permissions", () => cb.getKeyPermissions());
  });

  await section("Accounts (auth)", async () => {
    if (!authIsAvailable()) return skip("accounts", "list accounts", "GET", "/accounts", "no CDP key");
    const list = await run("accounts", "list accounts (limit=10)", "GET", "/accounts", () => cb.listAccounts({ limit: 10 }));
    if (list.status === "pass") {
      const accounts = (list.data as any)?.accounts ?? [];
      if (accounts[0]) firstAccountUuid = accounts[0].uuid;
    }
    if (firstAccountUuid) {
      await run("accounts", "get account", "GET", `/accounts/${firstAccountUuid.slice(0, 8)}…`, () => cb.getAccount(firstAccountUuid!));
    } else {
      skip("accounts", "get account", "GET", "/accounts/{uuid}", "no account uuid available");
    }
  });

  await section("Products (auth)", async () => {
    if (!authIsAvailable()) return skip("products", "list products", "GET", "/products", "no CDP key");
    await run("products", "list products (limit=3)", "GET", "/products", () => cb.listProducts({ limit: 3 }));
    await run("products", `get product ${targetProductId}`, "GET", `/products/${targetProductId}`, () => cb.getProduct(targetProductId));
    const nowSec = Math.floor(Date.now() / 1000);
    await run("products", `candles ${targetProductId} 1h`, "GET", `/products/${targetProductId}/candles`, () => cb.getProductCandles(targetProductId, {
      start: String(nowSec - 3600 * 24),
      end: String(nowSec),
      granularity: "ONE_HOUR",
    }));
    await run("products", `market trades ${targetProductId}`, "GET", `/products/${targetProductId}/ticker`, () => cb.getMarketTrades(targetProductId, { limit: 5 }));
    await run("products", `book ${targetProductId} (limit=5)`, "GET", "/product_book", () => cb.getProductBook({ product_id: targetProductId, limit: 5 }));
    await run("products", "best bid/ask", "GET", "/best_bid_ask", () => cb.getBestBidAsk({ product_ids: [targetProductId] }));
  });

  await section("Orders — read (auth)", async () => {
    if (!authIsAvailable()) return skip("orders", "list orders", "GET", "/orders/historical/batch", "no CDP key");
    const open = await run("orders", "list open orders", "GET", "/orders/historical/batch", () => cb.listOrders({ order_status: ["OPEN"], limit: 5 }));
    const filled = await run("orders", "list filled orders", "GET", "/orders/historical/batch", () => cb.listOrders({ order_status: ["FILLED"], limit: 5 }));
    await run("orders", "list fills", "GET", "/orders/historical/fills", () => cb.listFills({ limit: 5 }));
    const pickFirst = (r: Result) => ((r.data as any)?.orders ?? [])[0]?.order_id ?? null;
    firstOrderId = pickFirst(open) ?? pickFirst(filled);
    if (firstOrderId) {
      await run("orders", "get order", "GET", `/orders/historical/${firstOrderId.slice(0, 8)}…`, () => cb.getOrder(firstOrderId!));
    } else {
      skip("orders", "get order", "GET", "/orders/historical/{id}", "no orders in history");
    }
  });

  await section("Portfolios (auth)", async () => {
    if (!authIsAvailable()) return skip("portfolios", "list portfolios", "GET", "/portfolios", "no CDP key");
    const list = await run("portfolios", "list portfolios", "GET", "/portfolios", () => cb.listPortfolios());
    if (list.status === "pass") {
      firstPortfolioUuid = ((list.data as any)?.portfolios ?? [])[0]?.uuid ?? null;
    }
    if (firstPortfolioUuid) {
      await run("portfolios", "get breakdown", "GET", `/portfolios/${firstPortfolioUuid.slice(0, 8)}…`, () => cb.getPortfolioBreakdown(firstPortfolioUuid!));
    } else {
      skip("portfolios", "get breakdown", "GET", "/portfolios/{uuid}", "no portfolio uuid");
    }
  });

  await section("Fees / payment methods (auth)", async () => {
    if (!authIsAvailable()) {
      skip("fees", "transaction summary", "GET", "/transaction_summary", "no CDP key");
      skip("payments", "list payment methods", "GET", "/payment_methods", "no CDP key");
      return;
    }
    await run("fees", "transaction summary", "GET", "/transaction_summary", () => cb.getTransactionSummary());
    const pm = await run("payments", "list payment methods", "GET", "/payment_methods", () => cb.listPaymentMethods());
    if (pm.status === "pass") {
      firstPaymentMethodId = ((pm.data as any)?.payment_methods ?? [])[0]?.id ?? null;
    }
    if (firstPaymentMethodId) {
      await run("payments", "get payment method", "GET", `/payment_methods/${firstPaymentMethodId.slice(0, 8)}…`, () => cb.getPaymentMethod(firstPaymentMethodId!));
    } else {
      skip("payments", "get payment method", "GET", "/payment_methods/{id}", "no payment method id");
    }
  });

  await section("Futures CFM (auth, US-only entitlement)", async () => {
    if (!authIsAvailable()) return skip("cfm", "balance summary", "GET", "/cfm/balance_summary", "no CDP key");
    await run("cfm", "balance summary", "GET", "/cfm/balance_summary", () => cb.cfmBalanceSummary());
    await run("cfm", "list positions", "GET", "/cfm/positions", () => cb.cfmListPositions());
    await run("cfm", "list sweeps", "GET", "/cfm/sweeps", () => cb.cfmListSweeps());
    await run("cfm", "intraday margin setting", "GET", "/cfm/intraday/margin_setting", () => cb.cfmGetIntradayMarginSetting());
  });

  await section("Perpetuals INTX (auth, non-US entitlement)", async () => {
    if (!authIsAvailable() || !firstPortfolioUuid) {
      return skip("intx", "perps positions", "GET", "/intx/positions/{uuid}", !firstPortfolioUuid ? "no portfolio uuid" : "no CDP key");
    }
    await run("intx", "portfolio summary", "GET", `/intx/portfolio/${firstPortfolioUuid.slice(0, 8)}…`, () => cb.intxGetPortfolioSummary(firstPortfolioUuid!));
    await run("intx", "perps positions", "GET", `/intx/positions/${firstPortfolioUuid.slice(0, 8)}…`, () => cb.intxListPositions(firstPortfolioUuid!));
    await run("intx", "perps balances", "GET", `/intx/balances/${firstPortfolioUuid.slice(0, 8)}…`, () => cb.intxGetBalances(firstPortfolioUuid!));
  });

  await section("Orders — destructive (gated)", async () => {
    if (!destructive) {
      ["preview market BUY", "create order (LIVE)", "batch cancel", "edit order", "edit preview", "close position"].forEach((n) =>
        skip("orders!", n, "POST", "/orders/*", "--destructive flag not set"));
      return;
    }
    // Preview is safe — no funds move.
    if (authIsAvailable()) {
      const body = {
        product_id: targetProductId,
        side: "BUY",
        order_configuration: { market_market_ioc: { quote_size: String(Math.max(sweepMaxUsd, 1)) } },
        commission_rate: undefined,
      };
      await run("orders!", "preview market BUY", "POST", "/orders/preview", () => cb.previewOrder(body));
    } else {
      skip("orders!", "preview market BUY", "POST", "/orders/preview", "no CDP key");
    }
    if (!allowLive) {
      ["create order (LIVE)", "batch cancel"].forEach((n) =>
        skip("orders!", n, "POST", "/orders", "requires --live + COINBASE_ALLOW_TRADE=1 + COINBASE_SWEEP_MAX_USD>0"));
      return;
    }
    // Place a tiny LIVE order at the sweep-cap dollar amount. Default product is BTC-USD.
    const placeBody = {
      client_order_id: randomUUID(),
      product_id: targetProductId,
      side: "BUY" as const,
      order_configuration: { market_market_ioc: { quote_size: String(sweepMaxUsd) } },
    };
    const placed = await run("orders!", "create order (LIVE)", "POST", "/orders", () => cb.createOrder(placeBody as any));
    const orderId = (placed.data as any)?.order_id ?? (placed.data as any)?.success_response?.order_id;
    if (orderId) {
      await run("orders!", "batch cancel placed order", "POST", "/orders/batch_cancel", () => cb.batchCancelOrders({ order_ids: [orderId] }));
    } else {
      skip("orders!", "batch cancel placed order", "POST", "/orders/batch_cancel", "no order_id from placement");
    }
  });

  // --- Summary + report ---
  const counts = results.reduce(
    (acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; },
    { pass: 0, fail: 0, skip: 0 } as Record<Status, number>,
  );
  console.log(`\nSweep complete:  pass=${counts.pass}  fail=${counts.fail}  skip=${counts.skip}  total=${results.length}`);
  const rl = getLastRateLimit();
  if (rl.remaining !== undefined) console.log(`Last rate-limit: remaining=${rl.remaining}/${rl.limit ?? "?"}, reset=${rl.resetUnix ?? "?"}`);

  // Strip `.data` (full bodies) from the persisted report — keep only `.sample`.
  const report = {
    generated_at: new Date().toISOString(),
    key_name_preview: authIsAvailable() ? `${keyName().slice(0, 64)}…` : null,
    destructive,
    allow_live: allowLive,
    counts,
    results: results.map(({ data: _data, ...rest }) => rest),
  };
  mkdirSync(resolve("docs"), { recursive: true });
  writeFileSync(resolve("docs/coinbase-test-results.json"), JSON.stringify(report, null, 2));
  console.log(`Report → docs/coinbase-test-results.json`);
  process.exit(counts.fail > 0 ? 1 : 0);
})();
