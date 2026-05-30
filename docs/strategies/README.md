# Strategy Dossier — Index

Implementation-grade strategy documentation for the HFT proof-of-concept. Each
strategy doc here is structured to take you from "what is this" → "where in
this repo would I put it" → "how do I backtest it" without forcing you to
re-read three textbooks and a dozen papers.

This index is the **menu**. The per-strategy docs are the **recipes**. The
existing modules under `src/lib/strategies/` and `src/lib/hft/` are the
**ingredients you already own**.

If you have never read `docs/hft-patterns.md`, read sections 0 and 1 first.
Everything below assumes you accept:

```
expected_edge_bps > fees + spread + slippage + latency + adverse_selection
```

The catalog of strategies below is, in the end, a catalog of which terms
dominate and how to control them. See `src/lib/hft/edge.ts` for the formula
in code.

---

## 1. Strategy families

Ten families. Each row links to its deep-dive (✅ written, 📝 stub planned).
Sub-rows under each family are concrete variants — the variants are what you
implement, not the family abstraction.

| # | Family | Variants | Deep-dive |
|---|--------|----------|-----------|
| 1 | **Market making (passive liquidity)** | Quote-driven baseline · Avellaneda-Stoikov inventory-aware · Queue-position aware · Order-book imbalance enhanced | [market-making-quote-driven.md](./market-making-quote-driven.md) ✅ |
| 2 | **Cross-venue arbitrage** | CEX-CEX spot · Perp-spot basis · Triangular FX/crypto · Equities NBBO/SOR · Polymarket complement-sum · Polymarket cross-resolver | [cross-venue-arbitrage.md](./cross-venue-arbitrage.md) ✅ |
| 3 | **Statistical arbitrage (pairs/cointegration)** | Engle-Granger pairs · Johansen baskets · ETF arb (creation/redemption) · Lead-lag · Index arb | [pairs-trading-cointegration.md](./pairs-trading-cointegration.md) ✅ |
| 4 | **Microstructure signal trading** | Order-book imbalance (OBI) · Microprice · Order-flow imbalance (OFI) · Trade-flow imbalance (TFI) · VPIN toxicity · Sweep detection · Iceberg detection · Queue-burst | [microstructure-signals.md](./microstructure-signals.md) ✅ |
| 5 | **Latency arbitrage** | Cross-venue stale-quote · Tick-by-tick lead-lag (futures→cash) · Listing/delisting front-run · Oracle update front-run (on-chain) | 📝 `latency-arbitrage.md` (planned) |
| 6 | **Execution algorithms** | TWAP · VWAP · POV (participation) · Implementation Shortfall · Adaptive (alpha-aware) · Iceberg/hidden | [execution-algos.md](./execution-algos.md) ✅ |
| 7 | **Basis & funding trading** | Perp-spot cash-and-carry · Cross-exchange funding spread · Futures-spot calendar roll · Borrow-lend rate arb | [basis-funding.md](./basis-funding.md) ✅ |
| 8 | **Event-driven** | Earnings/news drift · Scheduled macro (CPI/NFP) · On-chain oracle updates · Polymarket resolution scrape · Token unlock/airdrop | 📝 `event-driven.md` (planned — referenced from `near-resolution-scrape.ts`) |
| 9 | **Options & volatility** | Delta-hedged MM (gamma scalping) · Vol surface arb · Implied-vs-realized spread · Binary option MM (Polymarket) · Skew/term-structure trades | 📝 `options-volatility.md` (planned) |
| 10 | **ML/RL-driven (cross-cutting)** | RL parameter tuning of A-S · LSTM/Transformer microstructure prediction · DQN execution agent · Bandit venue routing | 📝 `ml-rl-overlays.md` (planned) |

---

## 2. Asset-class applicability matrix

Where each family is *viable* on the venues this repo cares about. ✅ = good
fit, ⚠️ = works but constrained, ❌ = not viable as a primary strategy.

