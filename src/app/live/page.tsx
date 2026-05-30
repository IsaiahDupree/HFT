import { LiveStream } from "./LiveStream";
import { poly } from "@/lib/polymarket/client";

export const dynamic = "force-dynamic";

export default async function LivePage() {
  // Pick the top 6 sampling markets as default subscriptions.
  const sampling = await poly.samplingMarkets(6).catch(() => ({ data: [] as any[] }));
  const seeds = (sampling.data ?? [])
    .map((m: any) => {
      const yes = m.tokens?.find((t: any) => t.outcome === "Yes") ?? m.tokens?.[0];
      return yes?.token_id ? { tokenId: yes.token_id as string, question: m.question as string, outcome: yes.outcome as string } : null;
    })
    .filter(Boolean) as { tokenId: string; question: string; outcome: string }[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Live</h1>
        <p className="text-zinc-400 text-sm">Streaming top-of-book updates from the CLOB market websocket for the top sampling markets.</p>
      </div>
      <LiveStream seeds={seeds} />
    </div>
  );
}
