/**
 * Read-only dYdX Indexer endpoint sweep. The Indexer is open public market data
 * — no auth, no trading. This script exercises the public surfaces we'd consume
 * for cross-venue fair-value math (perpetual markets, orderbook, trades,
 * candles, sparklines, funding) and writes a structured report.
 *
 * Important: this script ONLY hits the Indexer. It does NOT touch the Node API,
 * does NOT submit any orders, and does NOT depend on having a dYdX wallet or
 * mnemonic. Reading the public Indexer is permitted; placing orders is what
 * triggers dYdX's geo-restriction terms, and this script does not do that.
 *
 *   npm exec tsx scripts/test-dydx-endpoints.ts                # mainnet
 *   npm exec tsx scripts/test-dydx-endpoints.ts --testnet      # testnet
 *   npm exec tsx scripts/test-dydx-endpoints.ts --market BTC-USD
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

type Status = "pass" | "fail" | "skip";
type Result = {
  category: string;
  name: string;
  method: string;
  url: string;
  status: Status;
  http?: number;
  ms?: number;
  error?: string;
  sample?: unknown;
};

const useTestnet = process.argv.includes("--testnet");
const marketArg = (() => {
  const i = process.argv.indexOf("--market");
  return i >= 0 ? process.argv[i + 1] : "BTC-USD";
})();

const MAINNET = "https://indexer.dydx.trade/v4";
const TESTNET = "https://indexer.v4testnet.dydx.exchange/v4";
const BASE = useTestnet ? TESTNET : MAINNET;

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

async function call(category: string, name: string, url: string): Promise<Result> {
  const started = Date.now();
  const res: Result = { category, name, method: "GET", url, status: "fail" };
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    res.http = r.status;
    res.ms = Date.now() - started;
    const text = await r.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch {}
    if (r.ok) {
      res.status = "pass";
      res.sample = trimForReport(body);
    } else {
      res.error = (typeof body === "string" ? body : JSON.stringify(body)).slice(0, 500);
    }
  } catch (err) {
    res.error = (err as Error).message;
    res.ms = Date.now() - started;
  }
  results.push(res);
  const tag = res.status === "pass" ? "✓" : res.status === "skip" ? "~" : "✗";
  const detail = res.status === "pass" ? `${res.http} in ${res.ms}ms` : `${res.http ?? "-"} ${res.error?.slice(0, 90)}`;
  console.log(`  [${tag}] ${category.padEnd(14)} ${name.padEnd(40)} ${detail}`);
  return res;
}

async function section(title: string, fn: () => Promise<void>) {
  console.log(`\n── ${title} ──`);
  await fn();
}

(async () => {
  console.log(`dYdX Indexer sweep  •  net=${useTestnet ? "testnet" : "mainnet"}  •  market=${marketArg}`);
  console.log(`base=${BASE}`);

  await section("Utility", async () => {
    await call("utility", "GET /time", `${BASE}/time`);
    await call("utility", "GET /height", `${BASE}/height`);
  });

  await section("Markets", async () => {
    await call("markets", "GET /perpetualMarkets", `${BASE}/perpetualMarkets`);
    await call("markets", "GET /perpetualMarkets?market=", `${BASE}/perpetualMarkets?market=${encodeURIComponent(marketArg)}`);
    await call("markets", `GET /orderbooks/perpetualMarket/${marketArg}`, `${BASE}/orderbooks/perpetualMarket/${encodeURIComponent(marketArg)}`);
    await call("markets", `GET /trades/perpetualMarket/${marketArg}`, `${BASE}/trades/perpetualMarket/${encodeURIComponent(marketArg)}?limit=50`);
    await call("markets", `GET /candles/perpetualMarkets/${marketArg}`, `${BASE}/candles/perpetualMarkets/${encodeURIComponent(marketArg)}?resolution=1MIN&limit=60`);
    await call("markets", `GET /historicalFunding/${marketArg}`, `${BASE}/historicalFunding/${encodeURIComponent(marketArg)}?limit=10`);
    await call("markets", "GET /sparklines?timePeriod=ONE_DAY", `${BASE}/sparklines?timePeriod=ONE_DAY`);
  });

  await section("Vaults", async () => {
    await call("vaults", "GET /vault/v1/megavault/positions", `${BASE}/vault/v1/megavault/positions`);
    await call("vaults", "GET /vault/v1/megavault/historicalPnl?resolution=day", `${BASE}/vault/v1/megavault/historicalPnl?resolution=day`);
  });

  // Compliance probe — non-destructive, deterministic. Confirms the screen
  // endpoint behaves; we don't pass a user-controlled address.
  await section("Compliance (read-only)", async () => {
    const probe = "dydx14zzueazeh0hj67cghhf9jypslcf9sh2n5k6art";
    await call("compliance", `GET /compliance/screen/${probe}`, `${BASE}/compliance/screen/${probe}`);
  });

  // Summary.
  const counts = results.reduce(
    (acc, r) => { acc[r.status]++; return acc; },
    { pass: 0, fail: 0, skip: 0 } as Record<Status, number>,
  );
  console.log(`\nResult: pass=${counts.pass} fail=${counts.fail} skip=${counts.skip}`);

  const outDir = resolve(process.cwd(), "docs");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, "dydx-test-results.json");
  writeFileSync(outPath, JSON.stringify({
    base: BASE,
    market: marketArg,
    network: useTestnet ? "testnet" : "mainnet",
    when: new Date().toISOString(),
    counts,
    results,
  }, null, 2));
  console.log(`Wrote ${outPath}`);

  process.exit(counts.fail > 0 ? 1 : 0);
})();
