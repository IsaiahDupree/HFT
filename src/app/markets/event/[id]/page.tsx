import Link from "next/link";
import { poly } from "@/lib/polymarket/client";

export const dynamic = "force-dynamic";

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [event, vol] = await Promise.all([
    safe(() => poly.event(id)),
    safe(() => poly.liveEventVolume(id)),
  ]);
  if (!event) return <div className="text-zinc-500">Event not found.</div>;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/markets" className="text-xs text-zinc-500 hover:text-zinc-300">← markets</Link>
        <h1 className="text-2xl font-semibold mt-1">{event.title}</h1>
        <p className="text-sm text-zinc-400 mt-1 max-w-3xl">{event.description}</p>
        <div className="flex gap-4 text-xs text-zinc-500 mt-2">
          <span>slug: <span className="text-zinc-300">{event.slug}</span></span>
          <span>volume: <span className="text-zinc-300">${Number(event.volume ?? 0).toLocaleString()}</span></span>
          {vol && Array.isArray(vol) && vol[0] ? <span>live vol: <span className="text-zinc-300">${Number((vol[0] as any).volume ?? 0).toLocaleString()}</span></span> : null}
        </div>
      </div>

      <section className="card">
        <h2 className="card-title">Markets in this event</h2>
        <ul className="space-y-2 text-sm">{(event.markets ?? []).map((m: any) => (
          <li key={m.id} className="row-link"><Link href={`/markets/condition/${m.conditionId}`} className="flex justify-between">
            <span className="text-zinc-100 max-w-2xl truncate">{m.question}</span>
            <span className="text-xs text-zinc-500 tabular-nums">{m.outcomePrices ? JSON.parse(m.outcomePrices).map((p: string) => Number(p).toFixed(3)).join(" / ") : ""}</span>
          </Link></li>
        ))}</ul>
      </section>
    </div>
  );
}
