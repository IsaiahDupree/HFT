/**
 * Trade execution with hard safety gates.
 *
 * Three layers of protection — ALL must be satisfied for a real order to fire:
 *   1. ENV: ALLOW_TRADE=1 (otherwise DRY_RUN, only logs intent)
 *   2. Per-trade cap: MAX_TRADE_USD (default $25)
 *   3. Per-day cap:   MAX_DAILY_USD (default $100, computed from evolution_log)
 *
 * Every intended execution writes an evolution_log row BEFORE attempting the
 * trade so we always have an audit trail, even on crash. Live submissions go
 * through @polymarket/clob-client's `createAndPostMarketOrder` (FOK by default).
 *
 * Provides a `killSwitch()` that calls `cancelAll()` if anything goes wrong.
 */
import { db } from "@/lib/db/client";
import { insertEvolutionEvent } from "@/lib/db/queries";
import type { SingleMarketArb } from "./arb";
import { installProxyRoutingOnce, ensureProxyRoutingReady, polyFetch } from "./proxy-routing";

// Patch axios's default instance once, BEFORE the SDK is dynamic-imported.
// Both @polymarket/clob-client and @polymarket/clob-client-v2 import the
// singleton axios, so this interceptor applies to their SDK requests too.
// Set POLYMARKET_PROXY_URL=http://user:pass@host:port to enable.
installProxyRoutingOnce();

// SDK is heavy + dynamic-loaded so the module is usable in environments
// (the UI server pages) that should never trade.
type ClobClient = any;
let _clientPromise: Promise<ClobClient> | null = null;

/**
 * Lazy client factory. Flip POLYMARKET_CLOB_V2=1 to use the new
 * @polymarket/clob-client-v2 (current generation) instead of the legacy
 * @polymarket/clob-client@4 (archived upstream). Both expose
 * `createAndPostMarketOrder` and `cancelAll` so the call sites below stay
 * unchanged.
 *
 * Migration plan (see docs/inspiration/MIGRATION-TARGETS.md §3):
 *   1. Run with POLYMARKET_CLOB_V2=1 on a paper / tiny-size sanity run
 *   2. Verify endpoint sweep + executeSingleMarketArb against the v2 path
 *   3. Flip the default, then drop the v4 dep
 */
async function getClobClient(): Promise<ClobClient> {
  if (!_clientPromise) {
    const useV2 = process.env.POLYMARKET_CLOB_V2 === "1";
    _clientPromise = useV2 ? buildV2Client() : buildV4Client();
  }
  // Await the async proxy-routing patch — installProxyRoutingOnce fires it
  // off in the background to keep module-load synchronous; here we ensure
  // it's actually applied before the SDK's first network call.
  await ensureProxyRoutingReady();
  return _clientPromise;
}

async function buildV4Client(): Promise<ClobClient> {
  const mod: any = await import("@polymarket/clob-client");
  const ClobClient = mod.ClobClient ?? mod.default?.ClobClient;
  const apiCreds = {
    key: process.env.POLYMARKET_CLOB_API_KEY ?? "",
    secret: process.env.POLYMARKET_CLOB_SECRET ?? "",
    passphrase: process.env.POLYMARKET_CLOB_PASSPHRASE ?? "",
  };
  // Bug #16 defense (2026-05-26): if env parsing returns NaN (e.g. inline
  // comment leaked into the value) fall back to POLY_PROXY (1), the documented
  // production setup. The pre-fix path was silently signing with EOA (0)
  // because the downstream SDK does `if (!sigType) sigType = EOA`.
  const sigTypeRaw = Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? "1");
  const sigType = Number.isFinite(sigTypeRaw) ? sigTypeRaw : 1;
  const funder = process.env.POLYMARKET_FUNDER_ADDRESS || process.env.POLYMARKET_RELAYER_API_KEY_ADDRESS || "";
  // The v4 SDK expects an ethers Signer; build one off the private key.
  const ethers = await import("ethers");
  const wallet = new ethers.Wallet(process.env.POLYMARKET_PRIVATE_KEY!);
  const host = process.env.POLYMARKET_CLOB_HOST ?? "https://clob.polymarket.com";
  const chain = Number(process.env.POLYMARKET_CHAIN_ID ?? "137");
  return new ClobClient(host, chain, wallet, apiCreds, sigType, funder);
}

