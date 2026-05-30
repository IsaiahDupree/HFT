/**
 * Derives (or creates) the CLOB L2 API credentials for the configured signer.
 * Hits GET /auth/derive-api-key with L1 EIP-712 headers. Falls back to
 * POST /auth/api-key when no credentials exist for the default nonce.
 *
 * On success, prints the apiKey/secret/passphrase and updates .env.local in place.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { env } from "./_env.ts";
import { l1Headers } from "../src/lib/polymarket/sign.ts";
// Use proxy-aware fetch — derive endpoint is on clob.polymarket.com which is
// geo-restricted. polyFetch routes through Webshare GB when POLYMARKET_PROXY_URL
// is set, otherwise behaves like native fetch.
import { polyFetch } from "../src/lib/polymarket/proxy-routing.ts";

async function deriveOrCreate(): Promise<{ apiKey: string; secret: string; passphrase: string }> {
  if (!env.PRIVATE_KEY) throw new Error("POLYMARKET_PRIVATE_KEY missing in .env.local");
  const ts = Math.floor(Date.now() / 1000).toString();
  const headers = await l1Headers({
    privateKey: env.PRIVATE_KEY as `0x${string}`,
    timestamp: ts,
    nonce: 0n,
    chainId: env.CHAIN_ID,
  });

  const deriveRes = await polyFetch(`${env.CLOB}/auth/derive-api-key`, { method: "GET", headers });
  if (deriveRes.ok) {
    return await deriveRes.json();
  }
  const deriveErr = await deriveRes.text();
  console.warn(`derive failed (${deriveRes.status}): ${deriveErr.slice(0, 200)}  — falling back to create.`);

  const ts2 = Math.floor(Date.now() / 1000).toString();
  const headers2 = await l1Headers({
    privateKey: env.PRIVATE_KEY as `0x${string}`,
    timestamp: ts2,
    nonce: 0n,
    chainId: env.CHAIN_ID,
  });
  const createRes = await polyFetch(`${env.CLOB}/auth/api-key`, { method: "POST", headers: headers2 });
  if (!createRes.ok) {
    throw new Error(`create failed (${createRes.status}): ${(await createRes.text()).slice(0, 400)}`);
  }
  return await createRes.json();
}

function patchEnv(creds: { apiKey: string; secret: string; passphrase: string }) {
  const path = ".env.local";
  let body = readFileSync(path, "utf8");
  const setOrAppend = (key: string, val: string) => {
    const re = new RegExp(`^${key}=.*$`, "m");
    body = re.test(body) ? body.replace(re, `${key}=${val}`) : `${body.trimEnd()}\n${key}=${val}\n`;
  };
  setOrAppend("POLYMARKET_CLOB_API_KEY", creds.apiKey);
  setOrAppend("POLYMARKET_CLOB_SECRET", creds.secret);
  setOrAppend("POLYMARKET_CLOB_PASSPHRASE", creds.passphrase);
  writeFileSync(path, body);
}

(async () => {
  const creds = await deriveOrCreate();
  console.log("CLOB L2 credentials acquired:");
  console.log("  apiKey:    ", creds.apiKey);
  console.log("  secret:    ", creds.secret.slice(0, 8) + "…(redacted)");
  console.log("  passphrase:", creds.passphrase.slice(0, 8) + "…(redacted)");
  patchEnv(creds);
  console.log("Wrote .env.local.");
})().catch((err) => {
  console.error("Failed to derive CLOB credentials:", err.message);
  process.exit(1);
});
