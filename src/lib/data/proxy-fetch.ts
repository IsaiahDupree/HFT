/**
 * proxy-fetch — per-host proxy routing for DATA venues (Binance et al.), the generic sibling of
 * src/lib/polymarket/proxy-routing.ts. Binance's main API (api.binance.com / fapi.binance.com)
 * answers HTTP 451 from US IPs; the same Webshare residential proxy we use for Polymarket's CLOB
 * gets us the FULL Binance API — funding rates, depth, full klines — not just the no-funding
 * public mirror (data-api.binance.vision). Only allow-listed hosts route through the proxy;
 * everything else stays on the local network.
 *
 * Config (reuses the existing Polymarket proxy creds — set either):
 *   DATA_PROXY_URL=http://user:pass@host:port   (preferred for data venues)
 *   POLYMARKET_PROXY_URL=...                     (fallback — the one already in .env.local)
 *   DATA_PROXY_HOSTS=api.binance.com,fapi.binance.com,...   (optional override of the allow-list)
 *
 * Node-only (uses createRequire for the CJS-only https-proxy-agent, per the Node-22/tsx note in
 * proxy-routing.ts). Server-only by design.
 */
import axios from "axios";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const { HttpsProxyAgent } = require_("https-proxy-agent") as { HttpsProxyAgent: any };

/** Geo-blocked data hosts that should route through the proxy by default. */
export const DEFAULT_PROXIED_HOSTS = [
  "api.binance.com", "api1.binance.com", "api2.binance.com", "api3.binance.com", "api4.binance.com",
  "fapi.binance.com", "dapi.binance.com", "eapi.binance.com",
];

function proxyUrl(): string | undefined {
  return process.env.DATA_PROXY_URL ?? process.env.POLYMARKET_PROXY_URL;
}

/** The host allow-list (env override DATA_PROXY_HOSTS, else the Binance default). */
export function proxiedHosts(): string[] {
  const env = process.env.DATA_PROXY_HOSTS;
  if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);
  return DEFAULT_PROXIED_HOSTS;
}

function hostMatches(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname; } catch { return false; }
  return proxiedHosts().some((h) => host === h || host.endsWith(`.${h}`));
}

let _agent: any | null | undefined = undefined;
function getAgent(): any | null {
  if (_agent !== undefined) return _agent;
  const url = proxyUrl();
  if (!url) { _agent = null; return null; }
  try { _agent = new HttpsProxyAgent(url); return _agent; }
  catch (e) { console.warn(`[data-proxy] bad proxy url: ${(e as Error).message}`); _agent = null; return null; }
}

/** Test-only: re-read the env on the next call. */
export function _resetDataProxyAgentForTests(): void { _agent = undefined; }

/** Is this URL going to be proxied right now? (proxy configured AND host allow-listed). */
export function willProxy(url: string): boolean {
  return !!proxyUrl() && hostMatches(url);
}

function headerObj(init?: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {};
  if (init?.headers) {
    if (init.headers instanceof Headers) init.headers.forEach((v, k) => { headers[k] = v; });
    else if (Array.isArray(init.headers)) for (const [k, v] of init.headers) headers[k] = v;
    else Object.assign(headers, init.headers);
  }
  return headers;
}

/**
 * fetch() that routes allow-listed data-venue hosts through the proxy and leaves everything else
 * direct. Same axios→Response synthesis as polyFetch so callers use .json()/.text()/.status as
 * usual. Non-proxied URLs (or no proxy configured) fall straight through to native fetch.
 */
export async function proxiedFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input.toString();
  if (!willProxy(url)) return fetch(input, init);
  const agent = getAgent();
  if (!agent) return fetch(input, init);
  const axResp = await axios.request({
    url, method: (init?.method ?? "GET").toUpperCase(),
    headers: headerObj(init), data: init?.body as any,
    httpsAgent: agent, httpAgent: agent, proxy: false,
    validateStatus: () => true, responseType: "text", timeout: 30_000,
  });
  return new Response(typeof axResp.data === "string" ? axResp.data : JSON.stringify(axResp.data), {
    status: axResp.status, statusText: axResp.statusText,
    headers: Object.fromEntries(Object.entries(axResp.headers ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)])),
  });
}

/** Operator surface: is the data proxy on, which host is it, and what's routed. */
export function dataProxyStatus(): { enabled: boolean; host?: string; hostsRouted: string[] } {
  const url = proxyUrl();
  if (!url) return { enabled: false, hostsRouted: proxiedHosts() };
  try { return { enabled: true, host: new URL(url).host, hostsRouted: proxiedHosts() }; }
  catch { return { enabled: false, hostsRouted: proxiedHosts() }; }
}