| Family | US equities (Alpaca) | Crypto spot (Coinbase) | Crypto perps (dYdX, Hyperliquid) | Polymarket binaries |
|---|---|---|---|---|
| 1. Market making | ⚠️ retail SOR can't hit lit MM tier; mid-cap MM via Alpaca limit orders is feasible at T3 | ✅ Coinbase has maker rebates at tier; rebate flips strategy EV | ✅ dYdX maker rebates, Hyperliquid maker discount; perps MM is the workhorse | ✅ thin books, wide spreads, retail edge live now |
| 2. Cross-venue arb | ⚠️ NBBO already enforced by brokers; venue-internalization arb is gone for retail | ✅ CEX-CEX spot still exists at small size and odd hours | ✅ perp-spot basis, cross-perp funding spread are live edges | ✅ complement-sum and CEX-vs-Polymarket BTC are repo specialties |
| 3. Pairs / cointegration | ✅ classic territory (KO/PEP, sector ETFs, dual-listed) | ✅ BTC/ETH, sector pairs (L1s, DEX tokens) | ✅ cross-perp pairs, same-pair across venues | ❌ binary structure breaks the cointegration assumption |
| 4. Microstructure signals | ⚠️ Alpaca free tier is no L2; paid feed required | ✅ Coinbase WS L2 free; OBI works | ✅ dYdX WS depth, Hyperliquid WS L2 | ✅ Polymarket WS book; this repo already ships OBI here |
| 5. Latency arb | ❌ T0 game owned by Citadel/Virtu | ⚠️ feasible only between high/low-tier venues with persistent latency gaps | ⚠️ same | ✅ vs CEX oracles — repo's `polymarket-btc.ts` is exactly this |
| 6. Execution algos | ✅ standard institutional toolkit; also useful for "don't blow up my $50k entry" | ✅ same | ✅ same | ⚠️ POV doesn't apply (binaries don't have continuous volume curves); IS does |
| 7. Basis & funding | ⚠️ futures-vs-cash exists but requires futures account; equity index arb is institutional | ⚠️ spot-vs-CME-futures basis exists but slim for retail | ✅ perp funding is the canonical retail-accessible basis trade | ❌ not applicable |
| 8. Event-driven | ✅ earnings drift, NFP, retail meme runs | ✅ token listings, halving, exchange announcements | ✅ funding rate spikes around macro prints | ✅ resolution scraping, oracle-update front-run |
| 9. Options & vol | ✅ Alpaca options now available (2024+) | ⚠️ Deribit/Binance for crypto options; not in repo today | ⚠️ same | ✅ binaries *are* options; vol-of-implied-probability is tradeable |
| 10. ML/RL overlays | ✅ wraps any underlying strategy | ✅ same | ✅ same | ✅ same |

---

## 3. Latency-tier matrix

Cross-reference with `docs/hft-patterns.md` §1. T-tier = the slowest tier
where the strategy still works for a single operator.

| Family | Min tier | This repo's reality |
|---|---|---|
| 1. Market making | T2 (T3 with wide quotes only) | T3 — works on Polymarket binaries; tight crypto perp MM needs T2 |
| 2. Cross-venue arb | T2-T3 depending on venues | T3 — works for Polymarket vs CEX, marginal for CEX-CEX |
| 3. Pairs / cointegration | T3 (T4 for slow pairs) | T3-T4 — half-life of hours/days for most viable pairs |
| 4. Microstructure signals | T1-T2 for OBI/microprice | T3 — repo's OBI runs slower than ideal; positions held seconds-to-minutes |
| 5. Latency arb | T0-T1 | Out of reach except for slow-mover variants like oracle-update |
| 6. Execution algos | T3-T4 | T3 — fine; this is "be patient with a large order" not "race the tape" |
| 7. Basis & funding | T3-T4 | T3-T4 — funding rate harvesting is multi-hour, accessible |
| 8. Event-driven | T2-T3 (T0 for news-taking on equities) | T3 for scheduled events; retail can't compete on macro-print front-running |
| 9. Options & vol | T3 | T3 — vol surfaces update slowly |
| 10. ML/RL overlays | inherited from wrapped strategy | inherited |

**This repo lives at T3.** Anything in the table requiring T0-T1 is here as
documentation, not as something to deploy.

---

## 4. Current repo implementation status

Cross-reference: what's already in `src/lib/` and which family/variant it
implements.

| File | Family | Variant | Status |
|---|---|---|---|
| `src/lib/hft/edge.ts` | foundational | The cost-edge inequality, machine-checked | live |
| `src/lib/hft/venues.ts` | foundational | Typed venue catalog with fee/rebate tiers | live |
| `src/lib/hft/strategies.ts` | foundational | Head-to-head ranker across venues/strategies | live |
| `src/lib/hft/basis.ts` | 7. Basis | Perp-spot basis helpers | live (skeleton) |
| `src/lib/hft/polymarket-btc.ts` | 5. Latency arb | Polymarket BTC binary fair from CEX spot | live |
| `src/lib/hft/dydx/mm.ts` + `mm-engine.ts` | 1. MM | Inventory-aware quote-driven MM on dYdX perps | live (testnet) |
| `src/lib/hft/dydx/signals.ts` | 4. Microstructure | OBI + microprice for dYdX | live |
| `src/lib/strategies/orderbook-imbalance.ts` | 4. Microstructure | Polymarket OBI signal | live |
| `src/lib/strategies/complement-sum-arb.ts` | 2. Cross-venue arb | Polymarket binary complement-sum < 1 | live |
| `src/lib/strategies/cross-timeframe-spread.ts` | 4. Microstructure | Multi-horizon momentum/reversal signal | live |
| `src/lib/strategies/midwindow-trajectory.ts` | 8. Event-driven | Polymarket resolution-window trajectory | live |
| `src/lib/strategies/near-resolution-scrape.ts` | 8. Event-driven | Polymarket near-resolution edge | live |
| `src/lib/strategies/vol-scalp.ts` | 9. Options/vol | Vol-scalp on binaries (implied-prob vol) | live |
| *(missing)* | 1. MM equities | Alpaca quote-driven MM | not yet |
| *(missing)* | 3. Pairs | Cointegration scanner + executor | not yet |
| *(missing)* | 7. Funding | Cross-exchange funding-rate harvester | not yet |
| *(missing)* | 6. Execution | VWAP/TWAP/IS adapter for any venue router | not yet |