async function buildV2Client(): Promise<ClobClient> {
  const mod: any = await import("@polymarket/clob-client-v2");
  const ClobClient = mod.ClobClient ?? mod.default?.ClobClient;
  const ethers = await import("ethers");
  const wallet = new ethers.Wallet(process.env.POLYMARKET_PRIVATE_KEY!);
  // Bug #16 defense — same NaN guard as buildV4Client.
  const v2SigRaw = Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? "1");
  const v2SigType = Number.isFinite(v2SigRaw) ? v2SigRaw : 1;
  return new ClobClient({
    host: process.env.POLYMARKET_CLOB_HOST ?? "https://clob.polymarket.com",
    chain: Number(process.env.POLYMARKET_CHAIN_ID ?? "137"),
    signer: wallet,
    creds: {
      key: process.env.POLYMARKET_CLOB_API_KEY ?? "",
      secret: process.env.POLYMARKET_CLOB_SECRET ?? "",
      passphrase: process.env.POLYMARKET_CLOB_PASSPHRASE ?? "",
    },
    signatureType: v2SigType,
    funderAddress: process.env.POLYMARKET_FUNDER_ADDRESS || process.env.POLYMARKET_RELAYER_API_KEY_ADDRESS || undefined,
  });
}

/** Test hook — reset the cached client so subsequent calls re-evaluate the env flag. */
export function resetClobClientForTests(): void {
  _clientPromise = null;
}

export type ExecuteMode = "DRY_RUN" | "LIVE";

function readMode(): ExecuteMode {
  return process.env.ALLOW_TRADE === "1" ? "LIVE" : "DRY_RUN";
}
function readMaxTradeUsd(): number {
  return Number(process.env.MAX_TRADE_USD ?? "25");
}
function readMaxDailyUsd(): number {
  return Number(process.env.MAX_DAILY_USD ?? "100");
}

/** Sum executed-arb USD spend in the last 24h from evolution_log.
 *  Includes 'arb-partial' because partial fills DO commit real cash even
 *  though only one leg succeeded — they count against the daily cap.
 *  Bug-fix 2026-05-26 (bug #11). */
function dailyExecutedUsd(): number {
  const row = db().prepare(
    `SELECT COALESCE(SUM(json_extract(payload_json, '$.cost_usd')), 0) AS spend
     FROM evolution_log
     WHERE event_type IN ('arb-executed', 'arb-partial')
       AND created_at > datetime('now', '-1 day')`,
  ).get() as { spend: number };
  return row.spend ?? 0;
}

/**
 * Submit an order to Polymarket's CLOB using the SDK to LOCALLY sign the
 * order, then POSTing via polyFetch — which routes through Webshare proxy.
 *
 * Why this exists (bug #22 final fix, 2026-05-27):
 * The clob-client-v2 SDK ships its own nested axios with separate ESM + CJS
 * builds. Our axios.interceptors patch only catches some of the SDK's
 * HTTP paths; the rest go through nested instances that bypass our agent
 * injection and hit the broker direct (= 403 geoblock from US IP).
 *
 * Instead of fighting Node's module-cache CJS/ESM split, we re-implement the
 * postOrder step using primitives the SDK exports (createL2Headers,
 * orderToJsonV2) and submit via polyFetch which provably proxies. The SDK's
 * own createMarketOrder() is still used for local EIP-712 signing — it
 * doesn't need HTTP when tickSize + negRisk are provided in options.
 */
