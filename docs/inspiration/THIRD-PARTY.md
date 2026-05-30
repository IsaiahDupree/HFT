# Third-party Polymarket / prediction-market repos

All entries verified live on 2026-05-25. Listed by **how directly applicable**
to our workspace, not by star count. Quality varies — read the README before
copying anything from any of these.

## Tier 1 — directly relevant

### [pmxt-dev/pmxt](https://github.com/pmxt-dev/pmxt) — 1.8k ★ — TypeScript / MIT
- "CCXT for prediction markets." Unified API for **11 platforms**: Polymarket, Polymarket US, Kalshi, Limitless, Probable, Myriad, Opinion, Metaculus, Smarkets, Hyperliquid, Gemini Titan.
- TS (74%), Python + HTTP bindings. Supports both data fetching AND order placement through one normalized interface.
- **Why this matters:** this is the strongest external reference for our `VenueAdapter` direction. If we add Kalshi/Limitless/etc., evaluate using pmxt directly instead of writing our own adapters from scratch.
- **Action:** when planning the third prediction-market venue, spike pmxt for a day before committing to a hand-rolled adapter. Trade-off is dep weight vs. velocity — pmxt covers the API surface we'd otherwise spend weeks on.

### [KaustubhPatange/polymarket-trade-engine](https://github.com/KaustubhPatange/polymarket-trade-engine) — 271 ★ — TypeScript / MIT
- Automated trading engine for Polymarket binary markets (BTC/ETH 5-min and 15-min Up/Down).
- Includes a strategy testing framework + interactive analysis dashboard.
- **Why this matters:** the cleanest reference for **TS-native** Polymarket trading. Their strategy testing scaffold is close to what our backtester needs to grow into.
- **Action:** read their `strategies/` folder + dashboard wiring. Borrow patterns where they overlap with our research-loop evaluators; don't fork.

### [aulekator/Polymarket-BTC-15-Minute-Trading-Bot](https://github.com/aulekator/Polymarket-BTC-15-Minute-Trading-Bot) — 393 ★ — Python / MIT
- Production-grade bot for Polymarket's 15-min BTC markets. "7-phase architecture":
  1. External data (Coinbase, Binance, news)
  2. Validation + unification
  3. NautilusTrader integration
  4. Signal processing + fusion (weighted voting)
  5. Order execution + risk
  6. Monitoring (Grafana/Prometheus)
  7. Learning engine (weight optimization)
- Signal types: spike detection, sentiment (Fear & Greed), price divergence.
- **Why this matters:** our research-loop is single-signal-per-evaluator today. Their fusion-engine pattern (multiple signals → weighted vote → decision) is a useful extension.
- **Action:** when we add a multi-signal evaluator (e.g. combining order-flow + cross-venue divergence + sentiment), pattern after their fusion engine. Their NautilusTrader use is overkill for our scale — skip that bit.

## Tier 2 — narrower scope but useful

### [Composio-HQ/polymarket-kalshi-arbitrage-bot](https://github.com/Composio-HQ/polymarket-kalshi-arbitrage-bot) — 78 ★ — TypeScript
- 15-min BTC market arb between Polymarket and Kalshi. Two strategies:
  - **Spread:** triggers when Kalshi YES is 93–96¢ and Polymarket UP is ≥10¢ cheaper.
  - **Timing:** triggers when Kalshi has settled but Polymarket is still open with liquidity.
- Uses ethers.js for Polymarket order submission.
- **Why this matters:** our `cross_venue_arbs` table is set up for Polymarket↔Coinbase. The same pattern extends to Polymarket↔Kalshi cleanly. This repo is a concrete template for the "settlement-timing gap" strategy variant.
- **Action:** if/when Kalshi joins the workspace, port their two strategies as evaluators (`btc-15m-spread-arb`, `btc-15m-timing-arb`) under `scripts/research-loop.ts`.

### [HarrierOnChain/Prediction-Markets-Trading-Bot-Toolkits](https://github.com/HarrierOnChain/Prediction-Markets-Trading-Bot-Toolkits) — 242 ★ — Rust / MIT
- 10 trading-bot strategies for Polymarket, Kalshi, Limitless. Strategies span copy trading, arbitrage, market making.
- Bilingual README (English + Chinese). Code of conduct, security policy, Telegram community.
- **Why this matters:** strategy catalog is broader than what we have. Reference for "what kinds of bots people actually run on prediction markets."
- **Action:** scan the strategy list as inspiration for evaluator ideas. Don't port — Rust + multi-platform scope is out of step with our TS-only architecture.

## Caveats

