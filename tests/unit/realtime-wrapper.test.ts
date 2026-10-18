import { describe, expect, it } from "vitest";
import { hasClobCreds, PolymarketRealtime, readCredsFromEnv } from "@/lib/polymarket/realtime";

// Don't actually connect — these tests verify the wrapper's shape without
// touching network. Live verification belongs in a script run by the operator.
describe("PolymarketRealtime wrapper", () => {
  it("requireClient throws before connect()", () => {
    const rt = new PolymarketRealtime();
    expect(() => rt.subscribeActivity()).toThrow(/connect\(\) before subscribing/);
  });

  it("isConnected is false before connect()", () => {
    const rt = new PolymarketRealtime();
    expect(rt.isConnected()).toBe(false);
  });
});

describe("readCredsFromEnv", () => {
  const KEYS = ["POLYMARKET_CLOB_API_KEY", "POLYMARKET_CLOB_SECRET", "POLYMARKET_CLOB_PASSPHRASE"] as const;

  it("throws a useful message when any cred is missing", () => {
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    try {
      for (const k of KEYS) delete process.env[k];
      expect(() => readCredsFromEnv()).toThrow(/POLYMARKET_CLOB_API_KEY/);
      expect(hasClobCreds()).toBe(false);
    } finally {
      for (const k of KEYS) if (saved[k] !== undefined) process.env[k] = saved[k];
    }
  });

  it("returns creds when all three are set", () => {
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    try {
      process.env.POLYMARKET_CLOB_API_KEY = "k";
      process.env.POLYMARKET_CLOB_SECRET = "s";
      process.env.POLYMARKET_CLOB_PASSPHRASE = "p";
      const creds = readCredsFromEnv();
      expect(creds).toEqual({ key: "k", secret: "s", passphrase: "p" });
      expect(hasClobCreds()).toBe(true);
    } finally {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