async function submitMarketOrderViaProxy(args: {
  client: any;                              // SDK ClobClient instance
  tokenID: string;
  side: "BUY" | "SELL";
  amount: number;
  price: number;
  orderType: "FOK" | "FAK";
  tickSize: string;
  negRisk: boolean;
}): Promise<any> {
  // 1. Build the SIGNED order LOCALLY via the SDK's OrderBuilder. This skips
  //    client.createMarketOrder() which makes ~5 internal HTTP calls (market
  //    info cache, builder fee, neg-risk lookup, version resolve, fee rate)
  //    that all bypass our proxy. OrderBuilder.buildMarketOrder() is pure
  //    EIP-712 signing — zero HTTP. Version 2 is hardcoded since we're on
  //    POLYMARKET_CLOB_V2 = 1. Bug-fix 2026-05-27 (#22 final).
  // Clamp price to Polymarket's valid tick range. The CLOB enforces
  // [tickSize, 1 - tickSize] (e.g. [0.01, 0.99] at the default $0.01 tick).
  // Strategies sometimes produce prices outside this — e.g. a 5m-binary at
  // ttl=4min near a strong move can have refPrice=$0.005, which the SDK
  // rejects with "invalid price (0.005)" before we even reach the broker.
  // Snap to the nearest valid tick. Bug-fix 2026-05-27 (#24).
  const tickFloor = Number(args.tickSize);
  const tickCeil = 1 - tickFloor;
  const clampedPrice = Math.min(tickCeil, Math.max(tickFloor, args.price));
  const userOrder = {
    tokenID: args.tokenID,
    amount: args.amount,
    side: args.side,
    price: clampedPrice,
  };
  let signedOrder: any;
  try {
    signedOrder = await args.client.orderBuilder.buildMarketOrder(
      userOrder,
      { tickSize: args.tickSize, negRisk: args.negRisk },
      2,  // V2 order schema
    );
  } catch (e: any) {
    const resp = e?.response?.data ?? { error: e?.message ?? "buildMarketOrder threw", status: e?.response?.status };
    return resp;
  }

  // 2. Use SDK exports to build the wire payload + L2 auth headers.
  const sdkMod: any = await import("@polymarket/clob-client-v2");
  const { orderToJsonV2, createL2Headers } = sdkMod;
  const apiKey = process.env.POLYMARKET_CLOB_API_KEY ?? "";
  const payload = orderToJsonV2(signedOrder, apiKey, args.orderType, false, false);
  const bodyJson = JSON.stringify(payload);
  const headers = await createL2Headers(
    args.client.signer ?? null,
    { key: apiKey, secret: process.env.POLYMARKET_CLOB_SECRET ?? "", passphrase: process.env.POLYMARKET_CLOB_PASSPHRASE ?? "" },
    { method: "POST", requestPath: "/order", body: bodyJson },
  );

  // 3. POST via polyFetch — guaranteed to route through Webshare proxy.
  const host = process.env.POLYMARKET_CLOB_HOST ?? "https://clob.polymarket.com";
  const resp = await polyFetch(`${host}/order`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "User-Agent": "@polymarket/clob-client",
      "Accept": "*/*",
    },
    body: bodyJson,
  });
  const text = await resp.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = { error: text }; }
  // Surface broker status in the response object so bug-#13's detector fires.
  if (resp.status >= 400 && !parsed.status) parsed.status = resp.status;
  return parsed;
}

export type ExecuteVerdict =
  | { kind: "dry-run"; reason: string; planned: { yes: PlannedLeg; no: PlannedLeg }; capUsed: { trade: number; daily: number } }
  | { kind: "executed"; orders: any[]; planned: { yes: PlannedLeg; no: PlannedLeg } }
  | { kind: "rejected"; reason: string };

type PlannedLeg = { tokenId: string; side: "BUY"; price: number; sizeUsd: number; shares: number };

