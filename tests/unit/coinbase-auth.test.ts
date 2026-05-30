import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

// Tests bypass the real `coinbase_cloud_api_key.json` by setting env vars
// before importing the auth module (which caches the key on first access).
const TEST_KEY_NAME = "organizations/test-org-uuid/apiKeys/test-key-uuid";

function genEs256Pem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return (privateKey as KeyObject).export({ type: "sec1", format: "pem" }) as string;
}
function genEd25519Pem(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return (privateKey as KeyObject).export({ type: "pkcs8", format: "pem" }) as string;
}

let originalFile: string | undefined;
let originalName: string | undefined;
let originalKey: string | undefined;
let originalHost: string | undefined;

beforeEach(() => {
  originalFile = process.env.COINBASE_CDP_KEY_FILE;
  originalName = process.env.COINBASE_CDP_KEY_NAME;
  originalKey = process.env.COINBASE_CDP_PRIVATE_KEY;
  originalHost = process.env.COINBASE_HOST;
  // Point key-file env to a non-existent path so we can't accidentally pick up the real key.
  process.env.COINBASE_CDP_KEY_FILE = "tests/.fixtures/__missing__.json";
  delete process.env.COINBASE_CDP_KEY_NAME;
  delete process.env.COINBASE_CDP_PRIVATE_KEY;
});

afterEach(async () => {
  if (originalFile === undefined) delete process.env.COINBASE_CDP_KEY_FILE;
  else process.env.COINBASE_CDP_KEY_FILE = originalFile;
  if (originalName === undefined) delete process.env.COINBASE_CDP_KEY_NAME;
  else process.env.COINBASE_CDP_KEY_NAME = originalName;
  if (originalKey === undefined) delete process.env.COINBASE_CDP_PRIVATE_KEY;
  else process.env.COINBASE_CDP_PRIVATE_KEY = originalKey;
  if (originalHost === undefined) delete process.env.COINBASE_HOST;
  else process.env.COINBASE_HOST = originalHost;
  const { clearAuthCache } = await import("@/lib/coinbase/auth");
  clearAuthCache();
});

describe("authIsAvailable / loadKey", () => {
  it("returns false when no key sources are configured", async () => {
    const { authIsAvailable, clearAuthCache } = await import("@/lib/coinbase/auth");
    clearAuthCache();
    expect(authIsAvailable()).toBe(false);
  });

  it("loads inline ES256 (SEC1 EC) key from env vars", async () => {
    process.env.COINBASE_CDP_KEY_NAME = TEST_KEY_NAME;
    process.env.COINBASE_CDP_PRIVATE_KEY = genEs256Pem();
    const { authIsAvailable, keyAlg, keyName, clearAuthCache } = await import("@/lib/coinbase/auth");
    clearAuthCache();
    expect(authIsAvailable()).toBe(true);
    expect(keyAlg()).toBe("ES256");
    expect(keyName()).toBe(TEST_KEY_NAME);
  });

  it("loads inline Ed25519 (PKCS8) key and reports EdDSA alg", async () => {
    process.env.COINBASE_CDP_KEY_NAME = TEST_KEY_NAME;
    process.env.COINBASE_CDP_PRIVATE_KEY = genEd25519Pem();
    const { keyAlg, clearAuthCache } = await import("@/lib/coinbase/auth");
    clearAuthCache();
    expect(keyAlg()).toBe("EdDSA");
  });

  it("normalizes literal \\n in env-encoded PEM keys", async () => {
    process.env.COINBASE_CDP_KEY_NAME = TEST_KEY_NAME;
    process.env.COINBASE_CDP_PRIVATE_KEY = genEs256Pem().replace(/\n/g, "\\n");
    const { authIsAvailable, clearAuthCache } = await import("@/lib/coinbase/auth");
    clearAuthCache();
    expect(authIsAvailable()).toBe(true);
  });

  it("loads ES256 key from a JSON file referenced by COINBASE_CDP_KEY_FILE", async () => {
    mkdirSync(resolve("tests/.fixtures"), { recursive: true });
    const path = resolve("tests/.fixtures/cdp_test_key.json");
    writeFileSync(path, JSON.stringify({ name: TEST_KEY_NAME, privateKey: genEs256Pem() }));
    process.env.COINBASE_CDP_KEY_FILE = path;
    const { authIsAvailable, keyName, clearAuthCache } = await import("@/lib/coinbase/auth");
    clearAuthCache();
    expect(authIsAvailable()).toBe(true);
    expect(keyName()).toBe(TEST_KEY_NAME);
    rmSync(path, { force: true });
  });
});

