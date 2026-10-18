export type LocalOrderRecord = {
  brokerOrderId: string;
  status: string;       // local view (e.g. coinbase_orders.status)
  filledSize?: number;
  averagePrice?: number;
  rawJson?: string | null;
};

export type RemoteOrderRecord = {
  brokerOrderId: string;
  status: string;       // venue truth
  filledSize?: number;
  averagePrice?: number;
};

export type DriftKind =
  | "missing_locally"            // venue has it, our DB doesn't
  | "missing_remotely"           // we think it's OPEN, venue doesn't know it
  | "status_changed"             // status mismatch
  | "fill_size_changed"          // partial-fill caught
  | "price_changed";             // avg fill price diverged

export type DriftReport = {
  brokerOrderId: string;
  kind: DriftKind;
  local: LocalOrderRecord | null;
  remote: RemoteOrderRecord | null;
};

export type ReconcileSummary = {
  venue: string;
  scannedLocal: number;
  scannedRemote: number;
  drifts: DriftReport[];
  durationMs: number;
};
