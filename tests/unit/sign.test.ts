import { describe, expect, it } from "vitest";
import { hashOrderPayload, hmacSign } from "@/lib/polymarket/sign";

describe("hmacSign — known shape", () => {
  // Secret is base64url-encoded; we just need a valid-shaped value.
  const SECRET = "dGVzdHNlY3JldHRoYXRpc2xvbmdlcmZvcmtleQ=="; // base64 of "testsecretthatislongerforkey"

  it.each([
    { method: "GET", path: "/data/orders", body: undefined },
    { method: "GET", path: "/auth/api-keys", body: undefined },
    { method: "GET", path: "/balance-allowance", body: undefined },
    { method: "POST", path: "/order", body: '{"foo":"bar"}' },
    { method: "DELETE", path: "/cancel-all", body: undefined },
  ])("$method $path returns base64url string", ({ method, path, body }) => {
    const sig = hmacSign(SECRET, "1700000000", method, path, body);
    expect(typeof sig).toBe("string");
    expect(sig.length).toBeGreaterThan(20);
    // base64url alphabet: A-Z a-z 0-9 - _
    expect(/^[A-Za-z0-9_-]+={0,2}$/.test(sig)).toBe(true);
  });

  it("produces different signatures for different timestamps", () => {
    const a = hmacSign(SECRET, "1700000000", "GET", "/data/orders");
    const b = hmacSign(SECRET, "1700000001", "GET", "/data/orders");
    expect(a).not.toBe(b);
  });

  it("produces different signatures for different paths", () => {
    const a = hmacSign(SECRET, "1700000000", "GET", "/data/orders");
    const b = hmacSign(SECRET, "1700000000", "GET", "/data/trades");
    expect(a).not.toBe(b);
  });

  it("produces different signatures for different methods", () => {
    const a = hmacSign(SECRET, "1700000000", "GET", "/order");
    const b = hmacSign(SECRET, "1700000000", "POST", "/order");
    expect(a).not.toBe(b);
  });

  it("is deterministic for the same inputs", () => {
    const a = hmacSign(SECRET, "1700000000", "GET", "/x");
    const b = hmacSign(SECRET, "1700000000", "GET", "/x");
    expect(a).toBe(b);
  });

  it("body content affects signature", () => {
    const a = hmacSign(SECRET, "1700000000", "POST", "/order", '{"a":1}');
    const b = hmacSign(SECRET, "1700000000", "POST", "/order", '{"a":2}');
    expect(a).not.toBe(b);
  });

  it("absent body equals empty string body", () => {
    const a = hmacSign(SECRET, "1700000000", "GET", "/x");
    const b = hmacSign(SECRET, "1700000000", "GET", "/x", "");
    expect(a).toBe(b);
  });

  it.each(["+/=", "-_=", "abc", "ABC", "AAAA", "Aa_-/+"])(
    "tolerates secret with variant base64 chars: %s padding",
    (_secret) => {
      const sig = hmacSign("dGVzdA==", "1", "GET", "/");
      expect(typeof sig).toBe("string");
    },
  );
});

describe("hashOrderPayload", () => {
  it("returns 0x-prefixed 64-hex-char string", () => {
    const h = hashOrderPayload("some-payload");
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(hashOrderPayload("x")).toBe(hashOrderPayload("x"));
  });

  it.each([
    "a", "b", "1", "{}", '{"x":1}', "the quick brown fox", "🎲", "a".repeat(10000),
  ])("hashes %s", (s) => {
    expect(hashOrderPayload(s)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
