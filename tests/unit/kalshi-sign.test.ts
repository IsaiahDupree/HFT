import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, createVerify, constants } from "node:crypto";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const TEST_ACCESS_KEY = "kk-test-access-key-uuid";

function genRsaKeypair() {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}
function genRsaPrivPem(): string {
  const { privateKey } = genRsaKeypair();
  return privateKey.export({ type: "pkcs8", format: "pem" }) as string;
}

let origFile: string | undefined;
let origKey: string | undefined;
let origPk: string | undefined;

beforeEach(() => {
  origFile = process.env.KALSHI_API_KEY_FILE;
  origKey = process.env.KALSHI_ACCESS_KEY;
  origPk = process.env.KALSHI_PRIVATE_KEY;
  // Force-miss the real key file so tests can't accidentally pick it up.
  process.env.KALSHI_API_KEY_FILE = "tests/.fixtures/__kalshi_missing__.json";
  delete process.env.KALSHI_ACCESS_KEY;
  delete process.env.KALSHI_PRIVATE_KEY;
});

afterEach(async () => {
  if (origFile === undefined) delete process.env.KALSHI_API_KEY_FILE;
  else process.env.KALSHI_API_KEY_FILE = origFile;
  if (origKey === undefined) delete process.env.KALSHI_ACCESS_KEY;
  else process.env.KALSHI_ACCESS_KEY = origKey;
  if (origPk === undefined) delete process.env.KALSHI_PRIVATE_KEY;
  else process.env.KALSHI_PRIVATE_KEY = origPk;
  const { clearAuthCache } = await import("@/lib/kalshi/sign");
  clearAuthCache();
});

describe("authIsAvailable / loadKey", () => {
  it("returns false when no key sources configured", async () => {
    const { authIsAvailable, clearAuthCache } = await import("@/lib/kalshi/sign");
    clearAuthCache();
    expect(authIsAvailable()).toBe(false);
  });

  it("loads inline RSA key from env vars", async () => {
    process.env.KALSHI_ACCESS_KEY = TEST_ACCESS_KEY;
    process.env.KALSHI_PRIVATE_KEY = genRsaPrivPem();
    const { authIsAvailable, accessKey, clearAuthCache } = await import("@/lib/kalshi/sign");
    clearAuthCache();
    expect(authIsAvailable()).toBe(true);
    expect(accessKey()).toBe(TEST_ACCESS_KEY);
  });

  it("rejects non-RSA private keys (Kalshi requires RSA)", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    process.env.KALSHI_ACCESS_KEY = TEST_ACCESS_KEY;
    process.env.KALSHI_PRIVATE_KEY = privateKey.export({ type: "sec1", format: "pem" }) as string;
    const { authIsAvailable, clearAuthCache } = await import("@/lib/kalshi/sign");
    clearAuthCache();
    expect(authIsAvailable()).toBe(false);
  });

  it("normalizes literal \\n in env-encoded PEM keys", async () => {
    process.env.KALSHI_ACCESS_KEY = TEST_ACCESS_KEY;
    process.env.KALSHI_PRIVATE_KEY = genRsaPrivPem().replace(/\n/g, "\\n");
    const { authIsAvailable, clearAuthCache } = await import("@/lib/kalshi/sign");
    clearAuthCache();
    expect(authIsAvailable()).toBe(true);
  });

  it("loads key from a JSON file referenced by KALSHI_API_KEY_FILE", async () => {
    mkdirSync(resolve("tests/.fixtures"), { recursive: true });
    const path = resolve("tests/.fixtures/kalshi_test_key.json");
    writeFileSync(path, JSON.stringify({ accessKey: TEST_ACCESS_KEY, privateKeyPem: genRsaPrivPem() }));
    process.env.KALSHI_API_KEY_FILE = path;
    const { authIsAvailable, accessKey: ak, clearAuthCache } = await import("@/lib/kalshi/sign");
    clearAuthCache();
    expect(authIsAvailable()).toBe(true);
    expect(ak()).toBe(TEST_ACCESS_KEY);
    rmSync(path, { force: true });
  });
});

describe("signRequest — RSA-PSS over timestamp_ms + METHOD + path", () => {
  let pubPem: string;
  beforeEach(() => {
    const { publicKey, privateKey } = genRsaKeypair();
    pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
    process.env.KALSHI_ACCESS_KEY = TEST_ACCESS_KEY;
    process.env.KALSHI_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  });

  it("produces a base64 signature that verifies under RSA-PSS-SHA256 saltLen=32", async () => {
    const { signRequest, clearAuthCache } = await import("@/lib/kalshi/sign");
    clearAuthCache();
    const { timestampMs, signatureB64 } = signRequest("GET", "/trade-api/v2/portfolio/balance", { nowMs: 1_800_000_000_000 });
    const message = `${timestampMs}GET/trade-api/v2/portfolio/balance`;
    const ok = createVerify("RSA-SHA256")
      .update(message)
      .verify(
        { key: pubPem, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
        Buffer.from(signatureB64, "base64"),
      );
    expect(ok).toBe(true);
  });

  it("strips querystring from the signed path", async () => {
    const { signRequest, clearAuthCache } = await import("@/lib/kalshi/sign");
    clearAuthCache();
    const { timestampMs, signatureB64 } = signRequest(
      "GET",
      "/trade-api/v2/portfolio/orders?limit=5&status=resting",
      { nowMs: 1_800_000_000_000 },
    );
    // Verify against the path WITHOUT the querystring.
    const ok = createVerify("RSA-SHA256")
      .update(`${timestampMs}GET/trade-api/v2/portfolio/orders`)
      .verify(
        { key: pubPem, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
        Buffer.from(signatureB64, "base64"),
      );
    expect(ok).toBe(true);
  });

  it("uppercases the method in the signed message", async () => {
    const { signRequest, clearAuthCache } = await import("@/lib/kalshi/sign");
    clearAuthCache();
    const { timestampMs, signatureB64 } = signRequest("post", "/trade-api/v2/portfolio/orders", { nowMs: 123 });
    const ok = createVerify("RSA-SHA256")
      .update(`${timestampMs}POST/trade-api/v2/portfolio/orders`)
      .verify(
        { key: pubPem, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
        Buffer.from(signatureB64, "base64"),
      );
    expect(ok).toBe(true);
  });

  it("two signatures for the same input differ (PSS randomized salt)", async () => {
    const { signRequest, clearAuthCache } = await import("@/lib/kalshi/sign");
    clearAuthCache();
    const a = signRequest("GET", "/trade-api/v2/markets", { nowMs: 1_800_000_000_000 });
    const b = signRequest("GET", "/trade-api/v2/markets", { nowMs: 1_800_000_000_000 });
    expect(a.signatureB64).not.toBe(b.signatureB64);
  });
});

describe("authHeaders", () => {
  beforeEach(() => {
    process.env.KALSHI_ACCESS_KEY = TEST_ACCESS_KEY;
    process.env.KALSHI_PRIVATE_KEY = genRsaPrivPem();
  });

  it("returns all three KALSHI-ACCESS-* headers", async () => {
    const { authHeaders, clearAuthCache } = await import("@/lib/kalshi/sign");
    clearAuthCache();
    const h = authHeaders("GET", "/trade-api/v2/markets");
    expect(h["KALSHI-ACCESS-KEY"]).toBe(TEST_ACCESS_KEY);
    expect(h["KALSHI-ACCESS-TIMESTAMP"]).toMatch(/^\d+$/);
    expect(h["KALSHI-ACCESS-SIGNATURE"]).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});