function planLegs(arb: SingleMarketArb, sizeUsd: number): { yes: PlannedLeg; no: PlannedLeg } {
  // We buy YES and NO at their respective asks. We split the budget so that the
  // resulting share count is identical across legs — that's what locks in the $1 payoff.
  const sharesByBudget = sizeUsd / (arb.bestYesAsk + arb.bestNoAsk);
  const shares = Math.min(Math.floor(sharesByBudget), arb.maxExecutableShares);
  if (shares <= 0) {
    throw new Error("sizeUsd too small for any whole-share basket");
  }
  return {
    yes: { tokenId: arb.yesTokenId, side: "BUY", price: arb.bestYesAsk, sizeUsd: shares * arb.bestYesAsk, shares },
    no: { tokenId: arb.noTokenId, side: "BUY", price: arb.bestNoAsk, sizeUsd: shares * arb.bestNoAsk, shares },
  };
}

/** Decide-and-act on a single arb candidate. Always logs to evolution_log. */
export async function executeSingleMarketArb(arb: SingleMarketArb, opts: { sizeUsd?: number; agentId?: number; strategyId?: number } = {}): Promise<ExecuteVerdict> {
  const mode = readMode();
  const maxTrade = readMaxTradeUsd();
  const maxDaily = readMaxDailyUsd();
  const requestedSize = Math.min(opts.sizeUsd ?? Math.min(arb.expectedProfitUsd * 5, maxTrade), maxTrade);
  let planned;
  try {
    planned = planLegs(arb, requestedSize);
  } catch (err) {
    insertEvolutionEvent({
      agent_id: opts.agentId, strategy_id: opts.strategyId,
      event_type: "arb-rejected", summary: `Plan failed: ${(err as Error).message}`,
      payload_json: JSON.stringify({ arb, requestedSize }),
    });
    return { kind: "rejected", reason: (err as Error).message };
  }
  const totalCost = planned.yes.sizeUsd + planned.no.sizeUsd;
  if (totalCost > maxTrade) {
    insertEvolutionEvent({
      agent_id: opts.agentId, strategy_id: opts.strategyId,
      event_type: "arb-rejected", summary: `Plan exceeds MAX_TRADE_USD ($${totalCost.toFixed(2)} > $${maxTrade})`,
      payload_json: JSON.stringify({ planned, totalCost }),
    });
    return { kind: "rejected", reason: `trade cap` };
  }
  const dailySpent = dailyExecutedUsd();
  if (dailySpent + totalCost > maxDaily) {
    insertEvolutionEvent({
      agent_id: opts.agentId, strategy_id: opts.strategyId,
      event_type: "arb-rejected", summary: `Plan exceeds MAX_DAILY_USD ($${(dailySpent + totalCost).toFixed(2)} > $${maxDaily})`,
      payload_json: JSON.stringify({ planned, dailySpent, totalCost }),
    });
    return { kind: "rejected", reason: "daily cap" };
  }

  if (mode === "DRY_RUN") {
    const reason = `ALLOW_TRADE!=1 → not submitting; planned cost $${totalCost.toFixed(2)}, expected edge $${arb.expectedProfitUsd.toFixed(2)}`;
    insertEvolutionEvent({
      agent_id: opts.agentId, strategy_id: opts.strategyId,
      event_type: "arb-dry-run", summary: `DRY: ${arb.question.slice(0, 60)} — buy ${planned.yes.shares}sh`,
      payload_json: JSON.stringify({ planned, arb, cost_usd: totalCost, expected_edge_usd: arb.expectedProfitUsd }),
    });
    return { kind: "dry-run", reason, planned, capUsed: { trade: totalCost, daily: dailySpent + totalCost } };
  }

  // LIVE path — submit both legs as FAK market orders (CLOB V2 requires FAK
  // for the standard market-order path; FOK was V1 behavior).
  insertEvolutionEvent({
    agent_id: opts.agentId, strategy_id: opts.strategyId,
    event_type: "arb-submitting", summary: `Submitting: ${arb.question.slice(0, 60)} — ${planned.yes.shares}sh basket`,
    payload_json: JSON.stringify({ planned, arb, cost_usd: totalCost }),
  });

  try {
    const client = await getClobClient();
    const opt = { tickSize: "0.01", negRisk: false };
    const [yesResp, noResp] = await Promise.all([
      client.createAndPostMarketOrder({ tokenID: planned.yes.tokenId, amount: planned.yes.sizeUsd, side: "BUY", price: planned.yes.price }, opt, "FAK"),
      client.createAndPostMarketOrder({ tokenID: planned.no.tokenId, amount: planned.no.sizeUsd, side: "BUY", price: planned.no.price }, opt, "FAK"),
    ]);
    // Bug #13 fix (2026-05-26): same broker-error-defaults-to-success pattern
    // as submitSingleSideMarket. Detect 4xx/5xx + error strings explicitly.
    const isBrokerError = (r: any) =>
      (typeof r?.error === "string" && r.error.length > 0) ||
      (typeof r?.errorMsg === "string" && r.errorMsg.length > 0) ||
      (typeof r?.status === "number" && r.status >= 400);
    if (isBrokerError(yesResp) || isBrokerError(noResp)) {
      const reason = [
        isBrokerError(yesResp) ? `YES leg: ${String(yesResp?.error ?? yesResp?.errorMsg ?? `status ${yesResp?.status}`).slice(0, 100)}` : null,
        isBrokerError(noResp) ? `NO leg: ${String(noResp?.error ?? noResp?.errorMsg ?? `status ${noResp?.status}`).slice(0, 100)}` : null,
      ].filter(Boolean).join(" · ");
      insertEvolutionEvent({
        agent_id: opts.agentId, strategy_id: opts.strategyId,
        event_type: "arb-error",
        summary: `BROKER REJECTED arb: ${reason.slice(0, 100)}`,
        payload_json: JSON.stringify({ planned, yes: yesResp, no: noResp }),
      });
      return { kind: "rejected", reason };
    }
    const allOk = (yesResp?.success ?? true) && (noResp?.success ?? true);
    insertEvolutionEvent({
      agent_id: opts.agentId, strategy_id: opts.strategyId,
      event_type: allOk ? "arb-executed" : "arb-partial",
      summary: `${allOk ? "EXEC" : "PARTIAL"}: ${arb.question.slice(0, 60)}`,
      payload_json: JSON.stringify({ planned, yes: yesResp, no: noResp, cost_usd: totalCost }),
    });
    return { kind: "executed", orders: [yesResp, noResp], planned };
  } catch (err) {
    insertEvolutionEvent({
      agent_id: opts.agentId, strategy_id: opts.strategyId,
      event_type: "arb-error", summary: `Submission failure: ${(err as Error).message.slice(0, 100)}`,
      payload_json: JSON.stringify({ planned, error: (err as Error).message }),
    });
    return { kind: "rejected", reason: (err as Error).message };
  }
}

