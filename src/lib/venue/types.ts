/**
 * Venue abstraction — unified Order/Verdict shapes across Polymarket + Coinbase
 * (and any future venue). Mirrors TradingBot/src/execution/order.py and
 * adapters/base.py, retyped for TypeScript.
 *
 * Why one shape: the same Order flows through sim, paper, and live modes; only
 * the adapter behind the router changes. This is what makes the
 * sim → paper → live promotion ladder safe.
 */

export type OrderSide = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT" | "FOK_BASKET";
export type OrderStatus = "pending" | "submitting" | "filled" | "partially_filled" | "cancelled" | "rejected" | "expired";
export type ExecuteMode = "DRY_RUN" | "LIVE";

export type UnifiedOrder = {
  /** Idempotency key; deduped by the router. */
  clientOrderId: string;
  /** 'polymarket' | 'coinbase' | 'sim' | 'paper' (also drives adapter selection). */
  venue: string;
  /** Token id / product id / asset symbol. */
  symbol: string;
  side: OrderSide;
  type: OrderType;
  /** For BUY: usually USD notional. For SELL: asset quantity. Adapter-specific. */
  size: number;
  /** Reference price for risk checks (last/mid). For market orders, callers pass last-known. */
  refPrice: number;
  /** Optional limit price for LIMIT orders. */
  limitPrice?: number;
  /** Capsule binding for per-agent risk envelope. */
  capsuleId?: string;
  /** Provenance — agent/strategy this order belongs to. */
  agentId?: number;
  strategyId?: number;
  strategyVersionId?: number;
  /** Free-form. Adapter-specific extras (e.g. arb basket shares, FOK). */
  metadata?: Record<string, unknown>;
};

export type SubmitOk = {
  ok: true;
  /** Adapter's order id (or composite for multi-leg). */
  brokerOrderId?: string;
  status: OrderStatus;
  /** Adapter-specific raw response (CLOB createOrder, Coinbase createOrder, etc.) */
  raw?: unknown;
  /** Best-effort USD equivalent for cap accounting + reporting. */
  usdEquivalent: number;
};

export type SubmitRejected = {
  ok: false;
  /** Stable code: HALTED | CAPSULE_* | RISK_* | ADAPTER_ERROR | NO_ADAPTER | INVALID_INPUT */
  code: string;
  reason: string;
  /** Always present so logging always has _something_. */
  usdEquivalent?: number;
};

export type SubmitDryRun = {
  ok: true;
  status: "dry_run";
  reason: string;
  usdEquivalent: number;
};

export type SubmitVerdict = SubmitOk | SubmitRejected | SubmitDryRun;

/**
 * Capability flags borrowed from ccxt's `exchange.has = { ... }` pattern.
 * The router consults these before submitting so it can short-circuit with
 * UNSUPPORTED instead of asking the adapter to handle something it can't.
 */
export type VenueCapabilities = {
  market: boolean;          // accepts type=MARKET
  limit: boolean;           // accepts type=LIMIT
  fok: boolean;             // accepts type=FOK_BASKET (Polymarket-only today)
  cancel: boolean;          // supports cancel(brokerOrderId)
  cancelAll: boolean;       // supports cancelAll() (kill switch needs this)
  userChannelWs: boolean;   // exposes an authenticated user channel for fills
};

export interface VenueAdapter {
  /** Stable name used for routing + kill-switch registration. */
  readonly name: string;
  /** Per-feature support — see VenueCapabilities. Defaults assumed false. */
  readonly capabilities: VenueCapabilities;
  /** True when credentials/env are present and the adapter can submit. */
  isAvailable(): boolean;
  /** Submit a single order. Honors any venue-internal safety gates (e.g. ALLOW_TRADE). */
  submit(order: UnifiedOrder): Promise<SubmitVerdict>;
  /** Cancel a single broker order. */
  cancel(brokerOrderId: string): Promise<{ ok: boolean; error?: string; raw?: unknown }>;
  /** Cancel every open order on this venue (used by the kill switch). */
  cancelAll(): Promise<{ ok: boolean; cancelled: number; error?: string; raw?: unknown }>;
  /** Optional read-only sanity check. */
  health?(): Promise<{ ok: boolean; name: string; details?: Record<string, unknown> }>;
}
