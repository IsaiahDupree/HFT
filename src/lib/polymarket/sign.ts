/**
 * Polymarket auth signing helpers — matches the reference TS/Python clients.
 * - L1: EIP-712 typed-data signature for /auth/api-key + /auth/derive-api-key.
 * - L2: HMAC-SHA256 over `${timestamp}${method}${path}${body}`, base64url-encoded.
 */
import { createHmac } from "node:crypto";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type ApiCreds = { apiKey: string; secret: string; passphrase: string };

const CLOB_AUTH_DOMAIN = (chainId: number) => ({
  name: "ClobAuthDomain",
  version: "1",
  chainId,
});

const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: "address", type: "address" },
    { name: "timestamp", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "message", type: "string" },
  ],
} as const;

export async function l1Headers(opts: {
  privateKey: `0x${string}`;
  timestamp: string;
  nonce: bigint;
  chainId: number;
}) {
  const account = privateKeyToAccount(opts.privateKey);
  const signature = await account.signTypedData({
    domain: CLOB_AUTH_DOMAIN(opts.chainId),
    types: CLOB_AUTH_TYPES,
    primaryType: "ClobAuth",
    message: {
      address: account.address,
      timestamp: opts.timestamp,
      nonce: opts.nonce,
      message: "This message attests that I control the given wallet",
    },
  });
  return {
    POLY_ADDRESS: account.address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: opts.timestamp,
    POLY_NONCE: opts.nonce.toString(),
  };
}

/** HMAC sign in the exact format Polymarket expects: base64url(HMAC-SHA256(secret, ts+method+path+body)). */
export function hmacSign(secret: string, timestamp: string, method: string, requestPath: string, body?: string): string {
  // secret arrives as a base64url string — decode to raw bytes before keying HMAC.
  const keyBytes = Buffer.from(secret.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const message = `${timestamp}${method}${requestPath}${body ?? ""}`;
  const digest = createHmac("sha256", keyBytes).update(message).digest();
  return digest.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Stable hash of order payload — used as the signed-order salt input. */
export function hashOrderPayload(payload: string): `0x${string}` {
  return keccak256(toBytes(payload));
}
