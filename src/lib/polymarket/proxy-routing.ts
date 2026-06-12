/**
 * Per-host HTTP proxy routing — pipes ONLY Polymarket-hostname calls through
 * a configured proxy, leaving every other outbound call on the local network.
 *
 * Build note: this module is intentionally Node-only and uses CommonJS-style
 * resolution for `https-proxy-agent` because that package's ESM exports are
 * broken under tsx/Node 22. It is NOT safe to import from a client component.
 * Server-only by design.
 *
 * Why: Polymarket's CLOB is geo-blocked from US IPs. Toggling a desktop VPN
 * routes ALL traffic (Coinbase, Anthropic, npm, etc.) which is messy and
 * adds latency. Per-host proxy keeps the system isolated and predictable.
 *
 * Wiring:
 *   1. Set `POLYMARKET_PROXY_URL=http://user:pass@host:port` in `.env.local`
 *   2. Import this module BEFORE any Polymarket SDK use. It patches axios's
 *      default instance — because both clob-client and clob-client-v2 do
 *      `import axios from "axios"` (singleton), our interceptor applies to
 *      their SDK requests automatically.
 *   3. Use the exported `polyFetch()` for direct fetch calls to Polymarket
 *      endpoints (Gamma, Data API, etc.) — it injects the matching agent.
 *
 * Hostnames routed through the proxy (substring match):
 *   - clob.polymarket.com
 *   - gamma-api.polymarket.com
 *   - data-api.polymarket.com
 *   - relayer-v2.polymarket.com
 *
 * Hosts NOT routed:
 *   - api.anthropic.com / platform.claude.com (OAuth)
 *   - api.coinbase.com / advanced-trade-ws.coinbase.com
 *   - api.polygonscan.com, polygon-bor-rpc.publicnode.com (read-only RPC)
 *   - Everything else
 *
 * Test: `npx tsx scripts/test-poly-proxy.ts`
 */
import axios from "axios";
// https-proxy-agent is published as CJS only — named ESM imports break under
// tsx/Node 22 ESM resolution. Use createRequire so the bare-name import works
// regardless of how this module is loaded.
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const { HttpsProxyAgent } = require_("https-proxy-agent") as { HttpsProxyAgent: any };

const POLY_HOSTS = [
  "clob.polymarket.com",
  "gamma-api.polymarket.com",
  "data-api.polymarket.com",
  "relayer-v2.polymarket.com",
];

function urlMatchesPolymarket(url: string | undefined): boolean {
  if (!url) return false;
  for (const host of POLY_HOSTS) {
    if (url.includes(host)) return true;
  }
  return false;
}

/** Build the agent lazily so the env can be set before the first use. */
let _agent: any | null | undefined = undefined;
function getAgent(): any | null {
  if (_agent !== undefined) return _agent;
  const url = process.env.POLYMARKET_PROXY_URL;
  if (!url) { _agent = null; return null; }
  try {
    _agent = new HttpsProxyAgent(url);
    return _agent;
  } catch (e) {
    console.warn(`[poly-proxy] failed to construct proxy agent from POLYMARKET_PROXY_URL: ${(e as Error).message}`);
    _agent = null;
    return null;
  }
}

/** Re-read env (test-only — production reads once at first call). */
export function _resetProxyAgentForTests(): void { _agent = undefined; }

let _patched = false;

/**
 * Patch Node's built-in https module so EVERY outbound request to a
 * Polymarket hostname uses our proxy agent — regardless of which HTTP
 * library (axios CJS, axios ESM, undici fetch, raw https) made the call.
 *
 * This is more aggressive than the axios interceptor approach but it's the
 * only reliable way to catch the SDK's nested-ESM-axios calls when the
 * package has dual CJS/ESM builds with separate module instances. The
 * axios interceptor stays in place as a belt-and-suspenders second layer.
 *
 * Bug-fix 2026-05-27 (#22 final).
 */
