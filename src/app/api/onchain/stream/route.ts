/**
 * Server-Sent Events stream of live Polymarket OrderFilled events.
 * Subscribes to both CTF Exchange contracts via viem WebSocket and forwards
 * to the client over SSE. Each connection holds one WebSocket — fine for
 * a local single-user app.
 */
import { subscribeOrderFilled, impliedPriceFromFill, type OnChainFill } from "@/lib/polymarket/onchain";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      send("status", { status: "connecting", ts: Date.now() });

      cleanup = subscribeOrderFilled({
        onStatus: (s) => send("status", { status: s, ts: Date.now() }),
        onFill: (fill: OnChainFill) => {
          const px = impliedPriceFromFill(fill);
          send("fill", { ...fill, price: px });
        },
      });

      // Heartbeat every 25s to keep proxies + UI alive.
      const hb = setInterval(() => send("heartbeat", { ts: Date.now() }), 25_000);
      const oldCleanup = cleanup;
      cleanup = () => {
        clearInterval(hb);
        oldCleanup?.();
      };
    },
    cancel() {
      closed = true;
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
