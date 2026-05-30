import { describe, expect, it } from "vitest";
import {
  readUsdcFlowsForWallet,
  summarizeFlows,
  usdcUnitsToUsd,
  USDC_E_POLYGON,
} from "@/lib/onchain/bridges";

describe("usdcUnitsToUsd", () => {
  it("decodes whole and fractional 6-decimal USDC", () => {
    expect(usdcUnitsToUsd(1_000_000n)).toBe(1);
    expect(usdcUnitsToUsd(2_500_000n)).toBe(2.5);
    expect(usdcUnitsToUsd(123n)).toBeCloseTo(0.000123, 8);
    expect(usdcUnitsToUsd(0n)).toBe(0);
  });

  it("handles large whale amounts without losing precision on the whole part", () => {
    // 5,000,000 USDC = 5e12 in units
    expect(usdcUnitsToUsd(5_000_000_000_000n)).toBe(5_000_000);
  });
});

describe("readUsdcFlowsForWallet", () => {
  function makeLog(
    overrides: { from: string; to: string; value: bigint; blockNumber: number; txHash: string },
  ) {
    return {
      args: { from: overrides.from, to: overrides.to, value: overrides.value },
      blockNumber: BigInt(overrides.blockNumber),
      transactionHash: overrides.txHash,
    };
  }

  it("combines in + out logs, tags direction, sorts by block desc", async () => {
    const wallet = "0x0000000000000000000000000000000000000001" as `0x${string}`;
    const fakeClient = {
      async getBlockNumber() {
        return 100_000n;
      },
      async getLogs(args: any) {
        if (args.args?.to === wallet) {
          return [
            makeLog({ from: "0xAAAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA", to: wallet, value: 1_000_000n, blockNumber: 99_990, txHash: "0xabc" }),
          ];
        }
        return [
          makeLog({ from: wallet, to: "0xBBBBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbB", value: 500_000n, blockNumber: 99_995, txHash: "0xdef" }),
        ];
      },
    };
    const flows = await readUsdcFlowsForWallet(fakeClient as any, wallet);
    expect(flows).toHaveLength(2);
    expect(flows[0].blockNumber).toBe(99_995); // sorted desc
    expect(flows[0].direction).toBe("out");
    expect(flows[0].amountUsd).toBe(0.5);
    expect(flows[1].direction).toBe("in");
    expect(flows[1].amountUsd).toBe(1);
  });

  it("flags bridge events (counterparty = zero address)", async () => {
    const wallet = "0x0000000000000000000000000000000000000002" as `0x${string}`;
    const fakeClient = {
      async getBlockNumber() {
        return 1000n;
      },
      async getLogs(args: any) {
        if (args.args?.to === wallet) {
          // Bridge mint
          return [
            makeLog({
              from: "0x0000000000000000000000000000000000000000",
              to: wallet,
              value: 10_000_000n,
              blockNumber: 999,
              txHash: "0xbridge",
            }),
          ];
        }
        return [];
      },
    };
    const flows = await readUsdcFlowsForWallet(fakeClient as any, wallet);
    expect(flows).toHaveLength(1);
    expect(flows[0].isBridgeEvent).toBe(true);
    expect(flows[0].direction).toBe("in");
    expect(flows[0].amountUsd).toBe(10);
  });

  it("respects minAmountUsd filter", async () => {
    const wallet = "0x0000000000000000000000000000000000000003" as `0x${string}`;
    const fakeClient = {
      async getBlockNumber() {
        return 1000n;
      },
      async getLogs(args: any) {
        if (args.args?.to === wallet) {
          return [
            // $5 (below)
            makeLog({ from: "0x000000000000000000000000000000000000abcd", to: wallet, value: 5_000_000n, blockNumber: 990, txHash: "0xsmall" }),
            // $50_000 (above)
            makeLog({ from: "0x000000000000000000000000000000000000ABCD", to: wallet, value: 50_000_000_000n, blockNumber: 991, txHash: "0xbig" }),
          ];
        }
        return [];
      },
    };
    const flows = await readUsdcFlowsForWallet(fakeClient as any, wallet, { minAmountUsd: 1000 });
    expect(flows).toHaveLength(1);
    expect(flows[0].amountUsd).toBe(50_000);
  });

  it("uses USDC.e contract address", () => {
    expect(USDC_E_POLYGON).toBe("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174");
  });
});

describe("summarizeFlows", () => {
  it("computes net + gross + bridge totals", () => {
    const flows = [
      { wallet: "0xA" as string, direction: "in" as const, counterparty: "0xZ", amountUsd: 1000, blockNumber: 1, txHash: "0x1", isBridgeEvent: false },
      { wallet: "0xA", direction: "in" as const, counterparty: "0x0", amountUsd: 5000, blockNumber: 2, txHash: "0x2", isBridgeEvent: true },
      { wallet: "0xA", direction: "out" as const, counterparty: "0xY", amountUsd: 2000, blockNumber: 3, txHash: "0x3", isBridgeEvent: false },
      { wallet: "0xA", direction: "out" as const, counterparty: "0x0", amountUsd: 500, blockNumber: 4, txHash: "0x4", isBridgeEvent: true },
    ];
    const s = summarizeFlows(flows);
    expect(s.grossInUsd).toBe(6000);
    expect(s.grossOutUsd).toBe(2500);
    expect(s.netUsd).toBe(3500);
    expect(s.bridgeInUsd).toBe(5000);
    expect(s.bridgeOutUsd).toBe(500);
    expect(s.txCount).toBe(4);
  });

  it("handles empty arrays", () => {
    const s = summarizeFlows([]);
    expect(s).toEqual({ netUsd: 0, grossInUsd: 0, grossOutUsd: 0, bridgeInUsd: 0, bridgeOutUsd: 0, txCount: 0 });
  });
});