function patchHttpsGlobal(agent: any): void {
  const https = require_("node:https") as typeof import("node:https");
  const origRequest = https.request;
  https.request = function patchedRequest(this: any, ...args: any[]) {
    // First arg can be URL string or RequestOptions; sniff for Polymarket.
    let hostname = "";
    if (typeof args[0] === "string") {
      try { hostname = new URL(args[0]).hostname; } catch {}
    } else if (args[0] && typeof args[0] === "object") {
      hostname = String(args[0].hostname ?? args[0].host ?? "");
      if (args[0].href) {
        try { hostname = new URL(args[0].href).hostname; } catch {}
      }
    }
    const isPoly = POLY_HOSTS.some((h) => hostname.includes(h.replace(/:.*$/, "")));
    if (isPoly) {
      // Inject the proxy agent into the options object.
      if (typeof args[0] === "string" && typeof args[1] === "object") {
        args[1] = { ...args[1], agent };
      } else if (args[0] && typeof args[0] === "object") {
        args[0] = { ...args[0], agent };
      }
    }
    return origRequest.apply(this, args as any);
  } as any;
}

/** Build the interceptor function for any axios instance. Captured `agent` via closure. */
function makeInterceptor(agent: any) {
  return (config: any) => {
    const target = config.url ?? "";
    const base = config.baseURL ?? "";
    if (urlMatchesPolymarket(target) || urlMatchesPolymarket(base)) {
      config.httpsAgent = agent;
      config.httpAgent = agent;
      // Disable axios's env-var-based proxy discovery; we own the routing.
      config.proxy = false;
    }
    return config;
  };
}

/**
 * Install an axios interceptor that attaches the proxy agent to any request
 * targeting a Polymarket hostname. Idempotent — calling twice is a no-op.
 *
 * IMPORTANT: This patches BOTH the top-level axios singleton AND
 * @polymarket/clob-client-v2's nested axios. npm/pnpm install the SDK with
 * its own nested node_modules/axios, which means `import axios from "axios"`
 * inside the SDK resolves to a DIFFERENT singleton than our top-level import.
 * Without patching both, the interceptor would only fire for our own code,
 * never for SDK-initiated requests — which is exactly the bug that produced
 * 403 geoblock errors from arena ticks despite the proxy working in
 * isolation. Bug-fix 2026-05-27.
 */
export function installProxyRoutingOnce(): void {
  if (_patched) return;
  _patched = true;
  const agent = getAgent();
  if (!agent) return;  // no proxy configured — keep direct routing

  const interceptor = makeInterceptor(agent);
  axios.interceptors.request.use(interceptor);

  // Bottom-of-stack defense — patch Node's https.request so any library
  // (including SDK nested ESM axios) gets the proxy injected for Polymarket
  // hostnames. This catches calls the axios interceptor misses because of
  // CJS/ESM module-instance splits.
  try { patchHttpsGlobal(agent); } catch (e) {
    console.warn(`[poly-proxy] could not patch https.request: ${(e as Error).message?.slice(0, 80)}`);
  }

  // Patch every SDK that ships its OWN nested axios. The SDKs are ESM
  // (`"type": "module"` in their package.json) and axios v1+ ships SEPARATE
  // ESM + CJS builds — CJS at `dist/node/axios.cjs`, ESM at `index.js`. They
  // are distinct module instances with distinct interceptor stacks. To patch
  // the instance the SDK actually uses, we must import the ESM variant via
  // dynamic `import()` of the file URL. Bug-fix 2026-05-27 (#22).
  //
  // Fire-and-forget — caller awaits ensureProxyRoutingReady() if they need
  // to guarantee the patch landed before the next SDK call.
  _patchPromise = patchSdkNestedAxiosAsync(interceptor);
}

let _patchPromise: Promise<void> | null = null;

/** Awaitable handle on the SDK-axios patch — call this right before your
 *  first SDK submission to be sure the interceptor is in place. */
export async function ensureProxyRoutingReady(): Promise<void> {
  if (_patchPromise) await _patchPromise;
}

