/**
 * dYdX testnet trading probe. Exercises the full sign-and-broadcast path:
 *   1. Connect CompositeClient
 *   2. Load wallet, fetch subaccount (faucet if balance < $10)
 *   3. Read live orderbook → derive a post-only price far from the touch
 *   4. Place a long-term post-only LIMIT order
 *   5. Verify it appears in the Indexer orders feed
 *   6. Cancel it
 *   7. Verify cancellation
 *
 *   npm run test:dydx:trade                       # testnet, ETH-USD, $25 notional
 *   npm run test:dydx:trade -- --market BTC-USD --notional 50
 *   npm run test:dydx:trade -- --skip-faucet      # if already funded
 *   npm run test:dydx:trade -- --side SELL
 */
import "./_env";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadWallet,
  makeCompositeClient,
  makeFaucetClient,
  makeIndexerClient,
  resolveNet,
  sdk,
} from "../src/lib/hft/dydx";
const { OrderExecution, OrderSide, OrderTimeInForce, OrderType } = sdk;

type Step = {
  name: string;
  status: "pass" | "fail" | "skip";
  ms: number;
  detail?: unknown;
  error?: string;
};

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const market = argValue("market", "ETH-USD");
const notional = Number(argValue("notional", "25"));
const sideArg = (argValue("side", "BUY").toUpperCase() as "BUY" | "SELL");
const subaccountNumber = Number(argValue("subaccount", "0"));
const skipFaucet = process.argv.includes("--skip-faucet");
const goodTilSec = Number(argValue("good-til-sec", "120"));

const net = resolveNet();
const steps: Step[] = [];

async function step<T>(name: string, fn: () => Promise<T>, opts: { skip?: boolean } = {}): Promise<T | undefined> {
  if (opts.skip) {
    steps.push({ name, status: "skip", ms: 0 });
    console.log(`  [~] ${name}  skipped`);
    return undefined;
  }
  const t0 = Date.now();
  try {
    const out = await fn();
    const ms = Date.now() - t0;
    steps.push({ name, status: "pass", ms, detail: redact(out) });
    console.log(`  [✓] ${name}  ${ms}ms`);
    return out;
  } catch (e) {
    const ms = Date.now() - t0;
    const error = (e as Error).message ?? String(e);
    steps.push({ name, status: "fail", ms, error });
    console.error(`  [✗] ${name}  ${ms}ms  ${error.slice(0, 140)}`);
    throw e;
  }
}

function redact(v: unknown): unknown {
  // Keep payloads small in the report.
  try {
    const s = JSON.stringify(v);
    if (s.length <= 600) return v;
    return { _truncated: true, _preview: s.slice(0, 600) + "…" };
  } catch {
    return String(v).slice(0, 600);
  }
}

