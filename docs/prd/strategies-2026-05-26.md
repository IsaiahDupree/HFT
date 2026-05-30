# PRD — Three new trading strategies (2026-05-26)

**Status:** approved-for-build
**Owner:** Isaiah Dupree
**Drafted:** 2026-05-26 from `docs/research/daniro-2026-05-25-report.md` gap analysis
**Source of evidence:** Wallet `0x6e1d5040d0ac73709b0621f620d2a60b80d2d0fa` proven to bank $2,029,619 realized PnL running strategy #1 in production. Strategies #2 + #3 are direct adaptations of formulas published in the Daniro 2026-05-25 article (`docs/research/daniro-2026-05-25-1000-polymarket-bots.md`).

---

## Strategy #1 — Near-resolution scraper

### Goal
Capture the 1–5% premium left on the table when a Polymarket binary market is already ~99% certain to resolve a given way but trades at 0.95–0.99 instead of 1.00. Hold to resolution; collect the convergence.

### Proof of viability
`0x6e1d5040d0ac73709b0621f620d2a60b80d2d0fa` open book (verified 2026-05-26): 30 positions, $919K open book, almost all NO-side at 0.85-0.99 on near-certain BTC May markets. $2,029,619 lifetime realized PnL doing this.

### Scope — what's in
- A **pure detector** (`src/lib/strategies/near-resolution-scrape.ts`) that takes a market snapshot (conditionId, bestBidYes/No, bestAskYes/No, endDate, currentMid) and returns `ScrapeOpportunity | null`.
- A **periodic scanner script** (`scripts/scan-near-resolution.ts`) that pulls Gamma events ending within `--max-days` (default 30), filters markets meeting threshold criteria, persists `near-resolution-opportunity` events to evolution_log.
- An **opportunity → AgentContext bridge** — agents see recent opportunities via the new `recentStrategyOpportunities` field.

### Scope — what's out (deferred)
- **Auto-execution worker.** Build candidates with `--auto-exec` flag for a future PR. The detector + signal pipe to evolution_log is sufficient to validate the strategy without auto-execution.
- **Resolution-source verification.** We trust Polymarket's `endDate` field. We don't independently validate that the market WILL resolve to the side it's pricing.
- **Liquidity sizing on opposite side** (selling YES when buying NO). v1 only buys; exit via resolution payout, not active selling.

### Acceptance criteria
- Detector returns null when `bestAsk < minPrice` (default 0.95) OR `daysToResolution > maxDays` (default 30) OR `daysToResolution < minDays` (default 1).
- Detector identifies the "winning side" as the outcome whose mid-price is higher.
- Detector computes `edge = 1.0 - entryPrice - fees`, `annualizedEdge = edge / daysToResolution * 365`.
- Scanner persists opportunities to `evolution_log` event_type=`near-resolution-opportunity` with dedup key `(conditionId, side, day-bucket)` so re-running same day on same market = no-op.
- Unit tests cover: winning-side detection, threshold filters, edge math, annualized-yield math, expired/too-far markets rejected.
- Integration: opportunities visible in AgentContext's `recentStrategyOpportunities` field.

### Safety / risk
- **Tail risk** the article explicitly calls out: "a sharp reversal in the last second wipes out many small wins." The 3-5% premium can be lost in a single resolution flip. Capsule daily-loss caps still apply.
- **Liquidity risk:** large NO buys can move thin markets adversely. Cap per-market sizing at 1% of orderbook depth (added in detector output).
- **Concentration risk:** capping per-strategy capsule at $50K default exposes us to ~$2-5K loss worst case per market.

### Build estimate
4-8 hours implementation + tests + script + memory. Detector alone is ~200 lines, scanner is ~150 lines, tests are ~120 lines.

---

## Strategy #2 — Cross-timeframe spread detector

### Goal
Detect when two Polymarket markets covering the SAME underlying crypto direction across DIFFERENT timeframes (e.g. BTC 5min Up/Down vs BTC 15min Up/Down both ending in same window) drift apart. The 5m market typically reprices first; the 15m lags.

### Proof of viability
Daniro article: cited Hermes wallet `0xb55fa1296…` as practicing exactly this arb. Article formula (verbatim):
```python
spread_now = 0.12
mu = 0.03
sigma = 0.025
z = (spread_now - mu) / sigma  # → 3.60
```

### Scope — what's in
- A **pure detector** (`src/lib/strategies/cross-timeframe-spread.ts`) — given a pair of (shortDuration, longDuration) market snapshots tracking the same underlying direction in the same window, returns `SpreadOpportunity | null` when |z-score| ≥ threshold.
- A **periodic scanner** (`scripts/scan-cross-timeframe.ts`) — for each BTC/ETH/SOL/XRP × (5m/15m/1hr/4hr) pair, fetches current mid-prices, computes rolling spread mean + stdev over last N samples, emits opportunity if z > threshold.
- Integration with AgentContext.