async function patchSdkNestedAxiosAsync(interceptor: (config: any) => any): Promise<void> {
  for (const nested of [
    "@polymarket/clob-client-v2",
    "@polymarket/clob-client",
  ]) {
    try {
      // Resolve the SDK's nested axios via filesystem and import the ESM entry.
      const fs = await import("node:fs");
      const path = await import("node:path");
      const pathToFileURL = (await import("node:url")).pathToFileURL;
      const axiosPkgPath = `${process.cwd()}/node_modules/${nested}/node_modules/axios/package.json`;
      if (!fs.existsSync(axiosPkgPath)) continue;
      const pkg = JSON.parse(fs.readFileSync(axiosPkgPath, "utf8"));
      const esmRel = pkg.module ?? pkg.main;
      const esmFsPath = path.resolve(path.dirname(axiosPkgPath), esmRel);
      const mod = await import(pathToFileURL(esmFsPath).href);
      const instance = (mod.default ?? mod) as typeof import("axios").default;
      if (instance && instance !== axios && instance.interceptors?.request) {
        instance.interceptors.request.use(interceptor);
      }
      // ALSO patch the CJS variant — some code paths import the .cjs build.
      try {
        const cjsRel = pkg.main;
        if (cjsRel && cjsRel !== esmRel) {
          const cjsFsPath = path.resolve(path.dirname(axiosPkgPath), cjsRel);
          const cjsMod = require_(cjsFsPath);
          const cjsInstance = (cjsMod.default ?? cjsMod) as typeof import("axios").default;
          if (cjsInstance && cjsInstance !== instance && cjsInstance.interceptors?.request) {
            cjsInstance.interceptors.request.use(interceptor);
          }
        }
      } catch { /* CJS variant absent — ESM patch is enough for SDKs that import ESM */ }
    } catch (e) {
      console.warn(`[poly-proxy] could not patch ${nested}'s nested axios: ${(e as Error).message?.slice(0, 100)}`);
    }
  }
}

/**
 * Wrapped fetch that routes Polymarket calls through the proxy and leaves
 * everything else on the local network. Use in place of `fetch()` when
 * calling Polymarket REST endpoints from our code (not the SDK — that's
 * covered by the axios patch).
 *
 * Implementation uses https-proxy-agent + axios under the hood when proxying,
 * and falls back to native fetch otherwise. Axios is already imported above
 * for the interceptor, so this reuses the same singleton.
 */
/** A proxy bandwidth-quota response (Webshare returns 402 when the plan's GB are spent). */
export function isProxyQuotaStatus(status: number): boolean {
  return status === 402;
}

/** Track quota-exhaustion so the operator surface (and logs) can see it without parsing bodies. */
let _lastQuotaExhaustedAt: number | null = null;
export function proxyQuotaState(): { exhausted: boolean; lastSeenMsAgo: number | null } {
  return {
    exhausted: _lastQuotaExhaustedAt != null && Date.now() - _lastQuotaExhaustedAt < 5 * 60_000,
    lastSeenMsAgo: _lastQuotaExhaustedAt == null ? null : Date.now() - _lastQuotaExhaustedAt,
  };
}

const PROXY_MAX_ATTEMPTS = Number(process.env.POLYMARKET_PROXY_MAX_ATTEMPTS ?? "3");
const PROXY_TIMEOUT_MS = Number(process.env.POLYMARKET_PROXY_TIMEOUT_MS ?? "30000");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Fetch a Polymarket endpoint through the configured proxy, with resilience the raw
 * passthrough lacked:
 *   - NETWORK failures (timeout/DNS/proxy-down) retry with exponential backoff (1s, 3s, 9s)
 *     instead of throwing on the first blip — a momentary proxy hiccup no longer kills a daemon loop.
 *   - TRANSIENT server statuses (429/502/503/504) retry the same way.
 *   - 402 (proxy BANDWIDTH QUOTA exhausted) is surfaced LOUDLY to stderr and recorded in
 *     proxyQuotaState() — retrying the same exhausted proxy won't help, so we return it fast
 *     for the caller to handle, but it can never again hide as a silent "cycle error".
 * Non-Polymarket URLs and the no-proxy case fall straight through to native fetch (unchanged).
 */
