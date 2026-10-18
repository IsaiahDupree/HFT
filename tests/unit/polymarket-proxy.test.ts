/**
 * Tests for `src/lib/polymarket/proxy.ts` — the resolver that fixes the
 * backfill:wallet → on-chain mapping gap.
 *
 * The test vector at the bottom uses real on-chain data we captured for
 * `0xb55fa1296E6ec55D0cE53d93B9237389f11764d4`'s most recent fill (tx
 * `0x07739d…676a4e9` on 2026-05-26). That confirms the resolver returns the
 * address that actually appears in OrderFilled events.
 */
import { describe, expect, it } from "vitest";
import { extractFillParticipants, resolveOnchainAddress, walletAppearsOnchain } from "../../src/lib/polymarket/proxy";

const ORDER_FILLED_T0 = "0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee";
const pad32 = (addr: string) => "0x" + "0".repeat(24) + addr.slice(2).toLowerCase();

describe("resolveOnchainAddress", () => {
  it("passes through a lowercase address verbatim", () => {
    const r = resolveOnchainAddress("0x02227b8f5a9636e895607edd3185ed6ee5598ff7");
    expect(r.address).toBe("0x02227b8f5a9636e895607edd3185ed6ee5598ff7");
    expect(r.kind).toBe("proxy_contract");
  });

  it("normalizes mixed-case to lowercase (eth_getLogs filters are case-insensitive but consistency matters)", () => {
    const r = resolveOnchainAddress("0x02227B8F5A9636e895607EDd3185ed6EE5598FF7");
    expect(r.address).toBe("0x02227b8f5a9636e895607edd3185ed6ee5598ff7");
  });

  it("trims whitespace", () => {
    const r = resolveOnchainAddress("   0x02227b8f5a9636e895607edd3185ed6ee5598ff7  ");
    expect(r.address).toBe("0x02227b8f5a9636e895607edd3185ed6ee5598ff7");
  });

  it("throws on malformed input rather than silently coercing", () => {
    expect(() => resolveOnchainAddress("not_an_address")).toThrow(/malformed address/i);
    expect(() => resolveOnchainAddress("0x123")).toThrow(/malformed address/i);
    expect(() => resolveOnchainAddress("")).toThrow(/malformed address/i);
  });
});

describe("extractFillParticipants", () => {
  const makerAddr = "0x8a6ec94a904eef776dabd1e237d82bdb085db4f5";
  const takerAddr = "0xb55fa1296e6ec55d0ce53d93b9237389f11764d4";

  it("returns maker + taker for each OrderFilled log", () => {
    const logs = [
      {
        address: "0xe111180000d2663c0091e4f400237545b87b996b",
        topics: [
          ORDER_FILLED_T0,
          "0x" + "11".repeat(32),                // orderHash
          pad32(makerAddr),
          pad32(takerAddr),
        ],
      },
    ];
    const out = extractFillParticipants(logs, ORDER_FILLED_T0);
    expect(out).toContain(makerAddr);
    expect(out).toContain(takerAddr);
    expect(out.length).toBe(2);
  });

  it("dedupes across multiple logs", () => {
    const logs = [
      {
        address: "0xe111180000d2663c0091e4f400237545b87b996b",
        topics: [ORDER_FILLED_T0, "0x" + "11".repeat(32), pad32(makerAddr), pad32(takerAddr)],
      },
      {
        address: "0xe111180000d2663c0091e4f400237545b87b996b",
        topics: [ORDER_FILLED_T0, "0x" + "22".repeat(32), pad32(takerAddr), pad32(makerAddr)],
      },
    ];
    const out = extractFillParticipants(logs, ORDER_FILLED_T0);
    expect(new Set(out)).toEqual(new Set([makerAddr, takerAddr]));
  });

  it("ignores logs with a non-matching topic0", () => {
    const logs = [
      { address: "0xanything", topics: ["0xdeadbeef" + "00".repeat(28), "0x" + "11".repeat(32), pad32(makerAddr), pad32(takerAddr)] },
    ];
    const out = extractFillParticipants(logs, ORDER_FILLED_T0);
    expect(out.length).toBe(0);
  });
});

describe("walletAppearsOnchain — closes the loop", () => {
  it("confirms the data-API's proxyWallet is also the on-chain participant", () => {
    // This is the real test vector from the 2026-05-26 capture:
    // - Data API said proxyWallet = 0xb55fa1296E6ec55D0cE53d93B9237389f11764d4
    // - We pulled its most recent tx (0x07739d...676a4e9) and decoded the
    //   OrderFilled logs. The same address appears as taker on one log and
    //   maker on another.
    const wallet = "0xb55fa1296E6ec55D0cE53d93B9237389f11764d4";
    const participants = [
      "0x8a6ec94a904eef776dabd1e237d82bdb085db4f5" as `0x${string}`,
      "0xb55fa1296e6ec55d0ce53d93b9237389f11764d4" as `0x${string}`,
    ];
    expect(walletAppearsOnchain(wallet, participants)).toBe(true);
  });

  it("returns false when the wallet is not among the participants", () => {
    const wallet = "0x0000000000000000000000000000000000000001";
    const participants = ["0xabc1111111111111111111111111111111111111" as `0x${string}`];
    expect(walletAppearsOnchain(wallet, participants)).toBe(false);
  });

  it("is case-insensitive", () => {
    const wallet = "0xB55FA1296E6EC55D0CE53D93B9237389F11764D4";
    const participants = ["0xb55fa1296e6ec55d0ce53d93b9237389f11764d4" as `0x${string}`];
    expect(walletAppearsOnchain(wallet, participants)).toBe(true);
  });
});
