/**
 * Pure (DB-touching but no network) reconciliation logic for matching
 * Polymarket CLOB fills back to paper-agent positions. Extracted from
 * `scripts/reconcile-polymarket-fills.ts` so the matching algorithm is
 * unit-testable without running a live API call.
 *
 * Matching policy:
 *   For each open Position with `live_broker_order_id` and/or
 *   `live_client_order_id` but no confirmed `live_filled_shares`, look up
 *   the trades whose taker/maker/client order id field equals EITHER stored
 *   id. CLOB SDKs vary in which field they populate, so trying both is the
 *   safer bet — and we already control the client_order_id at submit time.
 */
import { db } from "@/lib/db/client";
import type { PaperAgentRow, Position } from "./types";

export type ClobTrade = {
  taker_order_id?: string;
  maker_order_id?: string;
  client_order_id?: string;
  market?: string;
  asset_id?: string;
  side?: string;
  size?: string;
  price?: string;
  trade_id?: string;
  timestamp?: number;
};

export type UnreconciledPos = {
  agentId: number;
  agentName: string;
  positionIdx: number;
  brokerOrderId?: string;
  clientOrderId?: string;
};

export type FillAggregate = {
  shares: number;
  usd: number;
  trade_ids: string[];
};

/** Build the per-id fill aggregate. A single order may produce multiple trade
 *  rows (partial fills). We aggregate shares + USD per id. */
export function aggregateFillsById(trades: ClobTrade[]): Map<string, FillAggregate> {
  const out = new Map<string, FillAggregate>();
  for (const t of trades) {
    const shares = Number(t.size ?? 0);
    const price = Number(t.price ?? 0);
    if (!Number.isFinite(shares) || !Number.isFinite(price) || shares <= 0) continue;
    // Index the trade under every id field present, so lookups by either
    // broker or client id resolve.
    const ids = [t.taker_order_id, t.maker_order_id, t.client_order_id].filter(Boolean) as string[];
    for (const id of ids) {
      const cur = out.get(id) ?? { shares: 0, usd: 0, trade_ids: [] };
      cur.shares += shares;
      cur.usd += shares * price;
      if (t.trade_id) cur.trade_ids.push(t.trade_id);
      out.set(id, cur);
    }
  }
  return out;
}

/** List alive agents that own positions tagged with a live order id. */
export function listUnreconciledPositions(): UnreconciledPos[] {
  // SQL `LIKE` filter narrows to agents that hold a live position; the JSON
  // walk below picks out the specific positions inside the basket.
  const agents = db().prepare(
    `SELECT * FROM paper_agents
       WHERE alive = 1
         AND (position_basket_json LIKE '%live_broker_order_id%'
              OR position_basket_json LIKE '%live_client_order_id%')`,
  ).all() as PaperAgentRow[];
  const out: UnreconciledPos[] = [];
  for (const a of agents) {
    const positions = JSON.parse(a.position_basket_json) as Position[];
    positions.forEach((p, i) => {
      const hasFill = p.live_filled_shares != null && p.live_filled_shares > 0;
      if (hasFill) return;
      if (!p.live_broker_order_id && !p.live_client_order_id) return;
      out.push({
        agentId: a.id,
        agentName: a.name,
        positionIdx: i,
        brokerOrderId: p.live_broker_order_id,
        clientOrderId: p.live_client_order_id,
      });
    });
  }
  return out;
}

/** Find a fill aggregate matching either of the position's known order ids. */
export function findMatchingFill(
  fills: Map<string, FillAggregate>,
  u: UnreconciledPos,
): FillAggregate | null {
  if (u.brokerOrderId && fills.has(u.brokerOrderId)) return fills.get(u.brokerOrderId)!;
  if (u.clientOrderId && fills.has(u.clientOrderId)) return fills.get(u.clientOrderId)!;
  return null;
}

/** Write the reconciled fill data onto the position. Returns whether the row was updated. */
export function writeReconciledFill(
  agentId: number, positionIdx: number, fill: FillAggregate,
): boolean {
  const row = db().prepare(
    `SELECT position_basket_json FROM paper_agents WHERE id = ?`,
  ).get(agentId) as { position_basket_json: string } | undefined;
  if (!row) return false;
  const positions = JSON.parse(row.position_basket_json) as Position[];
  const p = positions[positionIdx];
  if (!p) return false;
  p.live_filled_shares = fill.shares;
  if (fill.shares > 0) p.live_paid_usd = fill.usd;
  db().prepare(
    `UPDATE paper_agents SET position_basket_json = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(JSON.stringify(positions), agentId);
  return true;
}

export type ReconcileSummary = {
  unreconciled_count: number;
  matched: number;
  written: number;
  no_match: number;
};

/** Pure entrypoint — caller supplies the trades list (so tests can inject
 *  fixtures without hitting the network). Returns a summary. */
export function reconcileFills(trades: ClobTrade[]): ReconcileSummary {
  const fills = aggregateFillsById(trades);
  const open = listUnreconciledPositions();
  let matched = 0, written = 0, noMatch = 0;
  for (const u of open) {
    const fill = findMatchingFill(fills, u);
    if (!fill) { noMatch += 1; continue; }
    matched += 1;
    if (writeReconciledFill(u.agentId, u.positionIdx, fill)) written += 1;
  }
  return { unreconciled_count: open.length, matched, written, no_match: noMatch };
}
