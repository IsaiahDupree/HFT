/**
 * Single-market arb runner with **two trigger sources**:
 *
 *  1. CLOB market WebSocket — book updates for subscribed tokens.
 *  2. On-chain OrderFilled events — Polygon WS listener (CTF V2 + Neg Risk).
 *
 * Either signal can trigger re-evaluation. The on-chain channel is strictly
 * lower-latency for new-fill events (no CLOB ws round-trip), so a token-of-
 * interest fill arrives there first → we refetch the book + re-run arb
 * detection immediately. Diagnostic per detection: `triggeredBy` = "ws" or
 * "onchain", plus `wsLagMs` when on-chain saw a fill we hadn't seen yet on the
 * CLOB feed.
 *
 *   npm run arb:runner                              # dry-run, both feeds
 *   ALLOW_TRADE=1 MAX_TRADE_USD=10 npm run arb:runner   # LIVE — be sure
 */
import "./_env.ts";
import { WebSocket } from "ws";
import { poly } from "../src/lib/polymarket/client.ts";
import { findSingleMarketArbs, type MarketPair, type OrderBookSummary } from "../src/lib/polymarket/arb.ts";
import { executeSingleMarketArb, safety } from "../src/lib/polymarket/execute.ts";
import { insertEvolutionEvent } from "../src/lib/db/queries.ts";
import { subscribeOrderFilled, impliedPriceFromFill } from "../src/lib/polymarket/onchain.ts";

const N_MARKETS = Number(process.env.ARB_MARKETS ?? "12");
const MAX_ATTEMPTS = Number(process.env.ARB_MAX_ATTEMPTS ?? "12");
const FEE_BPS = Number(process.env.ARB_FEE_BPS ?? "50");
const MIN_EDGE_USD = Number(process.env.ARB_MIN_EDGE_USD ?? "0.10");

