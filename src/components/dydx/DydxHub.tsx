"use client";

import { useState } from "react";
import { DydxMarketsTable } from "./DydxMarketsTable";
import { DydxMarketDetail } from "./DydxMarketDetail";
import { DydxAccountCard } from "./DydxAccountCard";
import { DydxMmPanel } from "./DydxMmPanel";

export function DydxHub({ initialMarket = "ETH-USD" }: { initialMarket?: string }) {
  const [net, setNet] = useState<"testnet" | "mainnet">("testnet");
  const [ticker, setTicker] = useState(initialMarket);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span className="text-xs uppercase tracking-wider text-zinc-500">Network</span>
        <div className="inline-flex border border-ink-700 rounded overflow-hidden">
          {(["testnet", "mainnet"] as const).map((n) => (
            <button
              key={n}
              onClick={() => setNet(n)}
              className={`px-3 py-1 text-xs ${net === n ? "bg-accent-blue/15 text-accent-blue" : "text-zinc-400 hover:text-zinc-200"}`}
            >
              {n}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-zinc-500">
          {net === "testnet"
            ? "free funds via faucet; trading enabled"
            : "live network — wallet ops use DYDX_MAINNET_MNEMONIC"}
        </span>
      </div>

      <DydxMarketsTable net={net} selected={ticker} onSelect={setTicker} />

      <DydxMarketDetail net={net} ticker={ticker} />

      <div className="grid grid-cols-12 gap-6">
        <div className="col-span-12 lg:col-span-5">
          <DydxAccountCard net={net} />
        </div>
        <div className="col-span-12 lg:col-span-7">
          <DydxMmPanel net={net} market={ticker} />
        </div>
      </div>
    </div>
  );
}
