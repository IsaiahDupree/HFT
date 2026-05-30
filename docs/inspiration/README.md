# Inspiration sources

Curated list of repos worth studying for this project. Each entry was
**verified live** (URL, stars, last-update) — ChatGPT-supplied lists often
include hallucinated repos, so don't trust this page if you can't follow a
link to a real `github.com/...` URL.

Last verified: **2026-05-25**.

## How to use this directory

1. Skim [POLYMARKET-OFFICIAL.md](./POLYMARKET-OFFICIAL.md) first — these are
   what we should actually integrate with, not just learn from.
2. [CRYPTO-FRAMEWORKS.md](./CRYPTO-FRAMEWORKS.md) — patterns from mature
   crypto-trading frameworks. We've already ported a chunk (router, risk
   engine, capsules, stages, reconciler, backtester); this catalogs what's
   left to pull.
3. [MIGRATION-TARGETS.md](./MIGRATION-TARGETS.md) — the **shortlist of
   concrete moves** to do next, with effort estimates.

## Highest-leverage next moves

In rank order — based on what gives us the most capability per hour of work:

| # | Action | Source | Why |
|---|--------|--------|-----|
| 1 | **Subscribe to Polymarket real-time WS** | [Polymarket/real-time-data-client](https://github.com/Polymarket/real-time-data-client) | Official channels for `activity`, `crypto_prices`, `clob_user`. We currently roll our own WS — switching is ~half a day and gets us authenticated user-channel events for free. |
| 2 | **Adopt the `agent-skills` skill format** | [Polymarket/agent-skills](https://github.com/Polymarket/agent-skills) | Their skill format (SKILL.md + per-topic deep dives, progressive disclosure) is exactly the shape our research notes should take. We can mirror their structure in `docs/skills/`. |
| 3 | **Add a realistic backtester** | [nkaz001/hftbacktest](https://github.com/nkaz001/hftbacktest) | Our current backtester is mark-to-midpoint. Theirs models queue position + latency + L2/L3 fills. Inspiration only — porting Rust→TS is a project — but the *concepts* (latency simulation, queue model) are portable. |
| 4 | **Migrate to `clob-client-v2`** | [Polymarket/clob-client-v2](https://github.com/Polymarket/clob-client-v2) | We pin `@polymarket/clob-client` v4 — that's the **archived** repo (`Polymarket/clob-client`). The current generation is v2 (different repo, same npm scope). Migrate before the old client stops working. |
| 5 | **Borrow ccxt's adapter normalization** | [ccxt/ccxt](https://github.com/ccxt/ccxt) | We have 2 venues; ccxt has 108+. If we keep adding venues, mirror their *normalized market/order shape* so adapters never reach into venue-specific types past the boundary. |

## Verification corrections (2026-05-25)

After re-verification with direct URLs the user provided:

- **`Polymarket/poly-market-maker` DOES exist** (302 ★, Python, MIT, not archived). My earlier "does not exist" claim was wrong — the org listing page I scraped was paginated and missed it. Treat as a real, official repo. See [POLYMARKET-OFFICIAL.md](./POLYMARKET-OFFICIAL.md).
- **`Polymarket/ts-sdk` is real but pre-release.** 0 releases, beta status, Node ≥24 required. Don't migrate yet — re-evaluate when 1.0 ships.

## See also

- [THIRD-PARTY.md](./THIRD-PARTY.md) — verified third-party Polymarket / prediction-market repos worth studying (PMXT, polymarket-trade-engine, the Kalshi arb bot, etc.)
