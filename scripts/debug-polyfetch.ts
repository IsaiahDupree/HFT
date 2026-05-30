import "./_env";
import { polyFetch, proxyStatus, installProxyRoutingOnce } from "../src/lib/polymarket/proxy-routing";

(async () => {
  installProxyRoutingOnce();
  console.log("proxyStatus:", JSON.stringify(proxyStatus()));
  console.log("HTTPS_PROXY env:", process.env.HTTPS_PROXY?.slice(0, 40));
  console.log("POLYMARKET_PROXY_URL env:", process.env.POLYMARKET_PROXY_URL?.slice(0, 40));
  try {
    const r = await polyFetch("https://clob.polymarket.com/markets?limit=1");
    console.log("polyFetch CLOB status:", r.status, "cf-ray:", r.headers.get("cf-ray"));
    const t = await r.text();
    console.log("body preview:", t.slice(0, 100));
  } catch (e: any) {
    console.log("polyFetch err:", e.message);
  }
})();
