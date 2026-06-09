import { describe, it, expect } from "vitest";
import { consensusCoins, seedFromConsensus, DEFAULT_DISCOVER } from "@/lib/exec/consensus-discovery";
import type { WalletPosition } from "@/lib/exec/smart-money";

const pos = (wallet: string, coin: string, szi: number, notionalUsd: number, accountValue = 1e6): WalletPosition => ({ wallet, coin, szi, notionalUsd, accountValue });

describe("consensusCoins — conviction clusters, not raw PnL", () => {
  it("flags a coin where >= minWallets co-hold the same side, with the participating wallets", () => {
    const c = consensusCoins([
      pos("a", "HYPE", 1, 50_000), pos("b", "HYPE", 1, 40_000), pos("c", "HYPE", 1, 30_000), // 3 longs
      pos("d", "BTC", 1, 100_000),                                                            // lone long — no consensus
    ]);
    expect(c).toHaveLength(1);
    expect(c[0].coin).toBe("HYPE");
    expect(c[0].side).toBe("long");
    expect(c[0].nWallets).toBe(3);
    expect(c[0].wallets.sort()).toEqual(["a", "b", "c"]);
    expect(c[0].convictionUsd).toBe(120_000);
  });
  it("keeps long and short as separate clusters", () => {
    const c = consensusCoins([
      pos("a", "ETH", 1, 50_000), pos("b", "ETH", 1, 50_000), pos("c", "ETH", 1, 50_000),
      pos("x", "ETH", -1, 60_000), pos("y", "ETH", -1, 60_000), pos("z", "ETH", -1, 60_000),
    ]);
    expect(c).toHaveLength(2);
    expect(new Set(c.map((k) => k.side))).toEqual(new Set(["long", "short"]));
  });
  it("ignores dust positions and dust accounts (skin in the game)", () => {
    const c = consensusCoins([
      pos("a", "SOL", 1, 500), pos("b", "SOL", 1, 500), pos("c", "SOL", 1, 500),            // all dust notional
      pos("d", "SOL", 1, 50_000, 1_000), pos("e", "SOL", 1, 50_000, 1_000), pos("f", "SOL", 1, 50_000, 1_000), // dust accounts
    ]);
    expect(c).toHaveLength(0);
  });
  it("ranks a wide cluster (more wallets) above a single whale", () => {
    const c = consensusCoins([
      pos("a", "WIDE", 1, 20_000), pos("b", "WIDE", 1, 20_000), pos("c", "WIDE", 1, 20_000), pos("d", "WIDE", 1, 20_000),
      pos("w1", "WHALE", 1, 70_000), pos("w2", "WHALE", 1, 70_000), pos("w3", "WHALE", 1, 70_000),
    ]);
    expect(c[0].coin).toBe("WIDE"); // 4 wallets outranks 3 even with less per-wallet notional
  });
});

describe("seedFromConsensus — wallets aligned with the crowd across multiple coins rank first", () => {
  it("a wallet co-holding two consensus coins outranks one holding a single coin", () => {
    const clusters = consensusCoins([
      pos("multi", "HYPE", 1, 50_000), pos("b", "HYPE", 1, 50_000), pos("c", "HYPE", 1, 50_000),
      pos("multi", "ETH", 1, 50_000), pos("x", "ETH", 1, 50_000), pos("y", "ETH", 1, 50_000),
    ]);
    const seeds = seedFromConsensus(clusters);
    expect(seeds[0].wallet).toBe("multi");
    expect(seeds[0].clusters).toBe(2);
    expect(seeds[0].coins.sort()).toEqual(["ETH:long", "HYPE:long"]);
  });
  it("returns every unique participating wallet exactly once", () => {
    const clusters = consensusCoins([pos("a", "X", 1, 50_000), pos("b", "X", 1, 50_000), pos("c", "X", 1, 50_000)]);
    const seeds = seedFromConsensus(clusters);
    expect(seeds.map((s) => s.wallet).sort()).toEqual(["a", "b", "c"]);
  });
});
