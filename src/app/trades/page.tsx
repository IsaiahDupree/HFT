import Link from "next/link";
import { listRecentTrades } from "@/lib/db/queries";
import { poly } from "@/lib/polymarket/client";

export const dynamic = "force-dynamic";

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}

export default async function TradesPage() {
  const local = listRecentTrades(50);
  const addr = process.env.POLYMARKET_RELAYER_API_KEY_ADDRESS!;
  const onchain = (await safe(() => poly.userTrades(addr, { limit: 25 }))) ?? [];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Trades</h1>
        <p className="text-zinc-400 text-sm">Local agent trades and live on-chain trades for the configured signer wallet.</p>
      </div>

      <section className="card">
        <h2 className="card-title">Agent trades (local DB)</h2>
        {local.length === 0 ? (
          <p className="text-zinc-500 text-xs">No agent-recorded trades yet. The research loop will populate these once strategies fire.</p>
        ) : (
          <table className="list">
            <thead><tr><th>Time</th><th>Strategy</th><th>Side</th><th>Px</th><th>Size</th><th>Intent</th><th>Status</th></tr></thead>
            <tbody>{local.map((t) => (
              <tr key={t.id}>
                <td>{t.opened_at?.slice(0, 16)}</td>
                <td><Link className="text-accent-blue hover:underline" href={`/strategies/${t.agent_slug}/${t.strategy_slug}`}>{t.strategy_name}</Link></td>
                <td>{t.side}</td>
                <td>{Number(t.price).toFixed(3)}</td>
                <td>{Number(t.size).toFixed(2)}</td>
                <td>{t.intent}</td>
                <td><span className={`pill-${t.status === "filled" ? "green" : t.status === "rejected" ? "red" : "amber"}`}>{t.status}</span></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">On-chain trades for {addr.slice(0, 10)}…{addr.slice(-4)}</h2>
        {onchain.length === 0 ? (
          <p className="text-zinc-500 text-xs">No on-chain trades recorded for this signer.</p>
        ) : (
          <table className="list">
            <thead><tr><th>Time</th><th>Market</th><th>Side</th><th>Outcome</th><th>Px</th><th>Size</th><th>USDC</th></tr></thead>
            <tbody>{onchain.slice(0, 25).map((t: any, i: number) => (
              <tr key={t.transactionHash ?? i}>
                <td>{new Date((t.timestamp ?? 0) * 1000).toISOString().slice(0, 16)}</td>
                <td className="max-w-[26rem] truncate"><span className="text-zinc-300">{t.title ?? t.eventSlug ?? t.conditionId?.slice(0, 14)}</span></td>
                <td>{t.side}</td>
                <td>{t.outcome}</td>
                <td>{Number(t.price ?? 0).toFixed(3)}</td>
                <td>{Number(t.size ?? 0).toFixed(2)}</td>
                <td className="tabular-nums">${Number(t.usdcSize ?? t.size * (t.price ?? 0)).toFixed(2)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </div>
  );
}
