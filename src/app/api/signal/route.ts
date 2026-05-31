/**
 * POST /api/signal — intake for the polymarket-2dollar-bot golden-window signal.
 *
 * Pipeline (defense in depth):
 *   1. auth (ARENA_API_TOKEN unless NEXT_PUBLIC_ALLOW_UNAUTHED_LOCAL)
 *   2. zod validate → planFromSignal (readiness_ok gate + per-trade cap + side/token)
 *   3. JOURNAL every signal to signal_intake (shadow record, always)
 *   4. route to submitSingleSideMarket ONLY when SIGNAL_INTAKE_ENABLED=1; otherwise
 *      journal-only ("shadow"). Downstream, submitSingleSideMarket itself DRY-RUNs
 *      unless ALLOW_TRADE=1 — so a real order needs BOTH switches plus the 2dollar
 *      readiness gate plus MAX_TRADE_USD. ALLOW_TRADE is never touched here.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { planFromSignal, regimeOf } from "@/lib/signal/intake";
import { submitSingleSideMarket } from "@/lib/polymarket/execute";
import { db } from "@/lib/db/client";

const sigSchema = z.object({
  source: z.string().optional(),
  asset: z.string().optional(),
  recurrence: z.string().optional(),
  side: z.string(),
  size_usd: z.number().optional(),
  token_id: z.string().optional(),
  entry_price: z.number().optional(),
  est_win_prob: z.number().optional(),
  edge: z.number().optional(),
  readiness_ok: z.boolean().optional(),
  window_end_ts: z.number().optional(),
});

function authed(req: Request): boolean {
  if (process.env.NEXT_PUBLIC_ALLOW_UNAUTHED_LOCAL === "1") return true;
  const tok = process.env.ARENA_API_TOKEN;
  if (!tok) return true; // no token configured → local-only
  return req.headers.get("authorization") === `Bearer ${tok}`;
}

function journal(sig: z.infer<typeof sigSchema>, accepted: boolean, reason: string,
                 routed: boolean, verdict: unknown): void {
  try {
    db().prepare(
      `INSERT INTO signal_intake
        (received_at, source, asset, recurrence, side, size_usd, entry_price, window_end_ts, est_win_prob, readiness_ok, accepted, reason, routed, verdict_json)
       VALUES (@received_at,@source,@asset,@recurrence,@side,@size_usd,@entry_price,@window_end_ts,@est_win_prob,@readiness_ok,@accepted,@reason,@routed,@verdict_json)`,
    ).run({
      received_at: Math.floor(Date.now() / 1000),
      source: sig.source ?? null, asset: sig.asset ?? null, recurrence: sig.recurrence ?? null,
      side: sig.side ?? null, size_usd: sig.size_usd ?? null, entry_price: sig.entry_price ?? null,
      window_end_ts: sig.window_end_ts ?? null,
      est_win_prob: sig.est_win_prob ?? null, readiness_ok: sig.readiness_ok ? 1 : 0,
      accepted: accepted ? 1 : 0, reason, routed: routed ? 1 : 0,
      verdict_json: verdict ? JSON.stringify(verdict) : null,
    });
  } catch {
    /* journal is best-effort */
  }
}

export async function POST(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = sigSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const sig = parsed.data;

  const maxTradeUsd = Number(process.env.MAX_TRADE_USD ?? "2");
  // SIGNAL_INTAKE_ALLOW = comma-separated "ASSET:rec" (e.g. "SOL:5m"). When set,
  // ONLY those regimes may route — everything else is rejected. This is how live
  // trading is restricted to one coin+window with no trades against the others.
  const allow = (process.env.SIGNAL_INTAKE_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const plan = planFromSignal(sig, { maxTradeUsd, allow });

  if (!plan.accepted) {
    journal(sig, false, plan.reason, false, null);
    return NextResponse.json({ accepted: false, reason: plan.reason });
  }

  // Journal-only unless explicitly enabled. Even when enabled, submitSingleSideMarket
  // DRY-RUNs until ALLOW_TRADE=1 — so this never posts a real order by itself.
  if (process.env.SIGNAL_INTAKE_ENABLED !== "1") {
    journal(sig, true, "SIGNAL_INTAKE_ENABLED!=1 — journaled, not routed", false, plan.order);
    return NextResponse.json({ accepted: true, routed: false, mode: "shadow", order: plan.order });
  }

  // ONE ORDER PER WINDOW: the emitter posts every loop cycle and a window stays
  // qualifying for tens of seconds — without this, a single window fires multiple
  // orders. Reject if we've already ROUTED this (asset,recurrence,window_end_ts).
  if (sig.window_end_ts != null) {
    try {
      const dup = db().prepare(
        `SELECT 1 FROM signal_intake WHERE asset=? AND recurrence=? AND window_end_ts=? AND routed=1 LIMIT 1`,
      ).get(sig.asset ?? null, sig.recurrence ?? null, sig.window_end_ts);
      if (dup) {
        const reason = `window ${regimeOf(sig)}@${sig.window_end_ts} already routed — dedup`;
        journal(sig, true, reason, false, null);
        return NextResponse.json({ accepted: true, routed: false, mode: "dedup", reason });
      }
    } catch {
      /* if the dedup query fails, fall through (the per-trade + daily caps still apply) */
    }
  }

  const verdict = await submitSingleSideMarket(plan.order!);
  journal(sig, true, plan.reason, true, verdict);
  return NextResponse.json({ accepted: true, routed: true, verdict });
}