---

## 5. The agentic layer — where these primitives get consumed

The strategy docs in this folder define the **primitives** — math, parameters,
fill models, code skeletons. They're meant to be consumed by *something* that
picks which strategy to deploy with what parameters at any given moment. In
this repo that "something" is a two-layer agentic stack (the parallel
direction of work — see `docs/blueprint/BLUEPRINT.md` for its origin story
synthesized from 4 video-tutorial transcripts).

```
                       ┌─────────────────────────────────────┐
                       │  Capital allocator                   │
                       │  src/lib/arena/allocator.ts          │  ← decides WHICH agents get capital
                       │  scripts/arena-allocate.ts           │     based on arena fitness + diversity
                       └──────────────┬───────────────────────┘
                                      │ grants capsules
                                      ▼
                       ┌─────────────────────────────────────┐
                       │  LLM trader-as-agent                 │
                       │  src/lib/agents/trader-llm.ts        │  ← given capsule + signals, emits
                       │  prompts/llm-trader-persona.v1.md    │     ONE trade intent per tick
                       └──────────────┬───────────────────────┘
                                      │ intent
                                      ▼
                       ┌─────────────────────────────────────┐
                       │  Execution gate                      │
                       │  src/lib/venue/ExecutionRouter       │  ← halt → capsule → risk gates,
                       │  src/lib/risk/RiskEngine             │     idempotent submit, hash-chained log
                       └──────────────┬───────────────────────┘
                                      │ orders
                                      ▼
                       ┌─────────────────────────────────────┐
                       │  Venue adapters                      │
                       │  src/lib/venue/adapters/{coinbase,   │  ← Coinbase, Polymarket, dYdX, ...
                       │     polymarket, sim}.ts              │
                       └─────────────────────────────────────┘

                       ┌─────────────────────────────────────┐
                       │  Strategy factory (offline)          │
                       │  scripts/strategy-factory.ts         │  ← sweeps parameter grids from these
                       │                                      │     docs into 10^5+ strategy_version rows
                       └─────────────────────────────────────┘

                       ┌─────────────────────────────────────┐
                       │  Sim-lab (Python reference)          │
                       │  research/sim-lab/                   │  ← runs the same loop on real replayed
                       │                                      │     candles; risk-adjusted multi-window
                       │                                      │     promotion verdict before going live
                       └─────────────────────────────────────┘
```

**How a strategy doc feeds the stack:**

1. **The parameter table** in §6 of every deep-dive becomes the grid `scripts/strategy-factory.ts` sweeps. One "MM quote-driven" doc with 8 parameters and 5 values each yields ~390k strategy variants the arena can rank.
2. **The code skeleton** in §9 becomes the actual `src/lib/strategies/<name>.ts` module. The LLM trader doesn't write trading code — it picks among these implemented primitives and proposes parameters.
3. **The fill model + backtest design** (§7-8) becomes the test harness that scores each variant in `research/sim-lab/` before any of it touches `paper` or `live` stages (see `src/lib/stages/`).
4. **The implementation path** (§10) tells you where to add the venue adapter and how to register the engine with `src/lib/risk/kill-switch.ts`.

**Where the LLM agent vs. classical strategy distinction matters:**

- **Classical strategies** (these docs): the decision logic is hard-coded math. Reproducible bit-for-bit. Good for fast loops (MM, OBI scalping) and for the *implementations* the LLM agent invokes.
- **LLM-driven agent** (`trader-llm.ts`): the decision logic is a Claude evaluation per tick. Necessarily slower (~seconds per decision) and non-deterministic. Good for *meta-decisions* (which strategy to run now, when to flatten before news) and for novel-pattern reasoning the hard-coded primitives can't express.

The honest measured result from the sim-lab: **a single LLM scalper is
near-break-even**. The system's edge is the ensemble — many strategies +
many agents + arena allocator routing capital to whatever proves edge.
That's why this dossier focuses on the strategy *primitives*: more
primitives in the menu → more variants in the factory → more agents
in the arena → more chances for the allocator to find positive expected
value. The docs are the alpha source; the agent layer is the delivery
mechanism.