export async function polyFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input.toString();
  const proxyUrl = process.env.POLYMARKET_PROXY_URL;
  if (!proxyUrl || !urlMatchesPolymarket(url)) {
    return fetch(input, init);
  }
  const agent = getAgent();
  if (!agent) return fetch(input, init);
  // Use axios to perform the request through the proxy, then synthesize a
  // standard Response object so callers can use .json() / .text() / .status
  // exactly like with fetch.
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body as any;
  const headers: Record<string, string> = {};
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => { headers[k] = v; });
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) headers[k] = v;
    } else {
      Object.assign(headers, init.headers);
    }
  }

  const toResponse = (axResp: any): Response =>
    new Response(typeof axResp.data === "string" ? axResp.data : JSON.stringify(axResp.data), {
      status: axResp.status,
      statusText: axResp.statusText,
      headers: Object.fromEntries(
        Object.entries(axResp.headers ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)]),
      ),
    });

  const isTransientStatus = (s: number) => s === 429 || s === 502 || s === 503 || s === 504;
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= Math.max(1, PROXY_MAX_ATTEMPTS); attempt++) {
    try {
      const axResp = await axios.request({
        url, method, headers, data: body,
        httpsAgent: agent, httpAgent: agent, proxy: false,
        validateStatus: () => true,           // let us inspect 4xx/5xx instead of throwing
        responseType: "text",
        timeout: init?.signal && "reason" in init.signal ? undefined : PROXY_TIMEOUT_MS,
      });

      if (isProxyQuotaStatus(axResp.status)) {
        _lastQuotaExhaustedAt = Date.now();
        console.error(
          `🚨 [poly-proxy] BANDWIDTH QUOTA EXHAUSTED (HTTP 402) on ${new URL(url).host} — ` +
          `the Webshare plan is out of GB. CLOB calls will fail until you top up at ` +
          `dashboard.webshare.io or rotate POLYMARKET_PROXY_URL in .env.local. Returning 402 to caller.`,
        );
        return toResponse(axResp);            // retrying the exhausted proxy is pointless
      }

      if (isTransientStatus(axResp.status) && attempt < PROXY_MAX_ATTEMPTS) {
        const delay = 1000 * Math.pow(3, attempt - 1);
        console.warn(`[poly-proxy] ${axResp.status} on ${new URL(url).host} — retry ${attempt}/${PROXY_MAX_ATTEMPTS - 1} in ${delay}ms`);
        await sleep(delay);
        continue;
      }

      return toResponse(axResp);
    } catch (e: any) {
      // Network-level failure (timeout, DNS, proxy unreachable) — retry with backoff.
      lastErr = new Error(`polyFetch failed: ${e.message}`);
      if (attempt < PROXY_MAX_ATTEMPTS) {
        const delay = 1000 * Math.pow(3, attempt - 1);
        console.warn(`[poly-proxy] network error on ${new URL(url).host} (${e.message}) — retry ${attempt}/${PROXY_MAX_ATTEMPTS - 1} in ${delay}ms`);
        await sleep(delay);
        continue;
      }
    }
  }
  throw lastErr ?? new Error("polyFetch failed: exhausted retries");
}

/** Returns a short status string for the operator surface. */
export function proxyStatus(): { enabled: boolean; host?: string; hostsRouted: string[] } {
  const url = process.env.POLYMARKET_PROXY_URL;
  if (!url) return { enabled: false, hostsRouted: POLY_HOSTS };
  try {
    const parsed = new URL(url);
    return { enabled: true, host: parsed.host, hostsRouted: POLY_HOSTS };
  } catch {
    return { enabled: false, hostsRouted: POLY_HOSTS };
  }
}
