/**
 * Kalshi request signing — RSA-PSS per https://docs.kalshi.com/getting_started/api_environments
 *
 * Per-request signature:
 *   message   = `${timestampMs}${METHOD}${pathWithoutQuery}`
 *   signature = base64( RSA-PSS-SHA256( privateKey, message, saltLength=32 ) )
 *
 * Headers attached to every authenticated REST call:
 *   KALSHI-ACCESS-KEY        : public access-key string from Kalshi
 *   KALSHI-ACCESS-TIMESTAMP  : same `timestampMs` used in the signed message
 *   KALSHI-ACCESS-SIGNATURE  : the base64 signature
 *
 * Two ways to provide credentials:
 *   1. `KALSHI_API_KEY_FILE` → path to `{ accessKey, privateKeyPem }` JSON
 *      (defaults to `./kalshi_api_key.json` if the file exists)
 *   2. `KALSHI_ACCESS_KEY` + `KALSHI_PRIVATE_KEY` env vars
 *      (env-encoded PEM may use literal `\n` instead of real newlines)
 *
 * The key file is gitignored. See .gitignore + project_security.md.
 */
import { createPrivateKey, sign as cryptoSign, constants, type KeyObject } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

type KalshiKey = { accessKey: string; keyObj: KeyObject };

let _cached: KalshiKey | null = null;

function normalizePem(raw: string): string {
  return raw.includes("-----BEGIN") && !raw.includes("\n") ? raw.replace(/\\n/g, "\n") : raw;
}

function loadKey(): KalshiKey {
  if (_cached) return _cached;

  const inlineKey = process.env.KALSHI_ACCESS_KEY;
  const inlinePk = process.env.KALSHI_PRIVATE_KEY;
  if (inlineKey && inlinePk) {
    const keyObj = createPrivateKey(normalizePem(inlinePk));
    assertRsa(keyObj);
    _cached = { accessKey: inlineKey, keyObj };
    return _cached;
  }

  const filePath = process.env.KALSHI_API_KEY_FILE ?? "kalshi_api_key.json";
  const abs = resolve(process.cwd(), filePath);
  if (!existsSync(abs)) {
    throw new Error(
      `Kalshi API key not found. Set KALSHI_ACCESS_KEY + KALSHI_PRIVATE_KEY env vars, ` +
        `or place a {accessKey, privateKeyPem} JSON at ${filePath} (or set KALSHI_API_KEY_FILE).`,
    );
  }
  const json = JSON.parse(readFileSync(abs, "utf8")) as { accessKey?: string; privateKeyPem?: string };
  if (!json.accessKey || !json.privateKeyPem) {
    throw new Error(`Kalshi key file ${filePath} is missing 'accessKey' or 'privateKeyPem'`);
  }
  const keyObj = createPrivateKey(normalizePem(json.privateKeyPem));
  assertRsa(keyObj);
  _cached = { accessKey: json.accessKey, keyObj };
  return _cached;
}

function assertRsa(keyObj: KeyObject): void {
  if (keyObj.asymmetricKeyType !== "rsa") {
    throw new Error(`Kalshi requires RSA private key; got ${keyObj.asymmetricKeyType ?? "unknown"}`);
  }
}

export function clearAuthCache(): void {
  _cached = null;
}

export function authIsAvailable(): boolean {
  try { loadKey(); return true; } catch { return false; }
}

export function accessKey(): string {
  return loadKey().accessKey;
}

/**
 * Strip the querystring from a path. Kalshi explicitly signs only the path
 * portion — passing a full URL or a path-with-query will silently produce a
 * bad signature, so we normalize here.
 */
function pathWithoutQuery(path: string): string {
  return path.split("?")[0];
}

export type SignResult = {
  timestampMs: string;
  signatureB64: string;
  accessKey: string;
};

/**
 * Compute the Kalshi RSA-PSS signature for a single request.
 * Exported separately so tests can pin a fixed timestamp.
 */
export function signRequest(method: string, path: string, opts: { nowMs?: number } = {}): SignResult {
  const { accessKey: ak, keyObj } = loadKey();
  const ts = String(opts.nowMs ?? Date.now());
  const message = `${ts}${method.toUpperCase()}${pathWithoutQuery(path)}`;
  const sig = cryptoSign("RSA-SHA256", Buffer.from(message), {
    key: keyObj,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  return { timestampMs: ts, signatureB64: sig.toString("base64"), accessKey: ak };
}

/** Convenience: return the three headers ready to merge into a fetch() call. */
export function authHeaders(method: string, path: string): Record<string, string> {
  const { timestampMs, signatureB64, accessKey: ak } = signRequest(method, path);
  return {
    "KALSHI-ACCESS-KEY": ak,
    "KALSHI-ACCESS-TIMESTAMP": timestampMs,
    "KALSHI-ACCESS-SIGNATURE": signatureB64,
  };
}