describe("buildJwt — REST", () => {
  beforeEach(() => {
    process.env.COINBASE_CDP_KEY_NAME = TEST_KEY_NAME;
    process.env.COINBASE_CDP_PRIVATE_KEY = genEs256Pem();
  });

  it("produces a three-segment compact JWT", async () => {
    const { buildJwt, clearAuthCache } = await import("@/lib/coinbase/auth");
    clearAuthCache();
    const jwt = await buildJwt({ method: "GET", path: "/api/v3/brokerage/accounts" });
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    parts.forEach((p) => expect(/^[A-Za-z0-9_-]+$/.test(p)).toBe(true));
  });

  it("header contains alg=ES256, typ=JWT, kid=key-name, and a hex nonce", async () => {
    const { buildJwt, clearAuthCache } = await import("@/lib/coinbase/auth");
    clearAuthCache();
    const jwt = await buildJwt({ method: "GET", path: "/api/v3/brokerage/accounts" });
    const header = JSON.parse(Buffer.from(jwt.split(".")[0], "base64url").toString("utf8"));
    expect(header.alg).toBe("ES256");
    expect(header.typ).toBe("JWT");
    expect(header.kid).toBe(TEST_KEY_NAME);
    expect(/^[0-9a-f]{32}$/.test(header.nonce)).toBe(true); // 16 bytes hex
  });

  it("payload sets sub, iss=cdp, nbf/exp with 120s lifetime, and uri for REST", async () => {
    const { buildJwt, clearAuthCache } = await import("@/lib/coinbase/auth");
    clearAuthCache();
    const fixedNow = 1_800_000_000;
    const jwt = await buildJwt({ method: "GET", path: "/api/v3/brokerage/accounts", now: fixedNow });
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    expect(payload.sub).toBe(TEST_KEY_NAME);
    expect(payload.iss).toBe("cdp");
    expect(payload.nbf).toBe(fixedNow);
    expect(payload.exp).toBe(fixedNow + 120);
    expect(payload.uri).toBe("GET api.coinbase.com/api/v3/brokerage/accounts");
  });

  it("strips querystring from the uri claim", async () => {
    const { buildJwt, clearAuthCache } = await import("@/lib/coinbase/auth");
    clearAuthCache();
    const jwt = await buildJwt({ method: "GET", path: "/api/v3/brokerage/orders/historical/batch?limit=5&order_status=OPEN" });
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    expect(payload.uri).toBe("GET api.coinbase.com/api/v3/brokerage/orders/historical/batch");
  });

  it("omits the uri claim when method/path are not provided (WS JWT)", async () => {
    const { buildJwt, clearAuthCache } = await import("@/lib/coinbase/auth");
    clearAuthCache();
    const jwt = await buildJwt();
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    expect(payload.uri).toBeUndefined();
    expect(payload.iss).toBe("cdp");
    expect(payload.sub).toBe(TEST_KEY_NAME);
  });

  it("produces a different nonce on each call (so two JWTs for the same request differ)", async () => {
    const { buildJwt, clearAuthCache } = await import("@/lib/coinbase/auth");
    clearAuthCache();
    const a = await buildJwt({ method: "GET", path: "/api/v3/brokerage/accounts", now: 1_800_000_000 });
    const b = await buildJwt({ method: "GET", path: "/api/v3/brokerage/accounts", now: 1_800_000_000 });
    expect(a).not.toBe(b); // differs by nonce + ECDSA randomness
  });

  it("respects custom host in the uri claim", async () => {
    const { buildJwt, clearAuthCache } = await import("@/lib/coinbase/auth");
    clearAuthCache();
    const jwt = await buildJwt({ method: "GET", path: "/api/v3/brokerage/accounts", host: "api-sandbox.coinbase.com" });
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    expect(payload.uri).toBe("GET api-sandbox.coinbase.com/api/v3/brokerage/accounts");
  });
});

describe("buildJwt — EdDSA branch", () => {
  it("uses alg=EdDSA when the key is Ed25519", async () => {
    process.env.COINBASE_CDP_KEY_NAME = TEST_KEY_NAME;
    process.env.COINBASE_CDP_PRIVATE_KEY = genEd25519Pem();
    const { buildJwt, clearAuthCache } = await import("@/lib/coinbase/auth");
    clearAuthCache();
    const jwt = await buildJwt({ method: "GET", path: "/api/v3/brokerage/time" });
    const header = JSON.parse(Buffer.from(jwt.split(".")[0], "base64url").toString("utf8"));
    expect(header.alg).toBe("EdDSA");
  });
});