export type SingleSideVerdict =
  | { kind: "dry-run"; reason: string; planned: SingleSidePlan; capUsed: { trade: number; daily: number } }
  | { kind: "executed"; brokerOrderId?: string; raw: any; planned: SingleSidePlan }
  | { kind: "rejected"; reason: string };

export type SingleSidePlan = {
  tokenId: string;
  side: "BUY" | "SELL";
  /** USD notional for a BUY; share count for a SELL. */
  amount: number;
  /** Limit/reference price used by the CLOB to compute fill. */
  price: number;
};

/**
 * Submit a single-side market order against Polymarket CLOB. Same safety
 * pipeline as `executeSingleMarketArb`:
 *   1. ALLOW_TRADE=1 (else DRY_RUN with full audit)
 *   2. Per-trade cap MAX_TRADE_USD
 *   3. Per-day cap MAX_DAILY_USD (sum of "single-executed" events in last 24h)
 *
 * Why this exists: the arb path is a two-leg FOK_BASKET (buy YES + buy NO) for
 * sub-$1 arbitrage. Directional strategies (5-min binaries, oracle bets) need a
 * single market order — BUY YES on a positive thesis, BUY NO on a negative one,
 * or SELL YES when closing an existing long. This wraps the same CLOB client
 * with the same safety gates so we have one execution surface.
 */
