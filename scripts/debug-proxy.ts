import "./_env";
import axios from "axios";
import { installProxyRoutingOnce, proxyStatus } from "../src/lib/polymarket/proxy-routing";

(async () => {
  console.log("proxyStatus:", proxyStatus());
  installProxyRoutingOnce();

  const handlers = (axios.interceptors.request as any).handlers ?? [];
  console.log("axios request interceptor count:", handlers.length);
  if (handlers[0]) {
    console.log("first interceptor fn (first 200 chars):");
    console.log("  " + handlers[0].fulfilled?.toString().slice(0, 200));
  }

  // Test 1: direct axios to non-Polymarket (should NOT be proxied)
  try {
    const r = await axios.get("https://api.country.is", { timeout: 8_000 });
    console.log("country.is direct:", r.data);
  } catch (e: any) {
    console.log("country.is err:", e.message);
  }

  // Test 2: axios to Polymarket (SHOULD be proxied to GB)
  try {
    const r = await axios.get("https://clob.polymarket.com/markets?limit=1", { timeout: 15_000 });
    console.log("CLOB status:", r.status, "cf-ray:", r.headers["cf-ray"]);
  } catch (e: any) {
    console.log("CLOB err:", e.message);
    console.log("  response:", JSON.stringify(e.response?.data || {}).slice(0, 200));
  }
})();
