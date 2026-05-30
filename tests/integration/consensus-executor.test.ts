/**
 * Integration test for the consensus auto-executor.
 *
 * Stubs the venue router and exercises pollOnce(): given a consensus-signal
 * event in evolution_log, the executor builds an order and dispatches it,
 * writes a consensus-auto-exec event, and never re-executes the same signal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMemoryDb } from "../helpers/db";

let memDb: ReturnType<typeof makeMemoryDb> | null = null;

vi.mock("@/lib/db/client", () => ({
  db: () => {
    if (!memDb) memDb = makeMemoryDb();
    return memDb;
  },
  closeDb: () => {
    memDb?.close();
    memDb = null;
  },
}));

const submitSpy = vi.fn(async (_order: any) => ({
  ok: true,
  status: "filled",
  brokerOrderId: "SIM-test",
  usdEquivalent: 10,
}));

vi.mock("@/lib/venue/router", () => ({
  getDefaultRouter: () => ({
    submit: submitSpy,
  }),
}));

import * as dbModule from "@/lib/db/client";
import { insertEvolutionEvent } from "@/lib/db/queries";

beforeEach(() => {
  memDb?.close();
  memDb = null;
  submitSpy.mockClear();
});
afterEach(() => {
  memDb?.close();
  memDb = null;
});

function seedSignal(
  marketKey: string,
  direction: string,
  opts: { avgPrice?: number; walletCount?: number; effective?: number } = {},
): number {
  insertEvolutionEvent({
    event_type: "consensus-signal",
    summary: `consensus signal on ${marketKey}`,
    payload_json: JSON.stringify({
      marketKey,
      direction,
      marketTitle: marketKey,
      avgPrice: opts.avgPrice ?? 0.5,
      walletCount: opts.walletCount ?? 3,
      effectiveWallets: opts.effective ?? 3,
      wallets: [],
      clusterIds: [],
    }),
  });
  const row = (dbModule as any)
    .db()
    .prepare("SELECT id FROM evolution_log ORDER BY id DESC LIMIT 1")
    .get();
  return row.id;
}

describe("consensus auto-executor — pollOnce", () => {
  it("dispatches an order for each new consensus-signal event", async () => {
    seedSignal("cond-1", "YES", { avgPrice: 0.45 });
    const { pollOnce } = await import("../../scripts/worker-consensus-executor.ts");
    const result = await pollOnce();
    expect(result.executed).toBe(1);
    expect(submitSpy).toHaveBeenCalledOnce();
    const order = submitSpy.mock.calls[0][0];
    expect(order.symbol).toBe("cond-1");
    expect(order.side).toBe("BUY");
    expect(order.refPrice).toBe(0.45);
    expect(order.venue).toBe("sim"); // default unless CONSENSUS_AUTO_EXEC_LIVE=1
  });

  it("never re-executes the same signal (dedup by signal ID)", async () => {
    seedSignal("cond-2", "NO");
    const { pollOnce } = await import("../../scripts/worker-consensus-executor.ts");
    const a = await pollOnce();
    const b = await pollOnce();
    expect(a.executed).toBe(1);
    expect(b.executed).toBe(0);
    expect(b.skipped).toBeGreaterThanOrEqual(1);
    expect(submitSpy).toHaveBeenCalledOnce();
  });

  it("writes a consensus-auto-exec event with the signal ID for audit", async () => {
    const signalId = seedSignal("cond-3", "YES");
    const { pollOnce } = await import("../../scripts/worker-consensus-executor.ts");
    await pollOnce();
    const executed = (dbModule as any)
      .db()
      .prepare("SELECT payload_json FROM evolution_log WHERE event_type = 'consensus-auto-exec'")
      .all();
    expect(executed).toHaveLength(1);
    const payload = JSON.parse(executed[0].payload_json);
    expect(payload.signalId).toBe(signalId);
    expect(payload.mode).toBe("sim");
  });

  it("enforces the daily cap (DAILY_CAP=5 by default)", async () => {
    for (let i = 0; i < 7; i++) seedSignal(`cond-${i}`, "YES");
    const { pollOnce } = await import("../../scripts/worker-consensus-executor.ts");
    const result = await pollOnce();
    expect(result.executed).toBe(5);
    expect(submitSpy).toHaveBeenCalledTimes(5);
  });

  it("returns empty result when no recent signals", async () => {
    const { pollOnce } = await import("../../scripts/worker-consensus-executor.ts");
    const result = await pollOnce();
    expect(result).toEqual({ checked: 0, executed: 0, skipped: 0 });
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("skips signals with malformed payload but doesn't crash", async () => {
    // Insert a deliberately-bad signal
    (dbModule as any).db().prepare(
      `INSERT INTO evolution_log (event_type, summary, payload_json) VALUES (?, ?, ?)`,
    ).run("consensus-signal", "bad", "not json {{{");
    seedSignal("good-cond", "YES");
    const { pollOnce } = await import("../../scripts/worker-consensus-executor.ts");
    const result = await pollOnce();
    expect(result.executed).toBe(1);
    expect(result.skipped).toBe(1);
  });
});