export async function submitSingleSideMarket(args: {
  tokenId: string;
  side: "BUY" | "SELL";
  sizeUsd: number;          // for BUY: USD notional; for SELL: ignored, use shares
  shares?: number;          // for SELL: share count to dump
  refPrice: number;         // limit hint for CLOB
  agentId?: number;
  strategyId?: number;
  rationale?: string;
}): Promise<SingleSideVerdict> {
  const mode = readMode();
  const maxTrade = readMaxTradeUsd();
  const maxDaily = readMaxDailyUsd();
  const dollarsAtRisk = args.side === "BUY"
    ? args.sizeUsd
    : Math.max(0, (args.shares ?? 0) * args.refPrice);

  if (dollarsAtRisk <= 0) {
    return { kind: "rejected", reason: "amount resolves to $0" };
  }
  // NOTE: `evolution_log.agent_id` FKs to `agents.id` (the human-facing
  // table) not `paper_agents.id`. The single-side path is called by the
  // arena live router with paper_agent_id which would violate the FK.
  // Stash it in payload_json.paper_agent_id instead.
  const paperAgentId = args.agentId;
  // MAX_TRADE_USD caps NEW capital commitments (BUY entries). It must NOT
  // block SELL exits — when a $5 entry appreciates into a $19 position, the
  // closing SELL doesn't risk new money; refusing to sell would trap the
  // position. Bug-fix 2026-05-27 (#19). The per-capsule loss cap still
  // governs the downside; this gate only governs incremental commitments.
  if (args.side === "BUY" && dollarsAtRisk > maxTrade) {
    insertEvolutionEvent({
      strategy_id: args.strategyId,
      event_type: "single-rejected",
      summary: `Trade $${dollarsAtRisk.toFixed(2)} exceeds MAX_TRADE_USD $${maxTrade}`,
      payload_json: JSON.stringify({ args, paper_agent_id: paperAgentId }),
    });
    return { kind: "rejected", reason: "trade cap" };
  }
  const dailySpent = dailyExecutedUsd() + dailyExecutedSingleSideUsd();
  if (dailySpent + dollarsAtRisk > maxDaily) {
    insertEvolutionEvent({
      strategy_id: args.strategyId,
      event_type: "single-rejected",
      summary: `Trade exceeds MAX_DAILY_USD ($${(dailySpent + dollarsAtRisk).toFixed(2)} > $${maxDaily})`,
      payload_json: JSON.stringify({ args, dailySpent, paper_agent_id: paperAgentId }),
    });
    return { kind: "rejected", reason: "daily cap" };
  }

  const planned: SingleSidePlan = {
    tokenId: args.tokenId,
    side: args.side,
    amount: args.side === "BUY" ? args.sizeUsd : (args.shares ?? 0),
    price: args.refPrice,
  };

  if (mode === "DRY_RUN") {
    const reason = `ALLOW_TRADE!=1 → not submitting; planned $${dollarsAtRisk.toFixed(2)} ${args.side}`;
    insertEvolutionEvent({
      strategy_id: args.strategyId,
      event_type: "single-dry-run",
      summary: `DRY: ${args.side} ${args.tokenId.slice(0, 10)}… $${dollarsAtRisk.toFixed(2)} (${args.rationale ?? "no-rationale"})`,
      payload_json: JSON.stringify({ planned, cost_usd: dollarsAtRisk, paper_agent_id: paperAgentId }),
    });
    return { kind: "dry-run", reason, planned, capUsed: { trade: dollarsAtRisk, daily: dailySpent + dollarsAtRisk } };
  }

  insertEvolutionEvent({
    strategy_id: args.strategyId,
    event_type: "single-submitting",
    summary: `Submitting: ${args.side} ${args.tokenId.slice(0, 10)}… $${dollarsAtRisk.toFixed(2)}`,
    payload_json: JSON.stringify({ planned, cost_usd: dollarsAtRisk, paper_agent_id: paperAgentId }),
  });

  try {
    const client = await getClobClient();
    // Pre-flight orderbook depth check — DISABLED by default because
    // Polymarket's 5-min binaries and most other markets are filled off-book
    // by their house market-maker; the visible CLOB depth is misleadingly
    // thin (asks at $0.99 / bids at $0.01 with nothing in the middle), yet
    // market orders still fill at the true mid. Enable via env if you
    // want pre-submit depth filtering for a specific run.
    if (process.env.POLYMARKET_PREFLIGHT_DEPTH === "1") try {
      const book = await client.getOrderBook(args.tokenId);
      const matchSide = args.side === "BUY" ? "asks" : "bids";
      // Asks sorted ascending by price; bids descending. For BUY we want asks
      // priced AT or BELOW our refPrice — we'd cross those. Symmetric for SELL.
      const levels = ((book as any)?.[matchSide] ?? []) as Array<{ price: string; size: string }>;
      const willingPrice = args.side === "BUY" ? args.refPrice : args.refPrice;
      let matchableShares = 0;
      for (const lv of levels) {
        const p = Number(lv.price);
        const s = Number(lv.size);
        if (!Number.isFinite(p) || !Number.isFinite(s)) continue;
        // For BUY: we'll cross asks at price <= refPrice + small slippage tolerance.
        // For SELL: we'll cross bids at price >= refPrice - tolerance.
        const tolerance = 0.05;  // 5 cents of slippage
        const crosses = args.side === "BUY" ? p <= willingPrice + tolerance : p >= willingPrice - tolerance;
        if (crosses) matchableShares += s;
      }
      // For BUY we need matchableShares * avgPrice >= our dollarsAtRisk.
      // Cheap estimate: matchableNotional ≈ matchableShares × refPrice. If
      // that doesn't cover our intended spend, we'll get a partial/no-fill.
      const matchableNotional = matchableShares * args.refPrice;
      if (matchableNotional < dollarsAtRisk * 0.9) {  // require 90% coverage
        insertEvolutionEvent({
          strategy_id: args.strategyId,
          event_type: "single-preflight-skip",
          summary: `Preflight skip: ${args.side} ${args.tokenId.slice(0, 10)}… — only $${matchableNotional.toFixed(2)} matchable @ ~$${args.refPrice.toFixed(3)} (need $${dollarsAtRisk.toFixed(2)})`,
          payload_json: JSON.stringify({ planned, matchableShares, matchableNotional, levels_inspected: levels.length, paper_agent_id: paperAgentId }),
        });
        return { kind: "rejected", reason: `insufficient orderbook depth — ${matchableNotional.toFixed(2)} matchable, need ${dollarsAtRisk.toFixed(2)}` };
      }
    } catch (preflightErr) {
      // Orderbook fetch errors should NOT block submission — log and continue.
      // The submit path will surface any real broker rejection downstream.
      insertEvolutionEvent({
        strategy_id: args.strategyId,
        event_type: "single-preflight-error",
        summary: `Preflight check failed (continuing to submit): ${(preflightErr as Error).message?.slice(0, 80)}`,
        payload_json: JSON.stringify({ args, paper_agent_id: paperAgentId, err: (preflightErr as Error).message }),
      });
    }

    // 2026-05-27: bypass SDK's HTTP layer (which leaks past our proxy patches
    // via nested ESM/CJS axios). Build the signed order locally, then POST via
    // polyFetch. See submitMarketOrderViaProxy doc.
    const resp = await submitMarketOrderViaProxy({
      client,
      tokenID: planned.tokenId,
      amount: planned.amount,
      side: planned.side,
      price: planned.price,
      orderType: "FAK",
      tickSize: "0.01",
      negRisk: false,
    });
    const orderId: string | undefined = resp?.orderID ?? resp?.order_id ?? resp?.id;
    // Distinguish three cases:
    //   1. Broker error response (has `error` + HTTP status >= 400 OR a `errorMsg`/`error` string)
    //      → log as single-error, return rejected. The original code used
    //        `resp?.success ?? true` which DEFAULTED to true when the response
    //        was an error object with no `success` field — producing false-
    //        positive "executed" rows in evolution_log (bug #13, 2026-05-26).
    //   2. Broker success=false (legitimate partial fill response) → single-partial.
    //   3. Broker success=true OR no success field but no error → single-executed.
    const brokerError =
      (typeof resp?.error === "string" && resp.error.length > 0) ||
      (typeof resp?.errorMsg === "string" && resp.errorMsg.length > 0) ||
      (typeof resp?.status === "number" && resp.status >= 400);
    if (brokerError) {
      const reason = String(resp?.error ?? resp?.errorMsg ?? `broker status ${resp?.status}`).slice(0, 200);
      insertEvolutionEvent({
        strategy_id: args.strategyId,
        event_type: "single-error",
        summary: `BROKER REJECTED ${args.side} ${args.tokenId.slice(0, 10)}… status=${resp?.status ?? "?"}: ${reason.slice(0, 60)}`,
        payload_json: JSON.stringify({ planned, resp, paper_agent_id: paperAgentId }),
      });
      return { kind: "rejected", reason };
    }
    const ok = resp?.success ?? true;
    insertEvolutionEvent({
      strategy_id: args.strategyId,
      event_type: ok ? "single-executed" : "single-partial",
      summary: `${ok ? "EXEC" : "PARTIAL"} ${args.side} ${args.tokenId.slice(0, 10)}… $${dollarsAtRisk.toFixed(2)}`,
      payload_json: JSON.stringify({ planned, resp, cost_usd: dollarsAtRisk, paper_agent_id: paperAgentId }),
    });
    return { kind: "executed", brokerOrderId: orderId, raw: resp, planned };
  } catch (err) {
    insertEvolutionEvent({
      strategy_id: args.strategyId,
      event_type: "single-error",
      summary: `Submission failure: ${(err as Error).message.slice(0, 100)}`,
      payload_json: JSON.stringify({ planned, error: (err as Error).message }),
    });
    return { kind: "rejected", reason: (err as Error).message };
  }
}

/** Sum executed single-side USD spend in the last 24h (separate from arb spend).
 *  Includes 'single-partial' because partial fills commit real cash even
 *  when the broker reports success=false on the rest. Bug-fix 2026-05-26 (bug #11). */
function dailyExecutedSingleSideUsd(): number {
  const row = db().prepare(
    `SELECT COALESCE(SUM(json_extract(payload_json, '$.cost_usd')), 0) AS spend
     FROM evolution_log
     WHERE event_type IN ('single-executed', 'single-partial')
       AND created_at > datetime('now', '-1 day')`,
  ).get() as { spend: number };
  return row.spend ?? 0;
}

/** Emergency: cancel every open order for the signer. Always allowed (defensive). */
export async function killSwitch(): Promise<{ ok: boolean; result?: any; error?: string }> {
  try {
    const client = await getClobClient();
    const result = await client.cancelAll();
    insertEvolutionEvent({ event_type: "kill-switch", summary: "cancelAll() invoked", payload_json: JSON.stringify({ result }) });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export const safety = {
  mode: readMode,
  maxTrade: readMaxTradeUsd,
  maxDaily: readMaxDailyUsd,
  dailyExecutedUsd,
};
