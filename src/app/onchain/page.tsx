import { OnChainStream } from "./OnChainStream";

export const dynamic = "force-dynamic";

export default function OnChainPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">On-chain fills (live)</h1>
        <p className="text-zinc-400 text-sm mt-1">
          Streaming <code>OrderFilled</code> events from CTF Exchange V2 and Neg Risk CTF Exchange via a
          Polygon WebSocket. This is the lowest-latency feed available without running our own Polygon node —
          fills appear here as the block including them is announced.
        </p>
      </div>
      <OnChainStream />
    </div>
  );
}
