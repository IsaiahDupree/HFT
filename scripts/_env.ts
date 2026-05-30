// Tiny .env.local loader for the standalone scripts so we don't depend on a runner flag.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Strip an inline `# comment` from an env value, but only when the # is OUTSIDE
 * quotes. Without this, a line like `POLYMARKET_SIGNATURE_TYPE=1  # POLY_PROXY`
 * was being read as the literal string "1  # POLY_PROXY", which then parsed to
 * NaN downstream and silently defaulted to EOA — the root cause of bug #16
 * (2026-05-26) where every Polymarket order signed with signatureType=0 instead
 * of 1 (POLY_PROXY), producing `order_version_mismatch` from the CLOB.
 *
 * Quoted values are left alone (e.g. `FOO="bar # not a comment"` returns
 * `bar # not a comment`).
 */
function stripInlineComment(raw: string): string {
  // If the value is fully wrapped in quotes, strip them and return as-is.
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // Otherwise, cut at the first ` #` (space-then-hash) — anything after is a
  // comment per dotenv convention. A `#` immediately after `=` with no space
  // before it is treated as the value (uncommon but valid).
  const hashIdx = raw.search(/\s+#/);
  return hashIdx === -1 ? raw : raw.slice(0, hashIdx);
}

const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = stripInlineComment(trimmed.slice(eq + 1).trim()).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

export const env = {
  RELAYER_API_KEY: process.env.POLYMARKET_RELAYER_API_KEY ?? "",
  RELAYER_API_KEY_ADDRESS: process.env.POLYMARKET_RELAYER_API_KEY_ADDRESS ?? "",
  PRIVATE_KEY: process.env.POLYMARKET_PRIVATE_KEY ?? "",
  CLOB_API_KEY: process.env.POLYMARKET_CLOB_API_KEY ?? "",
  CLOB_SECRET: process.env.POLYMARKET_CLOB_SECRET ?? "",
  CLOB_PASSPHRASE: process.env.POLYMARKET_CLOB_PASSPHRASE ?? "",
  FUNDER_ADDRESS: process.env.POLYMARKET_FUNDER_ADDRESS ?? "",
  SIGNATURE_TYPE: Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? "1"),
  GAMMA: process.env.POLYMARKET_GAMMA_HOST ?? "https://gamma-api.polymarket.com",
  DATA: process.env.POLYMARKET_DATA_HOST ?? "https://data-api.polymarket.com",
  CLOB: process.env.POLYMARKET_CLOB_HOST ?? "https://clob.polymarket.com",
  RELAYER: process.env.POLYMARKET_RELAYER_HOST ?? "https://relayer-v2.polymarket.com",
  CHAIN_ID: Number(process.env.POLYMARKET_CHAIN_ID ?? "137"),
} as const;