(async () => {
  console.log(`dYdX trading probe • net=${net} • market=${market} • side=${sideArg} • notional=$${notional}`);

  const { wallet, subaccount, address } = await step("load-wallet", async () => loadWallet(net, subaccountNumber)) ?? ({} as any);
  console.log(`  address=${address} subaccount=${subaccountNumber}`);

  const composite = await step("composite-connect", () => makeCompositeClient(net));
  if (!composite) return process.exit(1);
  const indexer = makeIndexerClient(net);

  // Subaccount snapshot. If equity < $10 and we're on testnet and faucet not
  // skipped, drip funds.
  const acct = await step("indexer.getSubaccount", () => indexer.account.getSubaccount(address, subaccountNumber)).catch(() => undefined);
  const equity = Number(acct?.subaccount?.equity ?? "0");
  console.log(`  equity=$${equity}`);

  if (equity < 10 && net === "testnet" && !skipFaucet) {
    await step("faucet.fill", async () => {
      const faucet = makeFaucetClient();
      const r1 = await faucet.fill(address, subaccountNumber, 2000);
      const r2 = await faucet.fillNative(address);
      return { usdc: r1.status, native: r2.status };
    });
    // Poll for funds.
    let funded = false;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      try {
        const s = await indexer.account.getSubaccount(address, subaccountNumber);
        const eq = Number(s?.subaccount?.equity ?? "0");
        if (eq >= 10) { funded = true; break; }
      } catch {}
    }
    if (!funded) console.warn("  faucet drip did not credit within 30s — continuing anyway");
  } else if (equity < 10 && net === "mainnet") {
    console.warn("  equity < $10 on mainnet — fund the wallet before placing orders");
  }

  // Get oracle price for the market.
  const markets = await step("indexer.getPerpetualMarkets", () => indexer.markets.getPerpetualMarkets(market));
  const m = (markets as any)?.markets?.[market];
  if (!m) {
    console.error(`market ${market} not found in indexer response`);
    return process.exit(1);
  }
  const oraclePrice = Number(m.oraclePrice);
  const tickSize = Number(m.tickSize);
  const stepSize = Number(m.stepSize);
  console.log(`  oraclePrice=${oraclePrice} tickSize=${tickSize} stepSize=${stepSize}`);

  // Choose a post-only price 5% inside the wrong side (so it can't cross).
  // BUY → 5% below oracle  |  SELL → 5% above oracle. Round to tick.
  const offsetBps = 500; // 5%
  const rawPrice = sideArg === "BUY" ? oraclePrice * (1 - offsetBps / 10000) : oraclePrice * (1 + offsetBps / 10000);
  const price = +(Math.round(rawPrice / tickSize) * tickSize).toFixed(10);
  const rawSize = notional / oraclePrice;
  const size = +(Math.max(stepSize, Math.round(rawSize / stepSize) * stepSize)).toFixed(10);
  const clientId = Math.floor(Math.random() * 0xffffffff);
  console.log(`  order: ${sideArg} ${size} @ ${price}  clientId=${clientId}`);

  const placeResult = await step("composite.placeOrder", () =>
    composite.placeOrder(
      subaccount,
      market,
      OrderType.LIMIT,
      sideArg === "BUY" ? OrderSide.BUY : OrderSide.SELL,
      price,
      size,
      clientId,
      OrderTimeInForce.GTT,
      goodTilSec,
      OrderExecution.POST_ONLY,
      true,   // postOnly
      false,  // reduceOnly
    ),
  );
  console.log(`  txHash=${(placeResult as any)?.hash ? Buffer.from((placeResult as any).hash).toString("hex") : "(synchronous receipt)"}`);

  // Indexer takes ~1-3s to reflect long-term orders.
  let order: any = undefined;
  await step("indexer.getSubaccountOrders (find placed)", async () => {
    for (let i = 0; i < 8; i++) {
      const list = await indexer.account.getSubaccountOrders(address, subaccountNumber);
      const arr: any[] = Array.isArray(list) ? list : ((list as any)?.orders ?? []);
      const match = arr.find((o) => Number(o.clientId) === clientId);
      if (match) { order = match; return match; }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`order with clientId=${clientId} not visible after 12s`);
  });
  console.log(`  indexer order status=${order?.status} id=${order?.id}`);

  // Cancel it. For LONG_TERM orders (flag 64), the SDK requires goodTilBlock=0
  // and goodTilTimeInSeconds to carry the order's expiry.
  await step("composite.cancelOrder", () =>
    composite.cancelOrder(
      subaccount,
      clientId,
      64, // OrderFlags.LONG_TERM
      market,
      0,
      goodTilSec,
    ),
  );

  // Verify cancellation.
  await step("indexer.getSubaccountOrders (verify cancel)", async () => {
    for (let i = 0; i < 8; i++) {
      const list = await indexer.account.getSubaccountOrders(address, subaccountNumber);
      const arr: any[] = Array.isArray(list) ? list : ((list as any)?.orders ?? []);
      const match = arr.find((o) => Number(o.clientId) === clientId);
      const status = match?.status;
      if (!match || status === "CANCELED" || status === "BEST_EFFORT_CANCELED") return { status };
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`order not observed as cancelled after 12s`);
  });

  const counts = steps.reduce(
    (a, s) => { a[s.status]++; return a; },
    { pass: 0, fail: 0, skip: 0 } as Record<Step["status"], number>,
  );
  console.log(`\nResult: pass=${counts.pass} fail=${counts.fail} skip=${counts.skip}`);

  const outPath = resolve(process.cwd(), "docs", "dydx-trading-results.json");
  writeFileSync(outPath, JSON.stringify({
    net, market, side: sideArg, notional, address, subaccountNumber,
    clientId, price, size, when: new Date().toISOString(),
    counts, steps,
  }, null, 2));
  console.log(`Wrote ${outPath}`);
  process.exit(counts.fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("FATAL:", (e as Error).stack ?? e);
  const outPath = resolve(process.cwd(), "docs", "dydx-trading-results.json");
  try {
    writeFileSync(outPath, JSON.stringify({ net, market, side: sideArg, error: (e as Error).message, steps }, null, 2));
  } catch {}
  process.exit(1);
});