For the full mapping of blueprint concepts → repo modules, see
[`docs/blueprint/INTEGRATION.md`](../blueprint/INTEGRATION.md).

---

## 6. Reading order

If you're picking which strategy to implement next:

1. **Read** `docs/hft-patterns.md` end-to-end — the survey of patterns and the latency-tier framing.
2. **Read** [`market-making-quote-driven.md`](./market-making-quote-driven.md) — the workhorse. Most of your edge sources are variants of "be a better quote setter."
3. **Read** [`cross-venue-arbitrage.md`](./cross-venue-arbitrage.md) — the cheapest edge to verify. If your arb math doesn't pencil, your MM math won't either.
4. **Read** [`pairs-trading-cointegration.md`](./pairs-trading-cointegration.md) — the slowest edge in the dossier. Useful even at T4, doesn't compete with co-located firms.
5. **Read** [`docs/blueprint/INTEGRATION.md`](../blueprint/INTEGRATION.md) for the full agentic-layer integration map (capsule + risk gate + allocator pattern, with concrete file pointers).
6. **Pick one family with a "not yet" status** in §4 and write the corresponding `src/lib/strategies/<name>.ts` + a test file in `tests/unit/`.

---

## 7. Doc structure (what every deep-dive contains)

Every per-strategy doc in this folder follows the same shape so they're
skim-able and comparable:

1. **TL;DR** — 150-word summary.
2. **Mechanism** — the math and the intuition. No hand-waving.
3. **Where it works** — asset class × venue × latency tier × capital size.
4. **Edge magnitude** — what to expect, with citations to recent papers/data.
5. **What kills it** — failure modes ranked by likelihood.
6. **Parameters** — exhaustive list with defaults, units, sensible ranges.
7. **Fill model** — assumptions for backtesting.
8. **Backtest design** — data, metrics, look-ahead traps, walk-forward setup.
9. **Code skeleton** — TypeScript following this repo's conventions, hooked into `src/lib/hft/edge.ts`.
10. **Implementation path here** — concrete file list, types to add to `venues.ts`, integration with the `arena/` lifecycle.
11. **References** — cited inline.

This structure is enforced by [`_TEMPLATE.md`](./_TEMPLATE.md) (planned). When
contributing a new strategy doc, copy that file as your starting point.

---

## 8. References & primary sources

The taxonomy here draws on the following surveys and primary papers. Per-doc
references are inline in each strategy file.

**Surveys & textbooks**
- Cartea, Jaimungal & Penalva, *Algorithmic and High-Frequency Trading*, Cambridge, 2015 — canonical MM/microstructure textbook.
- Lehalle & Laruelle (eds.), *Market Microstructure in Practice*, World Scientific, 2nd ed. 2018.
- O'Hara, *High Frequency Market Microstructure*, JFE 2015.

**Foundational papers**
- Glosten & Milgrom, "Bid, ask and transaction prices in a specialist market with heterogeneously informed traders," *JFE* 14(1), 1985.
- Avellaneda & Stoikov, "High-frequency trading in a limit order book," *Quantitative Finance* 8(3), 2008.
- Engle & Granger, "Co-integration and error correction: representation, estimation, and testing," *Econometrica* 55(2), 1987.
- Johansen, "Statistical analysis of cointegration vectors," *J. Econ. Dyn. Control* 12(2-3), 1988.

**Recent (2022-2025)**
- Marin & Vera, "A reinforcement learning approach to improve the performance of the Avellaneda-Stoikov market-making algorithm," *PLOS ONE* 17(12), 2022 — Alpha-AS-1/2 RL extensions.
- Cont & Cucuringu et al., on order-flow imbalance and microprice (multiple recent SSRN preprints).
- Hudson & Thames, [open-source `mlfinlab` pairs trading tutorials](https://hudsonthames.org/an-introduction-to-cointegration/).

**Industry/practitioner**
- Hummingbot, [Avellaneda-Stoikov strategy guide](https://hummingbot.org/blog/guide-to-the-avellaneda--stoikov-strategy/) — production crypto MM reference implementation.
- Amberdata, [funding rate arbitrage guide](https://blog.amberdata.io/the-ultimate-guide-to-funding-rate-arbitrage-amberdata).
- CFA Institute, [Trade Strategy and Execution](https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/trade-strategy-execution) — institutional execution-algo framing.

---

## 9. Disclaimer

Everything here is for the operator of a proof-of-concept HFT system to learn
from. None of this is investment advice. Past edges close. Backtested
strategies overfit. Use the cost-edge inequality honestly: most of these
strategies will pencil to negative net edge once you plug in your actual
fees, latency, and adverse selection.

The honest test for any strategy in this dossier: **can you make it survive a
walk-forward backtest with realistic fees and a fill model that punishes
queue-position assumptions?** If not, don't put real money on it.
