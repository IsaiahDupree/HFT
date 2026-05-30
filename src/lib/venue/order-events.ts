import { createHash } from "node:crypto";
import { db } from "@/lib/db/client";

/**
 * Append-only, hash-chained execution event log. SQLite analogue of
 * TradingBot/src/execution/order_event_log.py — same chain semantics, but
 * the rows live in the `order_events` table (defined in schema.sql) rather
 * than a JSONL file. Tampering with any past row breaks verifyChain() at
 * the first row whose recomputed hash no longer matches.
 */

export type OrderEventInput = {
  event: string;                       // 'submitting' | 'status_filled' | 'rejected_*' | 'cancelled' | 'reconcile_drift'
  venue: string;                       // 'polymarket' | 'coinbase' | 'sim'
  clientOrderId: string;
  brokerOrderId?: string;
  capsuleId?: string;
  agentId?: number;
  symbol?: string;
  side?: string;
  qty?: number;
  price?: number;
  status?: string;
  error?: string;
  metadata?: Record<string, unknown>;
};

export type OrderEventRow = {
  id: number;
  seq: number;
  event: string;
  venue: string;
  client_order_id: string;
  broker_order_id: string | null;
  capsule_id: string | null;
  agent_id: number | null;
  symbol: string | null;
  side: string | null;
  qty: number | null;
  price: number | null;
  status: string | null;
  error: string | null;
  metadata_json: string;
  prev_hash: string;
  hash: string;
  created_at: string;
};

function canonical(body: Record<string, unknown>): string {
  // Sort keys for deterministic JSON so the same payload always hashes the same.
  return JSON.stringify(body, Object.keys(body).sort());
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Append a chained event. Transactional, so concurrent writers can't interleave. */
export function appendOrderEvent(input: OrderEventInput): OrderEventRow {
  const handle = db();
  const tx = handle.transaction(() => {
    const lastRow = handle
      .prepare("SELECT seq, hash FROM order_events ORDER BY seq DESC LIMIT 1")
      .get() as { seq: number; hash: string } | undefined;

    const seq = (lastRow?.seq ?? -1) + 1;
    const prev_hash = lastRow?.hash ?? "";
    const payload = {
      seq,
      event: input.event,
      venue: input.venue,
      client_order_id: input.clientOrderId,
      broker_order_id: input.brokerOrderId ?? null,
      capsule_id: input.capsuleId ?? null,
      agent_id: input.agentId ?? null,
      symbol: input.symbol ?? null,
      side: input.side ?? null,
      qty: input.qty ?? null,
      price: input.price ?? null,
      status: input.status ?? null,
      error: input.error ?? null,
      metadata_json: JSON.stringify(input.metadata ?? {}),
      prev_hash,
    };
    const hash = sha256(canonical(payload));

    handle
      .prepare(
        `INSERT INTO order_events
           (seq, event, venue, client_order_id, broker_order_id, capsule_id, agent_id,
            symbol, side, qty, price, status, error, metadata_json, prev_hash, hash)
         VALUES
           (@seq, @event, @venue, @client_order_id, @broker_order_id, @capsule_id, @agent_id,
            @symbol, @side, @qty, @price, @status, @error, @metadata_json, @prev_hash, @hash)`,
      )
      .run({ ...payload, hash });

    return handle
      .prepare("SELECT * FROM order_events WHERE seq = ?")
      .get(seq) as OrderEventRow;
  });
  return tx();
}

export function listOrderEvents(opts: { limit?: number; venue?: string; clientOrderId?: string } = {}): OrderEventRow[] {
  const limit = opts.limit ?? 100;
  let sql = "SELECT * FROM order_events";
  const wh: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.venue) {
    wh.push("venue = @venue");
    params.venue = opts.venue;
  }
  if (opts.clientOrderId) {
    wh.push("client_order_id = @coid");
    params.coid = opts.clientOrderId;
  }
  if (wh.length) sql += " WHERE " + wh.join(" AND ");
  sql += " ORDER BY seq DESC LIMIT @limit";
  params.limit = limit;
  return db().prepare(sql).all(params) as OrderEventRow[];
}

/** Walk the chain forward and recompute every hash. Returns brokenAtSeq when invalid. */
export function verifyChain(): {
  ok: boolean;
  nChecked: number;
  brokenAtSeq: number | null;
  lastSeq: number;
  lastHash: string;
} {
  const rows = db().prepare("SELECT * FROM order_events ORDER BY seq ASC").all() as OrderEventRow[];
  let prev = "";
  let nChecked = 0;
  let brokenAtSeq: number | null = null;
  let lastSeq = -1;
  let lastHash = "";
  for (const r of rows) {
    const recomputed = sha256(
      canonical({
        seq: r.seq,
        event: r.event,
        venue: r.venue,
        client_order_id: r.client_order_id,
        broker_order_id: r.broker_order_id,
        capsule_id: r.capsule_id,
        agent_id: r.agent_id,
        symbol: r.symbol,
        side: r.side,
        qty: r.qty,
        price: r.price,
        status: r.status,
        error: r.error,
        metadata_json: r.metadata_json,
        prev_hash: r.prev_hash,
      }),
    );
    if (recomputed !== r.hash || (prev && r.prev_hash !== prev)) {
      brokenAtSeq = r.seq;
      break;
    }
    prev = r.hash;
    lastSeq = r.seq;
    lastHash = r.hash;
    nChecked++;
  }
  return { ok: brokenAtSeq == null, nChecked, brokenAtSeq, lastSeq, lastHash };
}
