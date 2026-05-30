/**
 * Consensus auto-executor — long-running worker.
 *
 *   npm run worker:consensus-exec
 *   CONSENSUS_AUTO_EXEC_LIVE=1 npm run worker:consensus-exec   # arm live (CAREFUL)
 *
 * Polls evolution_log for new `consensus-signal` events. For each unseen
 * one, builds a UnifiedOrder and submits through ExecutionRouter. The
 * router's capsule + risk + halt gates still apply — there is no path
 * here that bypasses safety; this just composes existing pieces.
 *
 * Defaults are conservative:
 *   - venue = 'sim' (no money) unless CONSENSUS_AUTO_EXEC_LIVE=1 → 'polymarket'
 *   - per-signal USD cap = $10            (CONSENSUS_AUTO_EXEC_USD)
 *   - daily cap          = 5 signals/day  (CONSENSUS_AUTO_EXEC_DAILY)
 *   - poll interval      = 30s            (CONSENSUS_AUTO_EXEC_POLL_MS)
 *   - capsule binding    = "consensus-auto" (CONSENSUS_AUTO_EXEC_CAPSULE)
 *
 * Idempotency: dedup key = signal event ID. If the capsule isn't configured
 * the router rejects with CAPSULE_NOT_FOUND and the executor logs it; the
 * signal is still marked attempted so we don't spin on a failing setup.
 */
import { randomUUID } from "node:crypto";
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { insertEvolutionEvent } from "../src/lib/db/queries.ts";
import { getDefaultRouter } from "../src/lib/venue/router.ts";
import type { UnifiedOrder } from "../src/lib/venue/types.ts";

const LIVE =
  process.env.CONSENSUS_AUTO_EXEC_LIVE === "1" || process.env.CONSENSUS_AUTO_EXEC_LIVE === "true";
const PER_SIGNAL_USD = Number(process.env.CONSENSUS_AUTO_EXEC_USD ?? 10);
const DAILY_CAP = Number(process.env.CONSENSUS_AUTO_EXEC_DAILY ?? 5);
const POLL_MS = Number(process.env.CONSENSUS_AUTO_EXEC_POLL_MS ?? 30_000);
const CAPSULE_ID = process.env.CONSENSUS_AUTO_EXEC_CAPSULE ?? "consensus-auto";
const VENUE = LIVE ? "polymarket" : "sim";

console.log("[consensus-exec] starting");
console.log(`  mode:          ${LIVE ? "LIVE (CAREFUL!)" : "sim (no money)"}`);
console.log(`  venue:         ${VENUE}`);
console.log(`  per-signal:    $${PER_SIGNAL_USD}`);
console.log(`  daily cap:     ${DAILY_CAP} signals`);
console.log(`  poll:          ${POLL_MS}ms`);
console.log(`  capsule:       ${CAPSULE_ID}`);

