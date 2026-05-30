/**
 * Exercises every Polymarket REST endpoint we know about. Read-only by default;
 * destructive endpoints (place order, cancel, relayer submit) run only with
 * `--destructive`. Writes a structured report to docs/test-results.json.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "./_env.ts";

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
  sample?: unknown; // trimmed for the JSON report
  data?: unknown; // full body for downstream test logic; stripped before serialize
};

const results: Result[] = [];
const destructive = process.argv.includes("--destructive");
let sharedTokenID: string | null = null;
let sharedConditionID: string | null = null;
let sharedEventID: number | string | null = null;

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

async function call(category: string, name: string, method: string, url: string, init: RequestInit = {}): Promise<Result> {
  const started = Date.now();
  const res: Result = { category, name, method, url, status: "fail" };
  try {
    const r = await fetch(url, { method, ...init });
    res.http = r.status;
    res.ms = Date.now() - started;
    const text = await r.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch {}
    if (r.ok) {
      res.status = "pass";
      res.data = body;
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
  const detail = res.status === "pass" ? `${res.http} in ${res.ms}ms` : res.status === "skip" ? "skipped" : `${res.http ?? "-"} ${res.error?.slice(0, 90)}`;
  console.log(`  [${tag}] ${category.padEnd(14)} ${name.padEnd(38)} ${detail}`);
  return res;
}

function skip(category: string, name: string, method: string, url: string, reason: string) {
  results.push({ category, name, method, url, status: "skip", error: reason });
  console.log(`  [~] ${category.padEnd(14)} ${name.padEnd(38)} skipped (${reason})`);
}

async function section(title: string, fn: () => Promise<void>) {
  console.log(`\n── ${title} ──`);
  await fn();
}

(async () => {
  console.log(`Polymarket endpoint sweep  •  destructive=${destructive}`);
  console.log(`Relayer signer: ${env.RELAYER_API_KEY_ADDRESS || "(not set)"}`);

  await section("Gamma API (public)", async () => {
    const events = await call("gamma", "list events (limit=3)", "GET", `${env.GAMMA}/events?limit=3&closed=false`);
    if (events.status === "pass" && Array.isArray(events.data) && events.data[0]) {
      const ev = events.data[0] as any;
      sharedEventID = ev.id ?? null;
      const firstMkt = ev.markets?.[0];
      if (firstMkt) {
        sharedConditionID = firstMkt.conditionId ?? null;
        try {
          const tokenIds = JSON.parse(firstMkt.clobTokenIds ?? "[]");
          if (tokenIds[0]) sharedTokenID = tokenIds[0];
        } catch {}
      }
    }
    if (sharedEventID) await call("gamma", "event by id", "GET", `${env.GAMMA}/events/${sharedEventID}`);
    const markets = await call("gamma", "list markets (limit=3)", "GET", `${env.GAMMA}/markets?limit=3&closed=false`);
    if (markets.status === "pass" && Array.isArray(markets.data) && markets.data[0]) {
      const m = markets.data[0] as any;
      if (!sharedConditionID) sharedConditionID = m.conditionId ?? null;
      if (!sharedTokenID) {
        try {
          const tokenIds = JSON.parse(m.clobTokenIds ?? "[]");
          if (tokenIds[0]) sharedTokenID = tokenIds[0];
        } catch {}
      }
    }
    if (sharedConditionID) await call("gamma", "market by conditionId", "GET", `${env.GAMMA}/markets?condition_ids=${sharedConditionID}`);
    await call("gamma", "tags (limit=3)", "GET", `${env.GAMMA}/tags?limit=3`);
    await call("gamma", "series (limit=3)", "GET", `${env.GAMMA}/series?limit=3`);
    if (sharedEventID) {
      await call("gamma", "comments by event", "GET", `${env.GAMMA}/comments?parent_entity_type=Event&parent_entity_id=${sharedEventID}&limit=3`);
    } else {
      skip("gamma", "comments by event", "GET", "—", "no event id available");
    }
    await call("gamma", "public-search", "GET", `${env.GAMMA}/public-search?q=trump&limit_per_type=2`);
    await call("gamma", "sports metadata", "GET", `${env.GAMMA}/sports`);
    await call("gamma", "teams", "GET", `${env.GAMMA}/teams?limit=3`);
    if (env.RELAYER_API_KEY_ADDRESS) {
      // Profile lookups expect the **proxy** wallet, not the signer — try lowercase signer first,
      // then fall through to whatever proxy we already know about. A 404 here is informational.
      await call("gamma", "public profile by wallet (signer addr)", "GET", `${env.GAMMA}/public-profile?address=${env.RELAYER_API_KEY_ADDRESS.toLowerCase()}`);
    }
  });

  await section("Data API (public)", async () => {
    const addr = env.RELAYER_API_KEY_ADDRESS;
    if (addr) {
      await call("data", "user positions", "GET", `${env.DATA}/positions?user=${addr}&limit=5`);
      await call("data", "user activity", "GET", `${env.DATA}/activity?user=${addr}&limit=5`);
      await call("data", "user trades", "GET", `${env.DATA}/trades?user=${addr}&limit=5`);
      await call("data", "user closed positions", "GET", `${env.DATA}/closed-positions?user=${addr}&limit=5`);
      await call("data", "user portfolio value", "GET", `${env.DATA}/value?user=${addr}`);
      await call("data", "user traded markets count", "GET", `${env.DATA}/traded?user=${addr}`);
    } else {
      skip("data", "user-scoped endpoints", "GET", "—", "no signer address");
    }
    if (sharedConditionID) {
      await call("data", "market positions (v1)", "GET", `${env.DATA}/v1/market-positions?market=${sharedConditionID}&status=ALL`);
      await call("data", "top holders", "GET", `${env.DATA}/holders?market=${sharedConditionID}&limit=5`);
    }
    if (sharedEventID && typeof sharedEventID !== "string") {
      await call("data", "live event volume", "GET", `${env.DATA}/live-volume?id=${sharedEventID}`);
    } else if (sharedEventID) {
      await call("data", "live event volume", "GET", `${env.DATA}/live-volume?id=${sharedEventID}`);
    }
    await call("data", "open interest", "GET", `${env.DATA}/oi`);
    await call("data", "trader leaderboard", "GET", `${env.DATA}/v1/leaderboard?category=OVERALL&timePeriod=DAY&orderBy=PNL&limit=5`);
  });

  await section("CLOB public", async () => {
    await call("clob-pub", "health", "GET", `${env.CLOB}/ok`);
    await call("clob-pub", "server time", "GET", `${env.CLOB}/time`);
    const mks = await call("clob-pub", "list markets (limit=3)", "GET", `${env.CLOB}/markets?limit=3`);
    if (mks.status === "pass" && (mks.data as any)?.data?.[0]) {
      const m = (mks.data as any).data[0];
      if (!sharedTokenID && m.tokens?.[0]?.token_id) sharedTokenID = m.tokens[0].token_id;
      if (!sharedConditionID && m.condition_id) sharedConditionID = m.condition_id;
    }
    const sampling = await call("clob-pub", "sampling-markets", "GET", `${env.CLOB}/sampling-markets?limit=3`);
    // Sampling markets are reward-eligible → always have an orderbook. Prefer one of these for the token-scoped tests.
    if (sampling.status === "pass") {
      const first = (sampling.data as any)?.data?.[0];
      const liveToken = first?.tokens?.find((t: any) => t.token_id)?.token_id ?? null;
      if (liveToken) sharedTokenID = liveToken;
      if (first?.condition_id) sharedConditionID = first.condition_id;
    }
    await call("clob-pub", "simplified-markets", "GET", `${env.CLOB}/simplified-markets?limit=3`);
    if (sharedConditionID) await call("clob-pub", "market by condition", "GET", `${env.CLOB}/markets/${sharedConditionID}`);
    if (sharedTokenID) {
      await call("clob-pub", "orderbook", "GET", `${env.CLOB}/book?token_id=${sharedTokenID}`);
      await call("clob-pub", "price (BUY)", "GET", `${env.CLOB}/price?token_id=${sharedTokenID}&side=BUY`);
      await call("clob-pub", "price (SELL)", "GET", `${env.CLOB}/price?token_id=${sharedTokenID}&side=SELL`);
      await call("clob-pub", "midpoint", "GET", `${env.CLOB}/midpoint?token_id=${sharedTokenID}`);
      await call("clob-pub", "spread", "GET", `${env.CLOB}/spread?token_id=${sharedTokenID}`);
      await call("clob-pub", "last-trade-price", "GET", `${env.CLOB}/last-trade-price?token_id=${sharedTokenID}`);
      await call("clob-pub", "prices-history", "GET", `${env.CLOB}/prices-history?market=${sharedTokenID}&interval=1d&fidelity=60`);
      await call("clob-pub", "tick-size", "GET", `${env.CLOB}/tick-size?token_id=${sharedTokenID}`);
    } else {
      skip("clob-pub", "token-scoped market data", "GET", "—", "no shared token id");
    }
  });

  await section("CLOB authenticated (L2)", async () => {
    if (!env.CLOB_API_KEY || !env.CLOB_SECRET || !env.CLOB_PASSPHRASE) {
      skip("clob-auth", "all", "GET", "—", "no L2 creds — run `npm run derive:creds`");
      return;
    }
    const { hmacSign } = await import("../src/lib/polymarket/sign.ts");
    const headers = (method: string, path: string, body?: string) => {
      const ts = Math.floor(Date.now() / 1000).toString();
      const sig = hmacSign(env.CLOB_SECRET, ts, method, path, body);
      return {
        POLY_ADDRESS: env.RELAYER_API_KEY_ADDRESS,
        POLY_API_KEY: env.CLOB_API_KEY,
        POLY_PASSPHRASE: env.CLOB_PASSPHRASE,
        POLY_TIMESTAMP: ts,
        POLY_SIGNATURE: sig,
        "Content-Type": "application/json",
      };
    };
    await call("clob-auth", "list api keys", "GET", `${env.CLOB}/auth/api-keys`, { headers: headers("GET", "/auth/api-keys") });
    await call("clob-auth", "open orders", "GET", `${env.CLOB}/data/orders`, { headers: headers("GET", "/data/orders") });
    await call("clob-auth", "user trades", "GET", `${env.CLOB}/data/trades`, { headers: headers("GET", "/data/trades") });
    // Per py-clob-client: query string is NOT signed; signing path is the bare endpoint.
    await call("clob-auth", "balance (collateral)", "GET", `${env.CLOB}/balance-allowance?asset_type=COLLATERAL&signature_type=${env.SIGNATURE_TYPE}`, {
      headers: headers("GET", "/balance-allowance"),
    });
    await call("clob-auth", "notifications", "GET", `${env.CLOB}/notifications?signature_type=${env.SIGNATURE_TYPE}`, {
      headers: headers("GET", "/notifications"),
    });
  });

  await section("Relayer", async () => {
    if (!env.RELAYER_API_KEY || !env.RELAYER_API_KEY_ADDRESS) {
      skip("relayer", "all", "GET", "—", "no relayer key");
      return;
    }
    const auth: Record<string, string> = {
      RELAYER_API_KEY: env.RELAYER_API_KEY,
      RELAYER_API_KEY_ADDRESS: env.RELAYER_API_KEY_ADDRESS,
    };
    await call("relayer", "relay-payload (PROXY nonce)", "GET", `${env.RELAYER}/relay-payload?address=${env.RELAYER_API_KEY_ADDRESS}&type=PROXY`, { headers: auth });
    await call("relayer", "relay-payload (SAFE nonce)", "GET", `${env.RELAYER}/relay-payload?address=${env.RELAYER_API_KEY_ADDRESS}&type=SAFE`, { headers: auth });
    await call("relayer", "deployed (SAFE)", "GET", `${env.RELAYER}/deployed?address=${env.RELAYER_API_KEY_ADDRESS}&type=SAFE`, { headers: auth });
    await call("relayer", "deployed (WALLET)", "GET", `${env.RELAYER}/deployed?address=${env.RELAYER_API_KEY_ADDRESS}&type=WALLET`, { headers: auth });
    await call("relayer", "recent transactions", "GET", `${env.RELAYER}/transactions?address=${env.RELAYER_API_KEY_ADDRESS}`, { headers: auth });
    await call("relayer", "list relayer api keys", "GET", `${env.RELAYER}/relayer/api/keys`, { headers: auth });
    skip("relayer", "POST /submit", "POST", `${env.RELAYER}/submit`, destructive ? "destructive: requires a real signed tx; not synthesized here" : "destructive — pass --destructive (still requires a real signed tx)");
  });

  await section("CLOB destructive (trading)", async () => {
    if (!destructive) {
      skip("clob-trade", "POST /order", "POST", `${env.CLOB}/order`, "destructive — pass --destructive AND set ALLOW_TRADE=1");
      skip("clob-trade", "DELETE /order", "DELETE", `${env.CLOB}/order`, "destructive");
      skip("clob-trade", "DELETE /cancel-all", "DELETE", `${env.CLOB}/cancel-all`, "destructive");
      return;
    }
    if (process.env.ALLOW_TRADE !== "1") {
      skip("clob-trade", "all", "POST", "—", "destructive flag set but ALLOW_TRADE!=1 — bailing out to be safe");
      return;
    }
    console.log("  TRADE EXECUTION GUARD: refuse to fabricate orders here. Use src/lib/polymarket/orders.ts from the app.");
  });

  // Strip the `data` field (kept around only for in-test extraction) before writing the report.
  const slim = results.map(({ data: _drop, ...rest }) => rest);
  const summary = {
    timestamp: new Date().toISOString(),
    destructive,
    pass: results.filter((r) => r.status === "pass").length,
    fail: results.filter((r) => r.status === "fail").length,
    skip: results.filter((r) => r.status === "skip").length,
    total: results.length,
    sharedTokenID,
    sharedConditionID,
    sharedEventID,
    results: slim,
  };
  mkdirSync(resolve(process.cwd(), "docs"), { recursive: true });
  writeFileSync(resolve(process.cwd(), "docs/test-results.json"), JSON.stringify(summary, null, 2));
  console.log(`\nResults  pass=${summary.pass}  fail=${summary.fail}  skip=${summary.skip}  →  docs/test-results.json`);
})().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
