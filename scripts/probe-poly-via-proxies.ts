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

const proxies = [
  { country: "US", host: "38.154.203.95",  port: 5863 },
  { country: "GB", host: "198.105.121.200", port: 6462 },
  { country: "ES", host: "64.137.96.74",   port: 6641 },
  { country: "US", host: "209.127.138.10", port: 5784 },
  { country: "US", host: "38.154.185.97",  port: 6370 },
  { country: "PL", host: "84.247.60.125",  port: 6095 },
  { country: "US", host: "142.111.67.146", port: 5611 },
  { country: "JP", host: "191.96.254.138", port: 6185 },
  { country: "DE", host: "31.58.9.4",      port: 6077 },
  { country: "DE", host: "64.137.10.153",  port: 5803 },
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
