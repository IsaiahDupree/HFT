import Link from "next/link";
import { poly } from "@/lib/polymarket/client";

export const dynamic = "force-dynamic";
export const revalidate = 30;

export default async function MarketsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const search = q ?? "";
  const [sampling, events] = await Promise.all([
    poly.samplingMarkets(10).catch(() => ({ data: [] as any[] })),
    poly.events({ limit: 12, closed: false }).catch(() => [] as any[]),
  ]);

  let searchResults: any[] = [];
  if (search) {
    try {
      const r = await poly.search(search, 5);
      searchResults = (r.events ?? []).slice(0, 10);
    } catch {}
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Markets</h1>
        <p className="text-zinc-400 text-sm">Live sampling markets (reward-eligible) and upcoming events.</p>
      </div>

      <form action="" className="flex gap-2">
        <input
          name="q"
          defaultValue={search}
          placeholder="Search markets, events, profiles…"
          className="flex-1 bg-ink-900 border border-ink-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-accent-blue"
        />
        <button className="px-4 py-2 rounded bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30">Search</button>
      </form>

      {search && (
        <section className="card">
          <h2 className="card-title">Search results for &quot;{search}&quot;</h2>
          {searchResults.length === 0 ? (
            <p className="text-zinc-500 text-xs">No matching events.</p>
          ) : (
            <ul className="space-y-2 text-sm">{searchResults.map((e: any) => (
              <li key={e.id}><Link href={`/markets/event/${e.id}`} className="row-link block">
                <span className="text-zinc-100">{e.title ?? e.question}</span>
                <span className="ml-2 text-zinc-500 text-xs">{e.slug}</span>
              </Link></li>
            ))}</ul>
          )}
        </section>
      )}

      <section className="card">
        <h2 className="card-title">Live sampling markets (orderbook-eligible)</h2>
        <table className="list">
          <thead><tr><th>Market</th><th>Outcome</th><th>Yes px</th><th>No px</th><th></th></tr></thead>
          <tbody>{(sampling.data ?? []).map((m: any) => {
            const yes = m.tokens?.find((t: any) => t.outcome === "Yes");
            const no = m.tokens?.find((t: any) => t.outcome === "No");
            return (
              <tr key={m.condition_id}>
                <td className="max-w-xl truncate">{m.question}</td>
                <td>{m.tokens?.length ?? 0}</td>
                <td className="tabular-nums">{yes?.price?.toFixed(3) ?? "—"}</td>
                <td className="tabular-nums">{no?.price?.toFixed(3) ?? "—"}</td>
                <td><Link href={`/markets/condition/${m.condition_id}`} className="text-accent-blue hover:underline text-xs">open →</Link></td>
              </tr>
            );
          })}</tbody>
        </table>
      </section>

      <section className="card">
        <h2 className="card-title">Upcoming events (Gamma)</h2>
        <ul className="grid grid-cols-2 gap-3 text-sm">
          {events.map((e: any) => (
            <li key={e.id} className="border border-ink-700 rounded p-3">
              <Link href={`/markets/event/${e.id}`} className="text-zinc-100 hover:text-accent-blue">{e.title}</Link>
              <div className="text-xs text-zinc-500 mt-1">{e.slug}</div>
              <div className="text-xs text-zinc-400 mt-1">{e.markets?.length ?? 0} market{(e.markets?.length ?? 0) === 1 ? "" : "s"}</div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