let stopped = false;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function pollOnce(): Promise<{ checked: number; executed: number; skipped: number }> {
  const handle = db();
  const today = todayUtc();
  const todayCount = (
    handle
      .prepare(
        "SELECT COUNT(*) AS n FROM evolution_log WHERE event_type = 'consensus-auto-exec' AND date(created_at) = ?",
      )
      .get(today) as { n: number }
  ).n;
  if (todayCount >= DAILY_CAP) {
    console.log(`[consensus-exec] daily cap hit (${todayCount}/${DAILY_CAP}); idling`);
    return { checked: 0, executed: 0, skipped: 0 };
  }

  const signals = handle
    .prepare(
      `SELECT id, summary, payload_json, created_at
         FROM evolution_log
        WHERE event_type = 'consensus-signal'
          AND created_at >= datetime('now', '-30 minutes')
        ORDER BY created_at ASC`,
    )
    .all() as Array<{ id: number; summary: string; payload_json: string; created_at: string }>;
  if (signals.length === 0) return { checked: 0, executed: 0, skipped: 0 };

  const executedRows = handle
    .prepare("SELECT payload_json FROM evolution_log WHERE event_type = 'consensus-auto-exec'")
    .all() as Array<{ payload_json: string }>;
  const executedIds = new Set<number>();
  for (const e of executedRows) {
    try {
      executedIds.add(JSON.parse(e.payload_json).signalId);
    } catch {
      /* ignore */
    }
  }

  const router = getDefaultRouter();
  let executed = 0;
  let skipped = 0;
  for (const sig of signals) {
    if (executedIds.has(sig.id)) {
      skipped++;
      continue;
    }
    const stillUnderCap =
      (
        handle
          .prepare(
            "SELECT COUNT(*) AS n FROM evolution_log WHERE event_type = 'consensus-auto-exec' AND date(created_at) = ?",
          )
          .get(today) as { n: number }
      ).n < DAILY_CAP;
    if (!stillUnderCap) break;

    let signal: any;
    try {
      signal = JSON.parse(sig.payload_json);
    } catch (e) {
      console.error(`[consensus-exec] bad payload on signal ${sig.id}: ${(e as Error).message}`);
      skipped++;
      continue;
    }

    const refPrice = Number(signal.avgPrice) || 0.5;
    const order: UnifiedOrder = {
      clientOrderId: `consensus-${sig.id}-${randomUUID().slice(0, 8)}`,
      venue: VENUE,
      symbol: String(signal.marketKey ?? ""),
      side: "BUY",
      type: "MARKET",
      size: PER_SIGNAL_USD / Math.max(0.01, refPrice),
      refPrice,
      capsuleId: CAPSULE_ID,
      metadata: {
        source: "consensus-auto-exec",
        signalId: sig.id,
        signalDirection: signal.direction,
        signalWallets: signal.walletCount ?? signal.wallets?.length,
        signalEffective: signal.effectiveWallets,
        signalClusters: signal.clusterIds,
      },
    };

    try {
      const verdict = await router.submit(order);
      const ok = verdict.ok;
      const status = ok && "status" in verdict ? verdict.status : verdict.code;
      console.log(
        `[consensus-exec] signal ${sig.id} → ${status} (${signal.direction} ${String(signal.marketKey).slice(0, 16)}…)`,
      );
      insertEvolutionEvent({
        event_type: "consensus-auto-exec",
        summary: `auto-exec signal ${sig.id}: ${status} ${signal.direction} ${String(
          signal.marketTitle ?? signal.marketKey,
        ).slice(0, 50)}`,
        payload_json: JSON.stringify({
          signalId: sig.id,
          mode: VENUE,
          orderUsd: PER_SIGNAL_USD,
          verdict: ok
            ? { status, brokerOrderId: "brokerOrderId" in verdict ? verdict.brokerOrderId : undefined }
            : { status, reason: verdict.reason },
        }),
      });
      executed++;
    } catch (err) {
      console.error(`[consensus-exec] signal ${sig.id} threw: ${(err as Error).message}`);
      insertEvolutionEvent({
        event_type: "consensus-auto-exec",
        summary: `auto-exec signal ${sig.id} FAILED: ${(err as Error).message}`,
        payload_json: JSON.stringify({ signalId: sig.id, error: (err as Error).message }),
      });
      executed++;
    }
  }
  return { checked: signals.length, executed, skipped };
}

async function main(): Promise<void> {
  await pollOnce();
  while (!stopped) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      await pollOnce();
    } catch (e) {
      console.error("[consensus-exec] poll error:", e);
    }
  }
}

if (process.argv[1]?.endsWith("worker-consensus-executor.ts")) {
  process.on("SIGINT", () => {
    stopped = true;
    console.log("[consensus-exec] stopping (SIGINT)");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stopped = true;
    process.exit(0);
  });
  main().catch((err) => {
    console.error("[consensus-exec] FATAL:", err);
    process.exit(1);
  });
}
