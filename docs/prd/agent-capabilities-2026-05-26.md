# PRD — Agent capabilities expansion (2026-05-26)

**Status:** approved-for-build
**Owner:** Isaiah Dupree
**Sequencing:** This is the prerequisite for `strategies-2026-05-26.md`. Build this first so the 3 new strategies have a consumer.

---

## Problem

We just shipped the wallet-intelligence stack (typology classifier, observer, consensus, trade-features) and we're about to ship 3 new strategy signals (near-resolution scraper, cross-timeframe spread, orderbook imbalance). Agents see **none** of this through `AgentContext` today. They get capsules + risk limits + recent order events + last backtest — but no signal context.

That means our agents (research-loop, oracle-llm evaluator, future strategy composer) will propose decisions without visibility into:
- Which wallets we're tracking and how they're classified
- What cross-wallet consensus is firing right now
- What individual-trade classifications the observer is producing
- What strategy opportunities the scanners are emitting

This is a silent capability gap. Agents will keep doing their old job without ever leveraging the new signal sources.

---

## Goals

1. Surface every meaningful evolution_log event type to agents via a bounded, JSON-serializable AgentContext extension.
2. Update `summarizeContext()` so log lines flag when a fresh signal is available.
3. Update `oracle-llm` prompt template so the LLM evaluator can reason about the new signals.
4. Zero schema breakage — existing AgentContext consumers see the new fields as additive, never required.

---

## Non-goals

- **Agents executing strategies directly.** Strategies emit signals; agents read them; execution still goes through the venue router + capsules + stages. No bypass.
- **Re-architecting the agent runtime.** This is a pure data-surface expansion, not a behavior change.
- **Real-time push to agents.** Agents pull AgentContext at decision time; no observer-to-agent push.
- **Per-agent filtering.** Every agent sees all signals. Agent-specific filtering is a future optimization.

---

## New AgentContext fields

All bounded to the last N events (default 20 each). All read from `evolution_log` with one query per event type.

### `recentTypologies: TypologyEventBrief[]`
```ts
export type TypologyEventBrief = {
  wallet: string;
  primaryBucket: WalletTypologyBucket;
  copyabilityClass: CopyabilityClass;
  realizedPnlUsd: number;
  portfolioValueUsd: number | null;
  confidence: number;
  ts: string;
};
```
**Read from:** `evolution_log` WHERE event_type = 'wallet-typology'
**Dedup:** keep one row per wallet (most recent).

### `recentConsensusSignals: ConsensusEventBrief[]`
```ts
export type ConsensusEventBrief = {
  marketKey: string;
  marketTitle?: string;
  direction: string;
  effectiveWallets: number;
  combinedTrust: number;
  combinedUsd: number;
  avgPrice: number;
  ts: string;
};
```
**Read from:** `evolution_log` WHERE event_type = 'consensus-signal' AND created_at >= now - 1h
**Sort:** by effectiveWallets desc, then combinedTrust desc.

### `recentTradeClassifications: TradeClassificationBrief[]`
```ts
export type TradeClassificationBrief = {
  wallet: string;
  marketKey: string;
  side: "BUY" | "SELL";
  direction: string;
  price: number;
  usd: number;
  intent: string;       // accumulation | distribution | basket_rotation | ...
  topDriver: string;    // human-readable from features.likelyDrivers[0]
  ts: string;
};
```
**Read from:** `evolution_log` WHERE event_type = 'wallet-trade-classified' AND created_at >= now - 15min
**Limit:** 30 (more recent activity than typology).

### `recentStrategyOpportunities: StrategyOpportunityBrief[]`
```ts
export type StrategyOpportunityBrief = {
  type: "near-resolution" | "cross-timeframe-spread" | "orderbook-imbalance";
  marketKey: string;
  marketTitle?: string;
  side?: "YES" | "NO" | "BUY" | "SELL";
  /** Edge in price points (e.g. 0.03 = 3% to resolution). */
  edge: number;
  /** Annualized yield when applicable (near-resolution only). */
  annualizedEdge?: number;
  /** Detector-specific signal strength 0..1. */
  signalStrength?: number;
  /** Free-form reason string from the detector. */
  reason: string;
  ts: string;
};
```
**Read from:** `evolution_log` WHERE event_type IN ('near-resolution-opportunity', 'cross-timeframe-spread', 'orderbook-imbalance-signal') AND created_at >= now - 30min
**Sort:** by edge desc.
**Limit:** 20.

---

## Updates to `summarizeContext()`

The compact log-line summary already shows `[ctx halt=no capsules=2/3 evo=20 reject:CAPSULE_DAILY_LOSS×3 bt=87.2]`. Extend to include:

```
[ctx halt=no capsules=2/3 evo=20 bt=87.2 typ=18cv/12hft/5whale cons=2 trades=45 opps=3]
```

Where:
- `typ=18cv/12hft/5whale` — typology bucket counts
- `cons=N` — recent consensus signals in the window
- `trades=N` — recent classified trades in the window
- `opps=N` — recent strategy opportunities in the window

Keep total length under ~120 chars.

---

## Updates to `oracle-llm` prompt

Currently the oracle-llm prompt includes a JSON-stringified AgentContext slice. Extend the prompt template to:

1. List the new fields explicitly in the system prompt so the LLM knows they exist
2. Provide guidance: "When `recentStrategyOpportunities` contains a `near-resolution` entry with `annualizedEdge > 50%`, the operator may want to size into it via the near-resolution scraper strategy. You can propose this in your `recommended_action` field."
3. Provide guidance: "When `recentConsensusSignals` shows `effectiveWallets >= 3` from distinct clusters, that's a high-trust cross-sectional signal."
4. Keep prompt size manageable — these arrays are bounded so the marginal token cost is small.

---

## Acceptance criteria

- `buildAgentContext(strategyId)` returns the 4 new fields populated from evolution_log.
- All 4 fields are `[]` when no relevant events exist (no nulls, no undefineds).
- Field shapes match the type definitions above exactly.
- `summarizeContext()` includes the new counters in its single-line output.
- Existing AgentContext consumers (research-loop, oracle-llm) work unchanged — fields are additive.
- ≥ 3 new unit tests covering each field's population logic + dedup.
- `tsc --noEmit` clean.

---

## Sequencing

1. **This PRD** — extend `src/lib/agents/context.ts` types + populate functions + tests
2. **Update oracle-llm prompt** to mention the new fields with guidance
3. **THEN** build the 3 strategies (`strategies-2026-05-26.md`) — they'll have a consumer
4. **THEN** observe real-world behavior: do agents actually act on the new signals? Iterate

---

## Backwards compatibility

The 4 new fields are added to the AgentContext type. They are non-optional but default to `[]` when no events match. Any existing consumer that destructures only the old fields continues to work.
