/**
 * Direct probe: try POST /order through the Webshare proxy with a deliberately
 * malformed payload (will be rejected at validation level, NOT geo). If we
 * get a 400-something OTHER than 403, Polymarket accepts the proxy for
 * orders. If 403, the proxy IP is blacklisted for writes (not reads).
 */
import "./_env";
import { polyFetch } from "../src/lib/polymarket/proxy-routing";

(async () => {
  console.log("Testing POST /order via polyFetch with deliberate-bad-payload...");
  const r = await polyFetch("https://clob.polymarket.com/order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ this_is_obviously: "wrong" }),
  });
  console.log("status:", r.status);
  console.log("cf-ray:", r.headers.get("cf-ray"));
  console.log("body:", (await r.text()).slice(0, 300));
})();
