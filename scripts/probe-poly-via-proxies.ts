/**
 * For each Webshare proxy, probe POST /order with a deliberately-bad payload.
 * If we get a 4xx OTHER than 403, that proxy IP is accepted for order writes
 * (and the rejection comes from validation, not geo). 403 = geo-blocked.
 *
 * Reads proxy credentials from POLYMARKET_PROXY_URL in .env.local — does NOT
 * commit secrets to git.
 */
import "./_env";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const { HttpsProxyAgent } = require_("https-proxy-agent");

// Updated 2026-06-11: rotated from expired plan 13575885 batch (64.137.96.74:6641 retired)
const proxies = [
  { country: "US", host: "198.37.116.209", port: 6168 }, // active — plan 13575885 new batch
  { country: "US", host: "198.37.118.175", port: 5634 },
  { country: "US", host: "154.6.127.194",  port: 5665 },
  { country: "US", host: "38.154.224.6",   port: 6547 },
  { country: "US", host: "64.137.42.225",  port: 5270 },
  { country: "GB", host: "82.26.238.223",  port: 6530 },
  { country: "GB", host: "92.112.136.228", port: 6172 },
  { country: "US", host: "104.252.107.112",port: 6032 },
  { country: "US", host: "45.39.13.6",     port: 5443 },
  { country: "US", host: "104.143.245.223",port: 6463 },
];
// Reads proxy auth from POLYMARKET_PROXY_URL (which is gitignored in
// .env.local). Run via `npx tsx scripts/probe-poly-via-proxies.ts`.
const proxyUrl = new URL(process.env.POLYMARKET_PROXY_URL ?? "");
const USER = decodeURIComponent(proxyUrl.username);
const PASS = decodeURIComponent(proxyUrl.password);
if (!USER || !PASS) {
  console.error("POLYMARKET_PROXY_URL missing user:pass — set in .env.local first.");
  process.exit(1);
}

const https = require_("node:https");

function postOrderTest(host: string, port: number): Promise<{ status: number; body: string; cfRay: string | undefined }> {
  return new Promise((resolve) => {
    const agent = new HttpsProxyAgent(`http://${USER}:${PASS}@${host}:${port}`);
    const body = JSON.stringify({ deliberately: "bad" });
    const req = https.request({
      method: "POST",
      host: "clob.polymarket.com",
      port: 443,
      path: "/order",
      headers: { "Content-Type": "application/json", "Content-Length": body.length },
      agent,
      timeout: 12_000,
    }, (res: any) => {
      let data = "";
      res.on("data", (c: any) => data += c);
      res.on("end", () => resolve({ status: res.statusCode, body: data.slice(0, 200), cfRay: res.headers["cf-ray"] }));
    });
    req.on("error", (e: any) => resolve({ status: -1, body: e.message, cfRay: undefined }));
    req.on("timeout", () => { req.destroy(); resolve({ status: -2, body: "timeout", cfRay: undefined }); });
    req.end(body);
  });
}

(async () => {
  console.log("Probing POST /order via each Webshare proxy...\n");
  for (const p of proxies) {
    const r = await postOrderTest(p.host, p.port);
    const verdict = r.status === 403 ? "❌ GEO-BLOCKED"
      : r.status >= 200 && r.status < 600 ? "✅ ACCEPTED (validation rejection)"
      : "⚠ network err";
    console.log(`${p.country.padEnd(2)} ${p.host.padEnd(18)}:${String(p.port).padEnd(5)}  ${String(r.status).padStart(4)}  cf-ray=${(r.cfRay ?? "—").slice(0, 22)}  ${verdict}`);
    if (r.status !== 403 && r.status > 0) console.log(`    body: ${r.body.slice(0, 100)}`);
  }
})();