- **All of these are external, third-party code.** Verify license + dependencies before pulling anything. None of them are vetted by Polymarket the company.
- **Don't trust performance claims** in any of these READMEs (especially "production-grade", "self-learning", "$X profit"). Run the strategies in our SimAdapter + capsule pipeline at $0 risk first.
- **Strategy code copied from these repos enters via the venue router**, which means it gets the same 5-gate pipeline (idempotency → halt → capsule → risk engine → adapter). No path lets a copied strategy bypass our safety layer.

---

## Added from Lunar 2026-03-30 article (paid partnership — verify everything)

Verified live 2026-05-25. The full article + provenance notes are at [docs/research/lunar-2026-03-30-mass-analysis.md](../research/lunar-2026-03-30-mass-analysis.md).

### Tier 1 (high-quality, useful data infra)

### [warproxxx/poly_data](https://github.com/warproxxx/poly_data) — 1.9k ★ — Python / GPL-3.0
- Pipeline that reads Polymarket CTF Exchange V2 order events directly from Polygon via JSON-RPC and joins them with market metadata. Effectively a free, full-fidelity trade history feed.
- **Why this matters:** complements our `onchain.ts` watcher. Their historical-snapshot approach saves us 2+ days of backfill when we want to bootstrap analytics on a new wallet.
- **License caveat:** GPL-3.0 — if we integrate code (not just data), our distributable becomes GPL too. Use as a data source, not as a code dep.

### [Jon-Becker/prediction-market-analysis](https://github.com/Jon-Becker/prediction-market-analysis) — 3.4k ★ — Python / MIT
- "Largest publicly available dataset of Polymarket and Kalshi market and trade data" + analysis framework.
- **Why this matters:** academic-quality dataset. Useful when we want to validate fingerprints against a much larger sample than we can backfill ourselves.

### Tier 2 (useful patterns, run with caution)

### [NYTEMODEONLY/polyterm](https://github.com/NYTEMODEONLY/polyterm) — 274 ★ — Python / MIT
- Terminal-based analytics with 20+ features: whale tracking, insider detection, cross-platform arb scanning, signal-based predictions.
- **Why this matters:** the structure of their "screens" (whales, smart wallets >70% WR, alerts, arb) is a good reference for what our `/wallets` and `/tracked` UI should expose.
- **Sniff test:** article cited 32 ★, now 274 (~8× growth). Could be organic (the article itself amplified it) or a star-farming campaign. Read the commits before adopting code.

### [pselamy/polymarket-insider-tracker](https://github.com/pselamy/polymarket-insider-tracker) — 143 ★ — Python / MIT
- ML + heuristics monitoring fresh wallets, unusual position sizes, low-liquidity-market entries. Alerts via Discord/Telegram/email.
- **Why this matters:** the heuristic set is roughly what our `scripts/scan-wallet-stream.ts` does. Read their thresholds for calibration.

### [aaronjmars/MiroShark](https://github.com/aaronjmars/MiroShark) — 1.2k ★ — Python / AGPL-3.0
- Swarm intelligence simulator — spawns hundreds of AI personas to model market outcomes.
- **Why this matters:** if we ever want to test "what would the market do if N news-driven traders all read this headline?" this is the reference. Doesn't directly trade.
- **License:** AGPL-3.0 is even more viral than GPL — be careful if integrating.

### Tier 3 (don't adopt — flagged)

### [warproxxx/poly-maker](https://github.com/warproxxx/poly-maker) — 1.2k ★ — Python / MIT
- Market-making bot with Google-Sheets-based config + gas optimization.
- **DEV'S OWN WARNING IN THE README:** *"In today's market, this bot is not profitable and will lose money."* The Lunar article omits this. The code is fine to study; do NOT run for live trading.

### [Polymarket/agents](https://github.com/Polymarket/agents) — 3.6k ★ — Python / MIT — **ARCHIVED 2026-05-11**
- LLM-powered trading agents framework with RAG + news sourcing + prompt engineering tools.
- **Why this matters:** our `src/lib/agents/oracle-llm.ts` already implements the LLM-evaluator pattern more rigorously (structured output, cached system prompt). Skim the agents repo for prompt-engineering ideas, don't depend on it (archived = no upstream maintenance).

### `RaphaelKrutLandau/polymarket-copy-trading-bot` — DELIBERATELY NOT VERIFIED
- The Lunar article itself flags this repo name as historically used for the December 2025 malware incident (drained `.env` private keys to a remote server). Even if the current repo is benign, copying its name is suspicious. **Do not install. Do not git-clone. Do not read in your IDE without read-only mode.** See [security.md](../../skills/security.md) for the full incident write-up.
