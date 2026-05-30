import type { DriftReport, LocalOrderRecord, RemoteOrderRecord } from "./types";

/**
 * Pure diff between local order state and venue truth. Easy to unit-test
 * without spinning up the venue clients.
 *
 * Considered a drift if:
 *   - local says OPEN but the venue doesn't know it (broker_order_id absent remote)
 *   - venue has an order our DB doesn't (we crashed mid-submit)
 *   - status diverges (FILLED vs OPEN, CANCELLED vs OPEN, etc.)
 *   - filled_size or avg_price meaningfully changed (partial fills)
 */
export function diffOrders(local: LocalOrderRecord[], remote: RemoteOrderRecord[]): DriftReport[] {
  const reports: DriftReport[] = [];
  const remoteById = new Map(remote.map((r) => [r.brokerOrderId, r]));
  const localById = new Map(local.map((l) => [l.brokerOrderId, l]));

  // Local entries — check for drift vs remote truth
  for (const l of local) {
    const r = remoteById.get(l.brokerOrderId);
    if (!r) {
      // If we still think it's OPEN but the venue lost it → drift.
      if (isOpen(l.status)) {
        reports.push({ brokerOrderId: l.brokerOrderId, kind: "missing_remotely", local: l, remote: null });
      }
      continue;
    }
    if (normalizeStatus(l.status) !== normalizeStatus(r.status)) {
      reports.push({ brokerOrderId: l.brokerOrderId, kind: "status_changed", local: l, remote: r });
      continue; // skip subsequent diff kinds — status is the master drift
    }
    if (
      l.filledSize != null && r.filledSize != null &&
      Math.abs(Number(l.filledSize) - Number(r.filledSize)) > 1e-9
    ) {
      reports.push({ brokerOrderId: l.brokerOrderId, kind: "fill_size_changed", local: l, remote: r });
      continue;
    }
    if (
      l.averagePrice != null && r.averagePrice != null &&
      Math.abs(Number(l.averagePrice) - Number(r.averagePrice)) > 1e-9
    ) {
      reports.push({ brokerOrderId: l.brokerOrderId, kind: "price_changed", local: l, remote: r });
    }
  }

  // Remote entries we've never seen locally
  for (const r of remote) {
    if (!localById.has(r.brokerOrderId)) {
      reports.push({ brokerOrderId: r.brokerOrderId, kind: "missing_locally", local: null, remote: r });
    }
  }

  return reports;
}

function isOpen(status: string): boolean {
  const s = status.toUpperCase();
  return s === "OPEN" || s === "PENDING" || s === "SUBMITTING" || s === "SUBMITTED";
}

function normalizeStatus(status: string): string {
  return status.toUpperCase();
}
