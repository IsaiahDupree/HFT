import Link from "next/link";
import { notFound } from "next/navigation";
import { poly } from "@/lib/polymarket/client";
import { fingerprintWallet } from "@/lib/wallets/fingerprint";
import {
  extractTradeFeatures,
  type TradeForFeatures,
  type WalletHistorySummary,
} from "@/lib/wallets/trade-features";

export const dynamic = "force-dynamic";

function fmtUsd(n: number): string {
  return `$${Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function toTradeForFeatures(t: any): TradeForFeatures {
  const tsRaw = Number(t.timestamp ?? 0);
  const ms = tsRaw > 1e12 ? tsRaw : tsRaw * 1000;
  return {
    marketKey: String(t.conditionId ?? t.eventSlug ?? "?"),
    direction: String(t.outcome ?? t.side ?? "?").toUpperCase(),
    side: (String(t.side ?? "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL",
    price: Number(t.price ?? 0),
    usd: Number(t.usdcSize ?? Number(t.size ?? 0) * Number(t.price ?? 0)),
    ts: new Date(ms).toISOString(),
  };
}

export default async function WalletTimelinePage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) notFound();

  const trades = (await poly.userTrades(address, { limit: 100 }).catch(() => [])) as any[];
  if (!Array.isArray(trades) || trades.length === 0) {
    return (
      <div className="space-y-4">
        <div>
          <Link href={`/wallets/${address}`} className="text-xs text-zinc-500 hover:text-zinc-300">
            ← back to fingerprint
          </Link>
          <h1 className="text-2xl font-semibold mt-1">Classified trade timeline</h1>
          <div className="font-mono text-xs text-zinc-500 mt-1">{address}</div>
        </div>
        <div className="card text-sm text-zinc-500">No recent trades available for this wallet.</div>
      </div>
    );
  }

  const fp = fingerprintWallet({ proxyWallet: address, trades });
  const recentTrades = trades.map(toTradeForFeatures);
  const walletHistory: WalletHistorySummary = {
    medianTradeUsd: fp.medianTradeUsd,
    tradesPerHourMean: fp.tradesPerHourMean,
    peakHourUtc: fp.peakHourUtc,
    recentTrades,
  };

  const classified = trades.slice(0, 50).map((t) => {
    const trade = toTradeForFeatures(t);
    const features = extractTradeFeatures({ trade, walletHistory });
    return {
      trade,
      title: String(t.title ?? t.eventSlug ?? "?"),
      features,
      txHash: String(t.transactionHash ?? ""),
    };
  });

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/wallets/${address}`} className="text-xs text-zinc-500 hover:text-zinc-300">
          ← back to fingerprint
        </Link>
        <h1 className="text-2xl font-semibold mt-1">Classified trade timeline</h1>
        <div className="font-mono text-xs text-zinc-500 mt-1">{address}</div>
        <p className="text-xs text-zinc-500 mt-2">
          Most recent {classified.length} trades, each annotated with feature scores + inferred
          drivers. Strategy family: <span className="text-zinc-300">{fp.strategyFamily}</span>.
          For continuous classification with cross-wallet context, run{" "}
          <code>npm run observe:wallet -- --addresses {address.slice(0, 10)}…</code>.
        </p>
      </div>

      <table className="list w-full text-xs">
        <thead>
          <tr>
            <th>Time UTC</th>
            <th>Market</th>
            <th>Side</th>
            <th>Outcome</th>
            <th className="text-right">Price</th>
            <th className="text-right">USD</th>
            <th className="text-right">Size z</th>
            <th>Likely driver</th>
          </tr>
        </thead>
        <tbody>
          {classified.map((c, i) => (
            <tr key={i}>
              <td className="tabular-nums">{c.trade.ts.slice(5, 16).replace("T", " ")}</td>
              <td className="text-zinc-300">{c.title.slice(0, 50)}{c.title.length > 50 ? "…" : ""}</td>
              <td className={c.trade.side === "BUY" ? "text-accent-green" : "text-accent-red"}>
                {c.trade.side}
              </td>
              <td>{c.trade.direction}</td>
              <td className="text-right tabular-nums">{c.trade.price.toFixed(3)}</td>
              <td className="text-right tabular-nums">{fmtUsd(c.trade.usd)}</td>
              <td
                className={`text-right tabular-nums ${
                  Math.abs(c.features.sizeZScore) > 2 ? "text-accent-amber" : ""
                }`}
              >
                {c.features.sizeZScore.toFixed(1)}
              </td>
              <td className="text-zinc-400">{c.features.likelyDrivers[0] ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="card text-xs text-zinc-500">
        <p>
          <strong className="text-zinc-300">How to read this.</strong> Each row shows what likely
          drove the trade. <em>News fade</em> = unusually large entry at extreme price. <em>Activity
          surge</em> = wallet's cadence multiplied. <em>Momentum follower / fade big move</em>
          require market-history context (run the observer for that). Cross-wallet
          <em> consensus tail</em> is only available from the observer pipeline since it pulls from
          the evolution log. The static timeline below shows only wallet-local features.
        </p>
      </section>
    </div>
  );
}
