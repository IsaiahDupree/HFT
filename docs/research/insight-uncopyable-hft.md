# Insight — 4 of 5 article-showcased wallets are un-copyable

**Captured:** 2026-05-26
**Source:** Classifier validation pass against the 5 wallets featured in `daniro-2026-05-25-1000-polymarket-bots.md`

---

## The quote (verbatim from session)

> 4 of 5 are un-copyable HFT. The "trader using Stoikov-style logic" the article showcases as adaptive execution is exactly the kind of wallet we tag `un_copyable` — Stoikov is a speed advantage, and we can't out-speed sub-100ms market makers. Only `0x6e1d5040` (the one we already deep-analyzed) is `potentially_copyable`.

---

## Why this matters

The Daniro article frames 5 wallets as success-story exemplars: bonereaper, 0x6e1d5040, 0xb55fa1 (Hermes), 0xce25e214 (Stoikov), flippingsharks. The article-promoted narrative is "look at these big winners, here's how to find more."

When our classifier runs against them with the actual on-chain data:

| Wallet | Article framing | Classifier verdict |
|---|---|---|
| bonereaper | "$100/min" success | **hft_bot — un_copyable** |
| 0x6e1d5040 | "knows how to use the lag" | **conviction_trader — potentially_copyable** |
| 0xb55fa1 (Hermes) | "Arb 5/15 min" | hft_bot — un_copyable |
| 0xce25e214 | "Stoikov-style logic" | **hft_bot — un_copyable** |
| flippingsharks | "10 days $46K" | **hft_bot — un_copyable** |

**80% of the article's showcase wallets are wallets you literally cannot copy profitably.** Stoikov-style execution, repricing latency, cross-timeframe latency — these are SPEED edges. By the time the data API surfaces the trade to you, the edge is gone. Copying them with N-second lag is a structural losing trade.

This is the **single most important finding from this entire research pass**. It validates the typology classifier's core purpose: a scanner that ranks wallets by raw PnL would surface these 4 wallets, and an operator copying them would lose money. A scanner that classifies first surfaces the ONE wallet that's actually copyable.

---

## The implication for product

A wallet-discovery / "find more like this" feature in our app should:

1. **Always run typology classification first.** Never surface a wallet on a leaderboard or "top traders" view without its `copyabilityClass` chip.
2. **Default-filter to `potentially_copyable`** in any "actionable" view. Show the HFT bots only in an explicit "all traders" view with the un-copyable warning visible.
3. **Educate the operator** that high realized PnL is necessary but not sufficient — the strategy must also be slow enough to copy. A $50M HFT wallet is fascinating to study; a $2M conviction trader running a 14-day-resolution NO-scrape is actually copyable.

This is also why the article's whole pitch — "I analyzed 1000 bots, here's how they make $100K/month, here are their wallets" — is misleading-by-omission for any reader who plans to act on it. The $100K/month wallets are mostly the ones you can't replicate.

---

## What we actually did with this

- Tagged the insight as a saved research artifact (this file)
- Stamped it in `daniro-2026-05-25-report.md` as the headline finding
- Used it as the basis for the strategies PRD — the near-resolution scraper (#1) is the ONE strategy from the article that's both **proven** (0x6e1d5040 banked $2M) and **copyable** (slow-resolving markets, not speed-driven)
- Stored as feedback memory: don't over-rely on flashy PnL screenshots — always demand the realized vs. mark-to-market distinction

---

## Counter-argument considered

> "But what if you build infrastructure to compete with the HFT bots — would they then become copyable?"

This is the same trap the article subtly pushes. Two answers:

1. **Infrastructure arms race.** Competing at sub-100ms requires co-located servers, dedicated WS connections, custom Rust/C++ execution stack. The article mentions HyperBuildX as "Rust with sub-100ms latency" — that's the minimum bar to compete. Building that is a 6-month, 6-figure investment. Even then, you're competing with people who do only that for a living.

2. **The faster you go, the smaller the edge per fill.** At sub-100ms you might capture 0.1-0.5% per fill instead of 1-5%. You need 10-50× the fill rate to match the absolute PnL of a slower strategy. That requires capital we don't have access to and risk we don't want.

The right call: **don't compete in the speed game.** Find strategies measured in minutes-to-days where breadth beats speed. That's exactly what the near-resolution scraper is — its edge lives over weeks, not seconds.

---

## Permanent placement in the repo

This insight is the philosophical foundation for:
- The typology classifier (`src/lib/wallets/typology.ts`)
- The `copyabilityClass` enum (specifically the existence of `un_copyable` as a distinct class)
- The strategies PRD (`docs/prd/strategies-2026-05-26.md`) — all 3 chosen strategies are slow-to-moderate cadence, not speed-dependent

If we ever consider building infrastructure to chase the HFT bot game, re-read this file first.
