/** Parameterized $1 FAK BUY of a SPECIFIC token, for the crypto-updown pool follower (TradingBot2/research).
 * Usage: npx tsx scripts/_followbuy.ts <tokenId> <usd> <refPrice> --confirm
 * LIVE only when ALLOW_TRADE=1 AND --confirm; else shadow. Hard-capped at $1 here regardless of the caller —
 * this is the LAST gate before real money, so it re-checks everything the daemon already checked (defense in depth). */
import "./_env.ts";
import { ensureProxyRoutingReady } from "../src/lib/polymarket/proxy-routing.ts";
import { submitSingleSideMarket } from "../src/lib/polymarket/execute.ts";

const CAP_USD = 1.0;

(async () => {
  const tokenId = process.argv[2];
  const usd = Math.min(CAP_USD, Number(process.argv[3] || "1"));
  const ref = Math.min(0.97, Number(process.argv[4] || "0.5"));
  const confirm = process.argv.includes("--confirm");
  if (!tokenId || !/^\d{20,}$/.test(tokenId)) {
    console.log(JSON.stringify({ kind: "blocked", reason: `bad tokenId: ${tokenId}` }));
    process.exit(2);
  }
  if (!Number.isFinite(usd) || usd <= 0 || !Number.isFinite(ref) || ref <= 0 || ref >= 1) {
    console.log(JSON.stringify({ kind: "blocked", reason: `bad usd/ref: ${usd}/${ref}` }));
    process.exit(2);
  }
  const armed = process.env.ALLOW_TRADE === "1" && confirm;
  if (!armed) {
    // shadow: prove the path without sending. submitSingleSideMarket itself is DRY_RUN unless ALLOW_TRADE=1.
    console.log(JSON.stringify({ kind: "shadow", tokenId, usd, ref, note: "not armed (need ALLOW_TRADE=1 && --confirm)" }));
    process.exit(0);
  }
  await ensureProxyRoutingReady();
  const t0 = Date.now();
  const v: any = await submitSingleSideMarket({
    tokenId, side: "BUY", sizeUsd: usd, refPrice: ref, rationale: "pool_follow $1 cap",
  });
  const lag = Date.now() - t0;
  const raw = v?.raw || {};
  const making = +(raw.makingAmount ?? raw.making_amount ?? NaN);
  const taking = +(raw.takingAmount ?? raw.taking_amount ?? NaN);
  const fill = making && taking ? making / taking : +(raw.price ?? NaN);
  console.log(JSON.stringify({
    kind: v?.kind === "executed" ? "executed" : (v?.kind || "unknown"),
    orderId: v?.brokerOrderId ?? null, fill: Number.isFinite(fill) ? +fill.toFixed(4) : null,
    shares: Number.isFinite(taking) ? +taking.toFixed(2) : null, lag_ms: lag,
    tx: raw.transactionsHashes?.[0] ?? null, reason: v?.reason ?? null,
  }));
  process.exit(0);
})();
