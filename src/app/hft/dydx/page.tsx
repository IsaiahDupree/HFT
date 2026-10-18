import Link from "next/link";
import { DydxHub } from "@/components/dydx/DydxHub";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "dYdX live · HFT",
  description: "Live dYdX v4 markets, subaccount, and testnet market-maker controls.",
};

export default function DydxHftPage() {
  return (
    <div className="mx-auto max-w-7xl px-6 py-8 space-y-8">
      <header>
        <div className="text-xs uppercase tracking-wider text-accent-blue">dYdX live</div>
        <h1 className="text-2xl font-semibold tracking-tight mt-1">
          dYdX v4 markets, account & testnet market-maker
        </h1>
        <p className="text-zinc-400 mt-2 max-w-3xl text-sm">
          Live perpetual-market data from the dYdX Indexer, account state for the wallet configured in
          <code className="text-zinc-200 mx-1">DYDX_TESTNET_MNEMONIC</code>, and inline controls for the in-process market-making
          engine. Default network is testnet — switch above if you've opted into mainnet.
        </p>
        <p className="text-[11px] text-zinc-500 mt-2">
          Setup: <code className="text-zinc-200">npm run dydx:wallet-init</code> →
          add mnemonic to <code className="text-zinc-200">.env.local</code> →
          <code className="text-zinc-200">npm run dydx:faucet</code> →
          come back here. The MM engine here is the same one driven by{" "}
          <code className="text-zinc-200">npm run dydx:mm</code>.
          <Link href="/hft" className="ml-2 text-accent-blue hover:underline">← back to /hft comparator</Link>
        </p>
      </header>

      <DydxHub initialMarket="ETH-USD" />
    </div>
  );
}