(async () => {
  console.log(`[arb-runner] mode=${safety.mode()}  cap/trade=$${safety.maxTrade()}  cap/day=$${safety.maxDaily()}  attempts<=${MAX_ATTEMPTS}`);
  const sampling = await poly.samplingMarkets(N_MARKETS);
  const pairs: MarketPair[] = sampling.data
    .map((m: any) => {
      const yes = m.tokens?.find((t: any) => t.outcome === "Yes");
      const no = m.tokens?.find((t: any) => t.outcome === "No");
      if (!yes?.token_id || !no?.token_id || !m.condition_id) return null;
      return {
        conditionId: m.condition_id,
        question: m.question ?? "",
        yesTokenId: yes.token_id,
        noTokenId: no.token_id,
      };
    })
    .filter(Boolean) as MarketPair[];

  console.log(`[arb-runner] subscribing to ${pairs.length} markets (${pairs.length * 2} tokens) on BOTH CLOB ws + Polygon on-chain`);
  const books = new Map<string, OrderBookSummary>(); // token_id → latest book
  const wsLastSeenMs = new Map<string, number>();     // token_id → ms of last book update via ws
  const tokenToPair = new Map<string, MarketPair>();
  for (const p of pairs) { tokenToPair.set(p.yesTokenId, p); tokenToPair.set(p.noTokenId, p); }
  const allTokens = [...tokenToPair.keys()];

  let attempts = 0;
  let lastEvalTs = 0;
  let stopped = false;

  const tryEvaluate = async (triggeredBy: "ws" | "onchain", focusTokenId?: string) => {
    if (stopped || attempts >= MAX_ATTEMPTS) return;
    const now = Date.now();
    if (triggeredBy === "ws" && now - lastEvalTs < 750) return; // throttle bursty ws
    lastEvalTs = now;

    // For on-chain triggers, refresh the relevant pair's books synchronously
    // — they're more authoritative than whatever the CLOB ws has cached.
    if (triggeredBy === "onchain" && focusTokenId && tokenToPair.has(focusTokenId)) {
      const p = tokenToPair.get(focusTokenId)!;
      try {
        const [y, no] = await Promise.all([
          poly.orderbook(p.yesTokenId).catch(() => null),
          poly.orderbook(p.noTokenId).catch(() => null),
        ]);
        if (y) books.set(p.yesTokenId, y as OrderBookSummary);
        if (no) books.set(p.noTokenId, no as OrderBookSummary);
      } catch {}
    }

    const candidates = pairs.map((p) => ({ pair: p, yesBook: books.get(p.yesTokenId) ?? null, noBook: books.get(p.noTokenId) ?? null }));
    const arbs = findSingleMarketArbs(candidates, { feeBps: FEE_BPS, depthCapFraction: 0.5, minProfitUsd: MIN_EDGE_USD });
    if (arbs.length === 0) return;

    for (const arb of arbs) {
      if (attempts >= MAX_ATTEMPTS) { stopped = true; break; }
      attempts++;
      const wsLastYes = wsLastSeenMs.get(arb.yesTokenId) ?? 0;
      const wsLastNo = wsLastSeenMs.get(arb.noTokenId) ?? 0;
      const wsLagMs = triggeredBy === "onchain" ? now - Math.max(wsLastYes, wsLastNo) : null;
      insertEvolutionEvent({
        event_type: "arb-detection",
        summary: `Detected (${triggeredBy}): ${arb.question.slice(0, 50)} edge=$${arb.expectedProfitUsd.toFixed(2)}${wsLagMs ? ` wsLag=${wsLagMs}ms` : ""}`,
        payload_json: JSON.stringify({ ...arb, triggeredBy, wsLagMs }),
      });
      console.log(`[arb-runner] #${attempts} (${triggeredBy}) ${arb.question.slice(0, 50).padEnd(50)}  edge=$${arb.expectedProfitUsd.toFixed(2)}${wsLagMs ? `  wsLag=${wsLagMs}ms` : ""}`);
      const verdict = await executeSingleMarketArb(arb, { sizeUsd: Math.min(arb.expectedProfitUsd * 5, safety.maxTrade()) });
      console.log(`[arb-runner] #${attempts} verdict: ${verdict.kind}${verdict.kind === "rejected" ? ` (${verdict.reason})` : ""}`);
    }

    if (attempts >= MAX_ATTEMPTS) {
      console.log(`[arb-runner] reached MAX_ATTEMPTS=${MAX_ATTEMPTS}, shutting down`);
      stopWs();
      stopOnchain();
      process.exit(0);
    }
  };

  // --- CLOB market WebSocket ---
  const ws = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");
  let wsHeartbeat: ReturnType<typeof setInterval> | null = null;
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "MARKET", assets_ids: allTokens, custom_feature_enabled: true }));
    wsHeartbeat = setInterval(() => { try { ws.send("PING"); } catch {} }, 10_000);
    console.log(`[arb-runner] CLOB ws open at ${new Date().toISOString()}`);
  });
  ws.on("error", (err) => console.error("[arb-runner] ws error:", err.message));
  ws.on("close", () => { console.warn("[arb-runner] CLOB ws closed"); });
  ws.on("message", (raw) => {
    if (stopped) return;
    const text = raw.toString();
    if (text === "PONG") return;
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { return; }
    const msgs = Array.isArray(parsed) ? parsed : [parsed];
    for (const m of msgs) {
      const id = m.asset_id ?? m.market;
      if (!id) continue;
      if (m.bids || m.asks) {
        books.set(id, { market: m.market ?? "", asset_id: id, bids: m.bids ?? books.get(id)?.bids ?? [], asks: m.asks ?? books.get(id)?.asks ?? [] });
        wsLastSeenMs.set(id, Date.now());
      }
    }
    void tryEvaluate("ws");
  });
  const stopWs = () => { if (wsHeartbeat) clearInterval(wsHeartbeat); try { ws.close(); } catch {} };

  // --- Polygon on-chain OrderFilled listener ---
  const stopOnchain = subscribeOrderFilled({
    onStatus: (s) => { if (s === "open") console.log(`[arb-runner] on-chain feed open`); },
    onFill: (fill) => {
      if (stopped) return;
      const px = impliedPriceFromFill(fill);
      const tokenId = px?.tokenId ?? fill.tokenId;
      if (!tokenToPair.has(tokenId)) return; // ignore fills on tokens we don't watch
      // Fire-and-forget — tryEvaluate handles its own throttle (ws path) and
      // the on-chain path bypasses throttle for relevant tokens.
      void tryEvaluate("onchain", tokenId);
    },
  });

  setTimeout(() => {
    console.log(`[arb-runner] timed out after 5 min, closing — attempts=${attempts}`);
    stopped = true;
    stopWs();
    stopOnchain();
    process.exit(0);
  }, 5 * 60_000);
})().catch((err) => { console.error(err); process.exit(1); });
