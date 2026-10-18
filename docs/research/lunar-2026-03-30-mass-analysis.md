# Lunar: "I Mass-Analyzed 14,000 Polymarket Wallets With Claude" (2026-03-30)

> **Provenance:** Twitter article by [@LunarResearcher](https://twitter.com/LunarResearcher), 2026-03-30.
> Tagged "Paid partnership"; the author's bio explicitly states **"all my content here is sponsored or commissioned"**.
> Multiple affiliate CTAs throughout to kreo.app, Telegram bots, and a "copytrade wallet."
>
> **Status of claims in this file:**
> - ✅ Repo names + functions: verified live (see [verified-repos](#verified-repos))
> - ⚠️ Star counts: article numbers are stale; current counts are 2–8× higher (consistent with promo amplification but also organic growth)
> - ❌ Wallet PnL figures ($4M / $6.12M / $2.4M / $36.6M): not independently verified — testable via Data API
> - ⚠️ "92% of Polymarket traders lose money" — plausible (prediction-market literature broadly supports it) but no citation
> - ⚠️ "Top 0.1% extracted $3.7 billion" — no source
>
> **Treat this file as a research artifact, not a strategy spec.** The math sections are mathematically correct and worth keeping. The numbers and the marketing framing should be discounted.

## Verbatim article (as captured)

> 92% of Polymarket traders lose money. The top 0.1% extracted $3.7 billion. I reverse-engineered their playbook using Claude API, on-chain data, and 12 open-source tools.

> **The Numbers That Should Make You Uncomfortable**
> Polymarket hit $7.94B volume in February 2026 alone. Weekly volume broke $2.1B in March — new all-time high.
> Meanwhile: 87% of wallets are in the red. 14,000+ wallets traded last month. The top 20 wallets captured more profit than the bottom 13,000 combined.

> **The Wallets I Studied (Copy These Profiles)**
> - 🐋 **HorizonSplendidView** — +$4,016,108 total PnL. Trades crypto and macro markets. High-frequency, small edges, massive volume. https://polymarket.com/@HorizonSplendidView
> - 🐋 **beachboy4** — $6.12M profit in a single day. Mostly sports — Tottenham and Sunderland matches netted $1M+ each. Was deep in the red before this. One session changed everything. https://polymarket.com/@beachboy4
> - 🐋 **majorexploiter** — +$2,416,975 in March 2026. Geopolitics and elections only. Doesn't touch crypto. Doesn't touch sports. Laser focus.
> - 🐋 **CemeterySun** — $36.6M volume traded. Tiny edge per trade. Thousands of trades. Market making on steroids.

> **Part I: The 3 Formulas That Separate Winners From Liquidation**

> **Formula 1 — Expected Value:** `EV = P_true × (1 - P_market) - (1 - P_true) × P_market`
> Market says 40%. You believe 60%. Edge per dollar: `EV = 0.60 × 0.60 - 0.40 × 0.40 = $0.20`.
> **Rule:** EV < 5% → SKIP. No exceptions.

> **Formula 2 — Kelly Criterion:** `f* = (p × b - q) / b` where `b = (1 - P_market) / P_market`, `p = true probability`, `q = 1 - p`.
> Full Kelly says bet 33% of bankroll. Never do this. **Use Quarter Kelly.** $1,000 bankroll → bet $83.

> **Formula 3 — Bayesian Updating:** `P(H|E) = P(E|H) × P(H) / P(E)`.
> Inflation prior on Fed rate cut: 55%. After data: `posterior = (0.80 × 0.55) / 0.50 = 0.88`.

> **Part II: The $0 Toolkit — 12 Open-Source Weapons**
> (See `docs/inspiration/THIRD-PARTY.md` for verified entries; full list below.)

> **Part III: The 20-Line Claude Brain**
> ```python
> import anthropic, json
> def claude_probability(market_question, market_price):
>     client = anthropic.Anthropic(api_key="sk-ant-...")
>     response = client.messages.create(
>         model="claude-sonnet-4-20250514",
>         max_tokens=500,
>         messages=[{"role": "user", "content": f"""
> You are a calibrated prediction market analyst.
> Market: {market_question}
> Current price: {market_price}
> Estimate the TRUE probability (0.00-1.00).
> Consider base rates. Penalize extreme confidence.
> If you say 70%, ~7 out of 10 such calls should resolve YES.
> Return JSON only:
> {{"probability": 0.XX, "confidence": "high/medium/low"}}"""}])
>     return json.loads(response.content[0].text)
> ```

> **Part IV: The 5 Mental Bugs**
> 1. Base Rate Neglect — A 99% accurate test on a 0.1% event gives a 9% true positive.
> 2. Sunk Cost Fallacy — "would you buy at 40¢ right now with cash?"
> 3. Survivorship Bias — 87% of wallets are in the red.
> 4. Copying Without Filtering — A wallet has 91% WR on crypto and 15% on politics. Filter by category.
> 5. Overfitting — "Every time X happens" based on 3 examples is noise.

> **Part V: Security Warning**
> December 2025: a GitHub repo called `polymarket-copy-trading-bot` contained malware. Hidden inside a dependency: code that read `.env`, extracted the private key, sent it to a remote server.
> - NEVER use main wallet. Dedicated wallet, minimal funds.
> - Audit every dependency. `pip list`. Google suspicious packages.
> - Repo created after Feb 2026 with 500+ stars → likely star-farmed.
> - Use Revoke.cash to limit USDC approvals.
> - 664 malicious repos on GitHub right now. 14,285 people downloaded malware before anyone noticed.

> **Where to Start Tonight (the article's 4 paths):**
> 1. Data first → `poly_data` + `polyterm`
> 2. Copy smart wallets → `polyterm --type smart` + `polymarket-copy-trading-bot`
> 3. Build a bot → `py-clob-client` + Claude API + the 20-line brain
> 4. Market making → `poly-maker`

## Companion thread (2026-05-25)

> "I was at a coffee shop working on my laptop. The barista asked what I was doing.
> 'Building a trading system.' She laughed. 'You're one of those crypto people.'
> I said no. It's not crypto. It's open-source infrastructure. ..."
> Profile: https://polymarket.com/@xuanxuan008

## Verified repos {#verified-repos}

| Article claim | Verified (2026-05-25) | Note |
|---|---|---|
| `warproxxx/poly_data` 646★ | ✅ **1.9k★** Python GPL-3.0 | "Pipeline for fetching, processing, and analyzing Polymarket v2 trading data" — real |
| `warproxxx/poly-maker` 963★ | ✅ **1.2k★** Python MIT | ⚠️ Dev's own README: **"In today's market, this bot is not profitable and will lose money."** Article omits this |
| `NYTEMODEONLY/polyterm` 32★ | ✅ **274★** Python MIT | Terminal analytics — real; star count grew ~8× (organic or amplified) |
| `pselamy/polymarket-insider-tracker` 63★ | ✅ **143★** Python MIT | ML insider detection — real |
| `Polymarket/agents` 2.6k★ | ✅ **3.6k★** Python MIT — **ARCHIVED May 11 2026** | Article called this "official", which it WAS. Upstream maintenance has stopped |
| `aaronjmars/MiroShark` 285★ | ✅ **1.2k★** Python AGPL-3.0 | Multi-agent simulation — real |
| `pmxt-dev/pmxt` — | ✅ 1.8k★ TS MIT | CCXT for prediction markets — see `THIRD-PARTY.md` |
| `Polymarket/py-clob-client` 947★ | ✅ Archived (replaced by `py-clob-client-v2`) | Per `POLYMARKET-OFFICIAL.md` |
| `Jon-Becker/prediction-market-analysis` — | ✅ **3.4k★** Python MIT | "Largest publicly available dataset of Polymarket and Kalshi market and trade data" |
| `RaphaelKrutLandau/polymarket-copy-trading-bot` — | ⚠️ DELIBERATELY NOT VERIFIED | The article itself flags this name as historically used for malware. Treat with extreme suspicion |

## Wallets to add to `tracked_wallets`

Seeded via `npm run seed:tracked-wallets`. PnL figures are the article's claims (not verified). The seed script's `note` column records the source so we can re-verify.

- **HorizonSplendidView** — crypto + macro, high-freq
- **beachboy4** — sports (one-session windfall, was deep in red before)
- **majorexploiter** — geopolitics + elections only
- **CemeterySun** — market making, $36.6M volume
- **xuanxuan008** — featured in 2026-05-25 thread
- **googoogaga23** — Lunar's own bot wallet (paid promo)

## What we adopted vs what we didn't

**Adopted as code:**
- EV / Quarter Kelly / Bayesian formulas → `src/lib/quant/formulas.ts`
- Star-farmed repo heuristic + dedicated-wallet rule → `docs/skills/security.md`
- Verified repos → `docs/inspiration/THIRD-PARTY.md`
- Cited wallets → `tracked_wallets` via seed script
- The article's "Claude estimates true probability" pattern → already implemented in `src/lib/agents/oracle-llm.ts` (we render through the structured-output schema with cached system prompt, which is more rigorous)

**Deliberately not adopted:**
- Affiliate CTAs (kreo.app, Telegram bots)
- The single 20-line copy-paste script — we have a router + capsule + risk + stage pipeline that's the right surface for production
- `warproxxx/poly-maker` for live trading — even its own dev says it's currently unprofitable
- `RaphaelKrutLandau/polymarket-copy-trading-bot` — flagged for malware history
- "Bookmark this. The tools don't change" — they do change; this catalog needs periodic re-verification
