/**
 * Smoke test for per-host proxy routing.
 *
 *   1. polyFetch on a Polymarket URL → should route through proxy (egress IP
 *      shows non-US), Coinbase URL → should stay on local network.
 *   2. axios direct call to Polymarket → after installProxyRoutingOnce(), the
 *      interceptor attaches the proxy agent.
 *
 * Run: `npx tsx scripts/test-poly-proxy.ts`
 */
import "./_env";
import { installProxyRoutingOnce, polyFetch, proxyStatus } from "../src/lib/polymarket/proxy-routing";
import axios from "axios";

(async () => {
  console.log("=== proxy config ===");
  console.log(proxyStatus());
  installProxyRoutingOnce();

  console.log("\n=== polyFetch on country.is via Polymarket URL... no wait, country.is isn't Polymarket ===");
  console.log("--- direct fetch to country.is (should NOT be proxied) ---");
  const r1 = await fetch("https://api.country.is");
  console.log("  ", await r1.text());

  console.log("\n--- polyFetch to Polymarket CLOB markets (SHOULD be proxied) ---");
  const r2 = await polyFetch("https://clob.polymarket.com/markets?limit=1");
  console.log("  status:", r2.status, "cf-ray:", r2.headers.get("cf-ray"));

  console.log("\n--- axios direct GET to Polymarket CLOB (SDK pattern; should be proxied via interceptor) ---");
  try {
    const r3 = await axios.get("https://clob.polymarket.com/markets?limit=1", { timeout: 10_000 });
    console.log("  status:", r3.status, "cf-ray:", r3.headers["cf-ray"]);
  } catch (e: any) {
    console.log("  error:", e.message);
  }

  console.log("\n--- axios direct GET to Coinbase (should NOT be proxied) ---");
  try {
    const r4 = await axios.get("https://api.country.is", { timeout: 10_000 });
    console.log("  body:", r4.data);
  } catch (e: any) {
    console.log("  error:", e.message);
  }
})();
