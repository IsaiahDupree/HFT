/**
 * Shared arena types — DB row shapes + signal/position records used by
 * sim.ts, score.ts, mutate.ts, and the lifecycle scripts.
 */
import type { Genome } from "./genome";

export type Venue = "sim-poly" | "sim-coinbase";

export type Position = {
  venue: Venue;
  market_id: string;
  side: "BUY" | "SELL";
  size_usd: number;
  entry_price: number;
  opened_at: string;        // ISO timestamp
  entry_trade_id?: number;
  // Optional snapshot of the genome's exit rules captured at entry so a later
  // mutation to the agent doesn't retroactively change how the position closes.
  target_price?: number;
  stop_price?: number;
  time_stop_at?: string;
  // ----------------------------------------------------------------------
  // Live-routing audit trail.
  // ----------------------------------------------------------------------
  // When the live capsule path actually filled an order on Polymarket (or
  // Coinbase), we capture which token/product was filled, the actual shares
  // executed, and the broker order id. The arena sim's `market_id` records
  // the genome's *intent* (always the YES token for binaries); these fields
  // record the *execution* (could be the NO token if SELL→BUY-NO swapped).
  // Used by:
  //   - resolveBinary to compute live-side PnL using actual fill data
  //   - live EXIT path to know which token to SELL
  //   - reconciler to match CLOB fills to arena positions
  live_token_id?: string;         // actual filled token (= market_id, or NO token)
  live_filled_shares?: number;    // actual shares filled (post-FOK)
  live_paid_usd?: number;         // notional paid (could differ from size_usd)
  live_broker_order_id?: string;
  /** The clientOrderId we submitted. Stored alongside broker_order_id so the
   *  reconciler can match by either field — CLOB's /data/trades response may
   *  expose the broker's internal id under a different field on different SDK
   *  versions, and client_order_id is the one we control. */
  live_client_order_id?: string;
};

/** A genome's belief about the true probability of the YES outcome (sim-poly
 *  only). When attached to an entry signal, the EV+Kelly risk wrapper engages
 *  automatically — gating on EV >= minEv and resizing via Quarter Kelly.
 *  Genomes without a probability model (rule-based momentum, mean-reversion,
 *  etc.) leave this undefined and the rail is a no-op pass-through. */
export type PTrueEstimate = {
  pTrue: number;                          // 0..1, P(YES)
  confidence?: "high" | "medium" | "low";
  source?: string;                        // "llm-oracle" | "wallet-copy" | "bayesian-update" | …
};

export type Signal =
  | { kind: "entry"; venue: Venue; market_id: string; side: "BUY" | "SELL"; size_usd: number; rationale: string; target_price?: number; stop_price?: number; time_stop_at?: string; pTrueEstimate?: PTrueEstimate }
  | { kind: "exit"; venue: Venue; market_id: string; rationale: string }
  | { kind: "hold" };

export type Snapshot = {
  // The tick context the sim engine hands a strategy. One row per market_id.
  venue: Venue;
  market_id: string;
  price: number;            // unified: poly midpoint OR coinbase mid (best_bid + best_ask)/2
  bid?: number;
  ask?: number;
  /** Polymarket-only: classified market category (geopolitics, elections, etc.).
   *  Populated by `classifyMarket` in the snapshot worker. category_specialist
   *  genomes filter their candidate list by this field. Undefined for Coinbase
   *  snapshots and for poly rows pre-dating the classifier. */
  category?: string;
  captured_at: string;
};

export type SnapshotWindow = {
  /** All snapshots from the lookback period, sorted oldest→newest. */
  history: Snapshot[];
  /** The single latest snapshot for this market. */
  latest: Snapshot;
};

export type TickContext = {
  now: string;                              // ISO timestamp of this tick
  snapshots: Map<string, SnapshotWindow>;   // keyed by market_id
  // Optional pre-computed helpers the sim may pass to expensive strategies.
  bsImpliedProb?: Map<string, number>;       // for cross_venue_arb
  polyImpliedProb?: Map<string, number>;
};

export type PaperAgentRow = {
  id: number;
  name: string;
  generation: number;
  parent_paper_agent_id: number | null;
  genome_json: string;
  introduced_by: string;
  cash_usd_start: number;
  cash_usd_current: number;
  position_basket_json: string;
  realized_pnl_usd: number;
  unrealized_pnl_usd: number;
  peak_equity_usd: number;
  max_drawdown_usd: number;
  trades_count: number;
  entries_count: number;
  wins_count: number;
  alive: 0 | 1;
  /** When 1, evolve() will not retire this agent at seal time even if outranked.
   *  See `runEvolveOnce` in evolve.ts + ARENA_ELITE_COUNT/ARENA_ELITE_MAX_DD_PCT. */
  is_elite: 0 | 1;
  retire_reason: string | null;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
};

export type GenerationRow = {
  id: number;
  gen_number: number;
  started_at: string;
  sealed_at: string | null;
  n_agents: number;
  n_alive_at_seal: number | null;
  n_promoted_children: number | null;
  top_paper_agent_id: number | null;
  top_score: number | null;
  replay_window_start: string | null;
  replay_window_end: string | null;
  notes: string | null;
};

export type PaperTradeRow = {
  id: number;
  paper_agent_id: number;
  venue: Venue;
  market_id: string;
  side: "BUY" | "SELL";
  intent: "entry" | "exit" | "hedge" | "rebalance";
  price: number;
  size_usd: number;
  fee_usd: number;
  realized_pnl_usd: number | null;
  linked_entry_id: number | null;
  signal_rationale: string | null;
  tick_at: string;
  generation: number;
  /** ENTRY rows: the shadow-gate decision_journal.id that produced this trade
   *  (for calibration). null when shadow-gating is off, or on exits. */
  decision_journal_id?: number | null;
};

/** Convenience: parsed agent with `genome` already deserialized. */
export type LiveAgent = PaperAgentRow & {
  genome: Genome;
  positions: Position[];
};