### Scope — what's out
- **Pair-discovery automation.** v1 hard-codes the canonical (5m,15m) pairs for BTC/ETH/SOL/XRP. Auto-discovering "which markets are about the same thing" is non-trivial and deferred.
- **Auto-execution.** Same as #1 — detector + signal only in v1.

### Acceptance criteria
- Detector returns null with insufficient samples (need ≥ 30 to compute meaningful stdev).
- Detector clamps z-score to ±10 to avoid div-by-zero blowups when sigma is small.
- Output includes which side to buy on which market and the implied edge (in price points and as % of position).
- Dedup key: `(shortConditionId, longConditionId, direction, 5-min-bucket)`.
- Tests: insufficient sample, normal spread (z=0), positive z (long market cheap), negative z (short market cheap), sigma=0 handled.

### Safety / risk
- **Correlation risk:** 5m and 15m markets resolve differently. A bot taking both sides could win one and lose the other. v1 only emits the SIGNAL, not the trade — operator interpretation required.
- **Stale-data risk:** if one of the two market prices is stale, the spread is fake. Detector requires both timestamps within `maxStalenessSec` of each other (default 60s).

### Build estimate
6-10 hours.

---

## Strategy #3 — Orderbook imbalance signal

### Goal
Detect microstructure pressure on a Polymarket market by measuring the ratio of bid-side depth to ask-side depth at the top 3 levels of the orderbook. When the ratio exceeds threshold (e.g. 3:1 bid-heavy or ask-heavy), there's an actionable directional signal that often precedes a price move within seconds.

### Proof of viability
Daniro article archetype #5 ("Imbalance Bot"): "It doesn't just buy direction — it builds a position around the skew." Generic microstructure principle widely documented in equities/crypto market-making literature.

### Scope — what's in
- A **pure detector** (`src/lib/strategies/orderbook-imbalance.ts`) — given an L2 orderbook snapshot (bids + asks arrays), returns `ImbalanceOpportunity | null` with imbalance ratio + signal strength + recommended side.
- A **periodic scanner** (`scripts/scan-orderbook-imbalance.ts`) — polls top-of-book for a configured market set, emits opportunities when |imbalance| > threshold.
- Integration with AgentContext.

### Scope — what's out
- **WebSocket-driven real-time signal.** v1 uses HTTP polling. WS upgrade is a future PR.
- **Composite signal with cross-timeframe + repricing.** v1 emits each signal independently; an agent or operator combines them.

### Acceptance criteria
- Detector handles empty book (returns null), one-sided book (returns null with reason), normal book.
- Imbalance ratio = `sum(bid_size top 3) / sum(ask_size top 3)`; values > 3.0 or < 0.33 trigger signal.
- Signal strength normalized to 0..1.
- Tests: empty book, one-sided, balanced (no signal), bid-heavy (buy signal), ask-heavy (sell signal), very-thin-book handling.

### Safety / risk
- **Spoofing risk:** large orders can appear and disappear without trading. v1 emits raw signal; operator vigilance required. Future: require imbalance to persist across N polls.
- **Latency:** signal value decays in seconds. Polling-based detection is best-effort; WS upgrade is the proper fix.

### Build estimate
4-6 hours.

---

## Cross-cutting requirements (all 3 strategies)

### Agent visibility (built BEFORE strategies — see `agent-capabilities-2026-05-26.md`)
- Each strategy emits to `evolution_log` with a distinct `event_type`
- `AgentContext.recentStrategyOpportunities` reads all 3 event types into a unified bounded list
- `summarizeContext()` includes a count and the top opportunity by edge
- `oracle-llm` prompt includes the new field

### Idempotency
- Every opportunity event MUST include a dedup key so re-runs don't double-emit
- Dedup keys are SQL-checked in the scanner before insert

### Backtestable
- Each detector is a pure function — caller passes market snapshot, gets opportunity. Backtester replays historical snapshots through the same detector to validate.

### Test coverage targets
- ≥ 5 test cases per strategy detector
- Edge cases: empty input, threshold boundaries, infinity/NaN handling
- Integration tests for AgentContext extension

### npm scripts
- `scan:near-resolution` → `tsx scripts/scan-near-resolution.ts`
- `scan:cross-timeframe` → `tsx scripts/scan-cross-timeframe.ts`
- `scan:orderbook-imbalance` → `tsx scripts/scan-orderbook-imbalance.ts`

---

## What's NOT in any strategy v1

- **Auto-execution.** All three strategies emit signals. Trading on them goes through the existing venue router + capsules + stages. No bypass.
- **Cross-strategy composite signals.** No "near-resolution + imbalance = ultra-high-confidence" combo logic. That's a future composer.
- **ML-tuned thresholds.** All thresholds are hand-set defaults with CLI flags to override. ML tuning is post-PoC work after we have a few weeks of opportunity data.

---

## Sequencing

1. **AgentContext extension** (this PRD's prerequisite — see agent-capabilities doc)
2. **Strategy #1 — near-resolution scraper** (highest leverage, $2M proof)
3. **Strategy #2 — cross-timeframe spread** (article-direct formula, BTC focus)
4. **Strategy #3 — orderbook imbalance** (data we already pull)
