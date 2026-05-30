/**
 * Coinbase Advanced Trade auth — CDP API key JWT signing.
 *
 * Two supported key formats, auto-detected:
 *   • ECDSA P-256 (SEC1 `-----BEGIN EC PRIVATE KEY-----` or PKCS8) → alg ES256
 *   • Ed25519 (PKCS8 `-----BEGIN PRIVATE KEY-----` or raw 32-byte b64) → alg EdDSA
 *
 * Two ways to provide the key:
 *   1. `COINBASE_CDP_KEY_FILE` → path to a `{ name, privateKey }` JSON file
 *      (defaults to `./coinbase_cloud_api_key.json` if the file exists)
 *   2. `COINBASE_CDP_KEY_NAME` + `COINBASE_CDP_PRIVATE_KEY` env vars
 *      (private key newlines may be encoded as literal `\n`)
 *
 * JWT layout (matches the official SDK exactly):
 *   header  : { alg, typ:"JWT", kid:<name>, nonce:<hex16> }
 *   payload : { sub:<name>, iss:"cdp", nbf:<now>, exp:<now+120>, uri?:"METHOD host/path" }
 *
 * `uri` is REST-only — omit it for WebSocket JWTs.
 *
 * NOTE: legacy HMAC scheme (CB-ACCESS-KEY/SIGN/TIMESTAMP/PASSPHRASE) expired
 * 2025-02-05 and is intentionally not implemented.
 */
import { randomBytes, createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { SignJWT } from "jose";

type CdpKeyMaterial = { name: string; keyObj: KeyObject; alg: "ES256" | "EdDSA" };

let _cached: CdpKeyMaterial | null = null;

function normalizePem(raw: string): string {
  // Env-encoded keys often have literal `\n` instead of real newlines.
  return raw.includes("-----BEGIN") && !raw.includes("\n") ? raw.replace(/\\n/g, "\n") : raw;
}

function detectAlg(keyObj: KeyObject): "ES256" | "EdDSA" {
  const t = keyObj.asymmetricKeyType;
  if (t === "ed25519") return "EdDSA";
  if (t === "ec") {
    const curve = (keyObj.asymmetricKeyDetails as { namedCurve?: string } | undefined)?.namedCurve;
    if (curve && curve !== "prime256v1" && curve !== "P-256") {
      throw new Error(`Unsupported EC curve for CDP JWT: ${curve} (expected P-256)`);
    }
    return "ES256";
  }
  throw new Error(`Unsupported CDP private-key type: ${t ?? "unknown"} (expected ed25519 or ec/P-256)`);
}

function loadKey(): CdpKeyMaterial {
  if (_cached) return _cached;

  const inlineName = process.env.COINBASE_CDP_KEY_NAME;
  const inlinePk = process.env.COINBASE_CDP_PRIVATE_KEY;
  if (inlineName && inlinePk) {
    const keyObj = createPrivateKey(normalizePem(inlinePk));
    _cached = { name: inlineName, keyObj, alg: detectAlg(keyObj) };
    return _cached;
  }

  const filePath = process.env.COINBASE_CDP_KEY_FILE ?? "coinbase_cloud_api_key.json";
  const abs = resolve(process.cwd(), filePath);
  if (!existsSync(abs)) {
    throw new Error(
      `Coinbase CDP key not found. Set COINBASE_CDP_KEY_NAME + COINBASE_CDP_PRIVATE_KEY env vars, ` +
      `or place a {name, privateKey} JSON at ${filePath} (or set COINBASE_CDP_KEY_FILE).`,
    );
  }
  const json = JSON.parse(readFileSync(abs, "utf8")) as { name?: string; privateKey?: string };
  if (!json.name || !json.privateKey) {
    throw new Error(`CDP key file ${filePath} is missing 'name' or 'privateKey'`);
  }
  const keyObj = createPrivateKey(normalizePem(json.privateKey));
  _cached = { name: json.name, keyObj, alg: detectAlg(keyObj) };
  return _cached;
}

export function clearAuthCache(): void {
  _cached = null;
}

export function authIsAvailable(): boolean {
  try { loadKey(); return true; } catch { return false; }
}

export type JwtOpts = {
  /** REST: `"GET"` / `"POST"` / etc. Omit for WebSocket JWTs. */
  method?: string;
  /** REST: full path including `/api/v3/brokerage/...`. Omit for WebSocket JWTs. */
  path?: string;
  /** Host for `uri` claim; defaults to `api.coinbase.com`. */
  host?: string;
  /** Token lifetime in seconds (default 120, matches SDK). */
  ttlSec?: number;
  /** Override `now` (unix seconds) for deterministic tests. */
  now?: number;
};

/** Build a short-lived JWT bearer for a single Advanced Trade REST request or WS subscribe. */
export async function buildJwt(opts: JwtOpts = {}): Promise<string> {
  const { name, keyObj, alg } = loadKey();
  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSec ?? 120;
  const host = opts.host ?? "api.coinbase.com";

  const claims: Record<string, unknown> = {
    sub: name,
    iss: "cdp",
    nbf: nowSec,
    exp: nowSec + ttl,
  };
  if (opts.method && opts.path) {
    // `uri` claim format is exactly: METHOD SP host PATH — no scheme, no querystring.
    const pathNoQuery = opts.path.split("?")[0];
    claims.uri = `${opts.method.toUpperCase()} ${host}${pathNoQuery}`;
  }

  const nonce = randomBytes(16).toString("hex");

  return new SignJWT(claims)
    .setProtectedHeader({ alg, typ: "JWT", kid: name, nonce })
    .sign(keyObj);
}

/** Convenience: build an Authorization header value for a REST call. */
export async function authHeader(method: string, path: string, host?: string): Promise<string> {
  const jwt = await buildJwt({ method, path, host });
  return `Bearer ${jwt}`;
}

export function keyName(): string {
  return loadKey().name;
}

export function keyAlg(): "ES256" | "EdDSA" {
  return loadKey().alg;
}
