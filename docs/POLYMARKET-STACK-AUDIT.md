# Polymarket Stack Audit — the "28 tools / $1M bot" article, verified

**Date:** 2026-06-10
**Source:** viral X article by @antpalkin (paid partnership, kreo.app referral payload)
**Method:** every repo vetted via GitHub API (no code run), wallet verified on-chain via
Polymarket data APIs, lag measured live with `scripts/binance-poly-leadlag.ts`.
**Stance:** TRADING_POLICY.md — edge-seeking, anti-delusion. Analyze the claim, don't worship or dismiss it.

---

## 1. The headline wallet is REAL — but the strategy is not what the article says

Wallet `0x55be7aa03ecfbe37aa5460db791205f7ac9ddca3` (@coinman2), verified 2026-06-10:

| Metric | Verified value | Source |
|---|---|---|
| All-time realized profit | **$1,090,424** | lb-api.polymarket.com/profit |
| All-time volume | **$79.1M** | lb-api.polymarket.com/volume |
| Margin on volume | **~1.4%** | computed |
| Span | 558 days (Nov 2024 →) | user-pnl-api |
| Average daily PnL | $1,951/day (last 90d: $1,870/day) | computed |
| Losing days | **40%** of days | computed |
| Worst single day | **-$145,806** | computed |
| Max drawdown | **-$349,233** | computed |
| Open positions now | ~$99.6k | data-api /value |

**What the tape actually shows** (last 100 events): ~18 events/hour, average clip **$123**,
all BUY side at avg price 0.553, **MAKER_REBATE** income, and **MERGE** events.
Translation: it buys BOTH Yes and No when the pair sums under $1.00, merges complete sets
back to $1 USDC, and posts maker quotes anchored to a CEX fair-value feed on short-duration
crypto binaries (5-min Up/Down, daily strikes).

**This is two-sided market-making + complement arbitrage — NOT taker latency sniping.**
Consequences:
- **Copy-trading it cannot work.** A maker's fills ARE its edge; copying fills at market
  price hands the spread to someone else. The article's kreo.app referral pitch is
  structurally broken for this wallet, which is precisely why it's a paid partnership.
- The realistic replication is to BE the maker: fair-value model from Binance/Coinbase WS
  → two-sided quotes on Polymarket binaries → merge complete sets → collect rebates.
- The bankroll requirement is real: surviving a $349k drawdown to make $1M means this is
  not a "$1,000 starter" strategy at the wallet's scale. At small scale the same mechanics
  apply with proportionally small absolute PnL.

## 2. The "2.7 second lag" claim — measured live

See `scripts/binance-poly-leadlag.ts` (new). Two measurements: cross-correlation lead-lag
(Binance trade returns vs Polymarket mid returns) and an event study (Binance move ≥5bps →
seconds until Polymarket reprices ≥1¢, and how often it never does).

**Result (2026-06-10, ETH daily-strike market):** see "Measurements log" at the bottom of
this file — rerun the script any time; the number decays as competition grows.

## 3. Repo vetting — 23 repos + 4 services

### Astroturf evidence (why this article ≠ a curation)
- `HyperBuildX/Polymarket-Trading-Bot` and `FiatFiorino/polymarket-assistant-tool`:
  **repo AND owner accounts removed from GitHub** — the banned-bot-shop/stealer signature.
- `dylanpersonguy/Polymarket-Trading-Bot` (the "53k lines, 7 strategies" one): deleted/private post-promo.
- `cvxv666/ClaudeAgentOneClick` (the author's own): a rebadged fork of someone else's
  generic VPS kit, zero Polymarket code, one day of commit activity, Telegram course link.
- `calesthio/Crucix`: described as "Polygon whale aggregator" — it's actually an OSINT
  globe dashboard (fires/flights/radiation). The author never read it.
- `msitarzewski/agency-agents` and `obra/superpowers`: mischaracterized (persona prompt packs
  / Claude Code dev methodology, not trading debate frameworks or agent runtimes).
- Payload at the end: kreo.app — custodial copy-trade bot, per-trade fees, referral economics.

### ADOPT (clone into quarantine, read before running, never with funded keys)
| Repo | What it is | Why |
|---|---|---|
| `evan-kolberg/prediction-market-backtesting` | Nautilus Trader extension with Polymarket adapters, fee/slippage/latency models, Brier scoring. 476 commits, CI. | The one repo that strengthens our verification machinery — timestamp-correct historical Polymarket backtests. |
| `NYTEMODEONLY/polyterm` | View-only Polymarket terminal (whale tracker, arb scanner). On PyPI, 1,133 tests, never touches keys. | Safe monitoring. `pipx install polyterm`, not curl-bash. |
| `ent0n29/polybot` (ingestion half ONLY) | Redpanda/ClickHouse/Grafana market-data pipeline + complete-set arb strategy, Java. | The analytics-pipeline design is solid. Execution half wants a plaintext private key — line-audit before any funding, or just mine the design. |
| `tradingview/lightweight-charts` | TradingView's official TS charting lib (Apache-2.0). | Drop-in for the Next.js dashboard. |

### IDEAS-ONLY (read for concepts; don't run)
| Repo | The idea worth taking |
|---|---|
| `Polymarket/agents` (ARCHIVED Nov 2024) | Official py-clob-client usage patterns. |
| `txbabaxyz/polyrec` + `mlmodelpoly` | Fair-value model for 15-min BTC Up/Down: Chainlink oracle + Binance feed + time-to-expiry → implied probability. Small (29KB/3 commits); read in an afternoon. Stars likely botted/X-driven; code itself is clean and keyless. |
| `TauricResearch/TradingAgents` | Bull/Bear/Risk-Manager LLM debate roles (the thing agency-agents was falsely credited with). |
| `virattt/dexter` | TypeScript autonomous research agent loop patterns. |

### SKIP
Everything else: gone (HyperBuildX, FiatFiorino, dylanpersonguy), irrelevant
(G0DM0D3 jailbreaks, Qwen3-Coder weights, MiroThinker, claude-squad, fredapi, OpenBB,
financial-datasets MCP — wrong asset class or duplicates Claude/ACD capability we have),
or author padding (ClaudeAgentOneClick).

### Round 2 — 2026-06-11 (discovery beyond the article's list)

Method: GitHub search API (`gh`, read-only) across "polymarket bot / market maker /
arbitrage / copy / historical data / btc updown / 5 minute", sorted by stars AND
recently-updated; owner-account vetting (age, repo history, followers); install-hook
review of every candidate's package.json/pyproject (no preinstall/postinstall/build.rs
in any ADOPT below); stargazer-sample bot checks on fast risers; plus the
starred/forked graphs of the legit Round-1 authors (evan-kolberg, NYTEMODEONLY,
ent0n29). All ADOPTs shallow-cloned into `~/Documents/Software/quarantine/` and
pattern-scanned (no base64-decode/eval/exfil hits). NOTHING installed or run.

Endorsement signal used: **evan-kolberg forks `warproxxx/poly_data`** — the one
author we trust most points at the warproxxx data stack.

#### ADOPT (cloned to quarantine 2026-06-11; read before any run, never funded keys)
| Repo | What it is | Why |
|---|---|---|
| `warproxxx/poly_data` (2.1k★, owner 2016) | Polymarket data pipeline: markets, order events, trades (on-chain + API), pandas/polars. | Historical-data tooling; forked by evan-kolberg himself; deps clean. |
| `warproxxx/poly-maker` (1.3k★) | THE reference open Polymarket market-making bot (py-clob-client, merge logic, position mgmt). | Direct read for our binary-maker lane. Wants `PK` in .env as any live MM would — read-only, never fund. |
| `pmxt-dev/pmxt` (1.9k★, org Jan 2026) | "CCXT for prediction markets" SDK + the vendor whose FREE hourly L2 archive (r2/r2v2.pmxt.dev) our G3 path uses. | We now depend on their archive; SDK is self-hosted/free; clean scripts. |
| `KaustubhPatange/polymarket-trade-engine` (279★, organic stars per sample; owner 2016, known OSS dev) | TS trading engine specifically for BTC Up/Down 5-min binaries (clob-client-v2, strategy framework). | Exactly our market family; active through 2026-06-08. |
| `guzus/dr-manhattan` (187★, owner 2019) | Python unified prediction-market API + MCP server + backtest dir; MM examples. | Second data/MM toolkit perspective vs pmxt; clean pyproject. |
| `doge-8/btc5m-web` (13★, owner 2021) | Quick-order tool + pluggable strategy framework + data collector for Polymarket BTC/ETH/SOL 5m. | Small/readable; its `collect` path is a 5-min-series recorder. Wants PK for live — never fund. |
| `ElijahPrince73/polymarket-btc-5m-assistant` (9★ Rust, owner 2015, pushed Jun 10) | Paper-trading assistant for BTC 5m Up/Down; paper-only when keys blank. | Keyless-by-default design; documents series slug `btc-up-or-down-15m`, series id 10192, and the 2026-04-28 CLOB V2 cutover. |

#### IDEAS-ONLY (round 2 — read for concepts; don't run)
| Repo | The idea worth taking |
|---|---|
| `YazRaso/polymarket_historical_orderbook_reconstruction` | A pipeline decoding the same PMXT hourly raws we'll port — compare decode logic. |
| `MixasV/Polymarket-recorder` | Minimal 15m BTC Up/Down price-recorder design. |
| `Polymarket/poly-market-maker` (official, 303★, stale 2024) | Canonical band/order-management patterns from Polymarket themselves. |
| `Jonmaa/btc-polymarket-bot` (73★, dead Jan 2026) | Prior-era 15m Up/Down bot — what the last cohort tried. |
| `polyresearchrobotics/UpDownWalletMonitor` (new acct) | Real-time wallet-tracking across 5m markets — read for our observe:wallet lane. |
| `OctagonAI/kalshi-trading-bot-cli` (316★, real co) | AI research→trade CLI structure for Kalshi. |
| `Drakkar-Software/OctoBot-Prediction-Market` (real OctoBot org) | Generic PM extension architecture. |
| `braedonsaunders/homerun` (81★, owner 2017) | Polymarket+Kalshi Python strategy platform — overlaps what HFT-work already has. |
| `aarora4/Awesome-Prediction-Market-Tools` (471★) | Link mine — but several entries are the very bot-shops banned below. |
| `LeonardoBerti00/TLOB` (starred by evan-kolberg) | Transformer LOB price-prediction model — fair-value research direction. |

#### SKIP / BANNED (round 2)
| Repo | Reason |
|---|---|
| `YichengYang-Ethan/oracle3` (248★) | **Stars BOTTED** — stargazer sample is batch-created zero-follower farm accounts. |
| `sitodowubb/polymarket-arbitrage-bot` (227★, **7,444 forks**) | Fork-farm distribution; spam description; owner Jan-2026, 0 followers. |
| `Composio-HQ/polymarket-kalshi-arbitrage-bot` (68★, **2,970 forks**) | **Typosquat** of real ComposioHQ; week-old single-repo owner; fork-farm. |
| `Obsidian-Trades/polymarket-copy-trading-bot` (50★/455 forks) | Repo created+abandoned same day; owner 9 days old. |
| `PolyBullLabs/polymarket-5min-15min-1hour-arbitrage-trading-bot` (226★) | Forks>stars; owner account YOUNGER than the repo (transferred-in); bot-shop. |
| `radioman/polymarket-arbitrage-trading-bot` (466★) | Repo "created 2016" — renamed old repo to inherit age/stars; Polymarket didn't exist then. |
| `hanshaze/Awesome-Prediction-Market-Trading-Tools` (178★) | Same renamed-2017-repo trick; serial bot-shop owner (359 repos). |
| `echandsome/Polymarket-betting-bot`, `G3-DEV-AGENCY/*`, `TradeSEB/*`, `devdasx/*` | Freelancer/agency lead-gen copy-bot clones; copy-trading is structurally broken for the maker wallet anyway (§1). |
| `HarrierOnChain/Prediction-Markets-Trading-Bot-Toolkits` (270★) | "Toolkits" aggregator lead-gen. |
| `0mnjb/Kalshi-AI-Trading-Bot` + `llllllilllll/Kalshi-Trade-Bot` + `AsArchitects/Kalshi-trade-bot` | README-only scam farm: three ~80★ no-code repos created the same week (Mar 2026). |
| `quipmnxailcrrgky/tradingbot`, `bit-nexusxtitmtdsuy/Polymarket_Bot` | Gibberish-name owners; bot-shop signature. |
| `meloner3/poly-kalshi-sports-bot` (128★) | Single-day commit history; sports, off-thesis. |
| `suislanchez/polymarket-kalshi-weather-bot` (432★), `ryanfrigo/kalshi-ai-trading-bot` (428★) | Off-thesis (weather/LLM-Kalshi); star authenticity unverified. |
| `Thuglife22741/polymarket-BTC-15-Minute-Trading-Bot`, `dearolaf/Polymarket-BTC-5Minutes-Trading-Bot` (created Jun 8–10) | Day-old unvetted clones chasing the 5/15-min relaunch — but good *evidence the lane is hot again*. |

Flag, not a ban: `alsk1992/CloddsBot` (356★) ships a `postinstall` npm hook
(caches a Xenova embedding model — looks benign) AND is a key-custodial
multi-chain agent (Drift/Jupiter/Kamino SDKs). Surface too big; ideas only,
never install.

Cross-reference: the G3 data assessment for the Round-1 ADOPT
(`evan-kolberg/prediction-market-backtesting`) is in
`docs/research/EVAN-KOLBERG-BACKTESTER-ASSESS.md` — bottom line: PMXT free R2
archive (2026-02-21→now, verified live by HEAD probes) + our own eth_getLogs
fills = $0 G3 data path; Telonex $79/mo only if we need pre-Feb-2026 depth.

### Services
- `polymarketanalytics.com` — legit free analytics, "supported by Polymarket". Useful.
- `polywhaler.com` — real SaaS; data tier maybe; pushes referral copy-bots. Caution.
- `thepolyscope.com` — $20 course. Skip.
- `kreo.app` — the article's referral payload. Custodial smart-wallet copy-trading,
  fee per trade. Structurally cannot replicate a maker's edge. Skip.

## 4. What HFT-work ALREADY has (the article's six layers, mapped)

| Article layer | Already in HFT-work | Forward evidence |
|---|---|---|
| 1 Brain | Claude API integration (`src/lib/anthropic`), strategy-factory, arena evolution | arena/evolution_log in data/polymarket.db |
| 2 Orchestration | ACD dispatch + arena:tick/evolve/allocate + proof-council, trade-advocate | championship_log |
| 3 Data | Binance WS+bulk (5yr/100sym on passport), Coinbase, dYdX L2, Chainlink oracle snapshots, CoinDesk, lead-lag lib | `/Volumes/My Passport/hft-data` manifest, 2,965 verified files |
| 4 Market intel | scan:leaderboard, observe/classify:wallet, backfill-wallet (on-chain fills via eth_getLogs), smart-money realizedStats, whale consensus | wallets.db 351MB, hl-copy-backtest-results.jsonl |
| 5 Backtest | walk-forward, PBO, Deflated Sharpe, shuffle controls, copy-backtest (no-lookahead), L2 backtester, maker-fill model | backtest gauntlet in src/lib/backtest |
| 6 Execution | Polymarket CLOB client (creds derived), dYdX MM engine, arb:runner, worker:nrs-exec | reconcile-polymarket-fills |

**Genuinely missing pieces (the real to-do list):**
1. **Binary fair-value maker** — ✅ BUILT 2026-06-10 (see §7). The coinman2 replication:
   Binance WS → implied prob for daily/hourly digital binaries → two-sided CLOB quotes +
   complement-merge. Reused `scan:complement-sum`, the AS-market-maker lib, and the
   maker-fill model; added the pricer + quote engine + paper loop.
2. **Polymarket historical tick data** for honest backtests — adopt evan-kolberg's data
   adapters (PMXT/Telonex vendors) instead of building from scratch.
3. **Live lag monitor** — `binance-poly-leadlag.ts` (added today) run on cron, logging to
   passport, so we KNOW when the window narrows instead of reading about it.

## 5. The plan (gated, in order)

Each gate must pass before the next step gets effort. Same discipline as the liq-cascade
strategy (which honestly failed its 5-year backtest and was shelved — that's the system working).

- **G0 (done):** Verify the hero wallet → PASSED, but strategy reclassified as maker/merge.
- **G1:** Lag + microstructure measurement on 5-min Up/Down markets across a week of crons.
  Output: median reprice latency, stale-quote frequency, spread distribution, depth.
  → If stale windows ≥ spread+fees exist daily, taker sniping is live; if not, maker path only.
- **G2:** Binary fair-value pricer + paper maker on ONE market family (BTC 5-min Up/Down).
  Paper fills via the maker-fill model against captured L2. 2 weeks minimum forward paper.
- **G3:** Backtest with evan-kolberg adapters on real Polymarket history; walk-forward + PBO
  + DSR + shuffle, same gauntlet as everything else.
- **G4:** Tiny live capsule ($100-500) via the existing capsule/arena allocator, with the
  daily-loss halt. Scale only on realized (not paper) edge over ≥4 weeks.

**Bankroll honesty:** coinman2 earns ~$2k/day on what is plausibly a six-figure working
bankroll with $349k max DD tolerance. At a $1k bankroll, the same Sharpe implies single-digit
dollars/day at first. "High profit rate per day" comes from compounding + scale, not from a
magic repo.

## 7. The binary fair-value maker — BUILT + tested (2026-06-10)

The coinman2 replication's core, implemented and unit-tested. Three new pure libs + a paper loop:

| File | What it does | Tests |
|---|---|---|
| `src/lib/strategies/binary-fair-value.ts` | Digital-option pricer: `P(S_τ > K) = Φ(ln(S/K)/(σ√τ) …)` from the **CEX feed** (the independent fair value the stale market mid hasn't caught up to). Symmetric log-walk default (ATM=0.5); optional `volDrag` for the GBM price-martingale convention. `fairValueFromMinuteCloses` estimates σ from recent 1-min closes and prices in one call. | 19 |
| `src/lib/strategies/binary-maker.ts` | `planQuotes`: fair value → two-sided YES quotes with logit-space A-S inventory skew (reuses `as-market-maker.ts`), a fee/rebate-aware min-edge gate, hard + boundary inventory caps, and a no-cross/improve-the-touch book clamp. Plus `mergeableSets` for complement-merge accounting. | 16 |
| `scripts/binary-maker-paper.ts` (`npm run maker:paper`) | Live PAPER loop: Binance spot (WS, proxied) + Polymarket CLOB book (proxied REST) → fair value → quotes → trade-driven fills → inventory/cash/rebate/PnL (marked to both fair and market) → persisted to `binary-maker-paper.db` on the passport. NO real orders. | live |

All 35 new unit tests pass; the full repo suite (4,471 tests / 200 files) stays green.

### What the live paper runs revealed (the honest part)

Five short runs on the BTC "above $62,000 on Jun 11" terminal digital (2026-06-10 evening):

1. **The pricer works on live data.** Spot $62,278 → fair 56.9¢; as BTC ran to $62,364, fair
   rose to 59.2¢ in lockstep. Correct, real-time, no lookahead.
2. **The market priced ~3¢ ABOVE our fair the whole time** (market 60¢ vs our 57¢). Our
   zero-drift symmetric model is demonstrably **not better than the market** here — the market
   is plausibly pricing recent upward drift/momentum our model ignores. *A maker only profits
   if its fair value beats the market's; on this market, ours didn't.* That's the central
   finding and it's exactly what the forward track is for.
3. **Data-access limits fill realism from this box.** The CLOB **trade WS is geo-blocked**
   (delivers nothing without the proxy agent), and the REST `last_trade_price` is **stale/
   outlier-prone** (it served a 40¢ "print" against a 57/58¢ book that briefly triggered a
   phantom fill). Added an outlier guard (reject prints >3¢ outside the touch). Net: this
   environment validates the LOGIC and accounting, but a **trustworthy G2 forward-paper track
   needs real-time trade data** — proxied CLOB trade WS, or running from an unblocked IP.

### Bugs found and fixed during the build (each was real)
- **Vol-drag default**: GBM `−½σ²` term pushed ATM below 0.5, giving the maker a systematic
  short tilt that isn't an edge → defaulted it OFF (symmetric log-walk).
- **`max(baseHalfSpread, minEdge)`** made every posted side trivially clear the edge gate →
  removed; the gate now genuinely fires on book/skew compression.
- **`reduce(…, NaN)`** seed: `Math.max(NaN, x)` is NaN → poisoned every book fold (also silently
  starved the lag probe). Seed with ∓Infinity.
- **Native `fetch` ignores `HTTPS_PROXY`** → Polymarket geo-blocked calls failed silently; route
  book reads through the proxy-aware `poly` client.
- **Ask pinned to `bestAsk`** ("don't cross") pushed quotes OUT of the spread → unfillable;
  corrected to forbid-cross-but-allow-improve.

### Modeling caveat (important)
The pricer models **terminal digitals** ("above $K on [date]"). It does NOT price **one-touch
barriers** ("will BTC *reach*/*dip to* $K in June") — those need barrier-option math. Point the
maker only at "above/below $K on [date]" and Up/Down (strike = candle open) markets.

### Next on this lane (unchanged gates, now concrete)
- **CORRECTION + bug (2026-06-11 00:30 ET):** the first night of daemon sessions was POISONED by a
  wrong-strike bug, and the honest machinery caught it via impossible fair-vs-mid divergence. The
  Up/Down family runs THREE series at once — hourly, 15-min, and **5-min (the article's original
  venue, back as of 2026-06-10: ":35/:40/:45…" expiries)**. The daemon assumed every range-titled
  market was 15-min, so 5-min markets got the previous candle's open as strike → fairs off by
  40¢+ while the market was RIGHT. What looked like "live stale-market cases" (fair 65–95¢ vs mkt
  41–51¢) was OUR bug, not edge — a textbook lesson in trusting divergence only after the
  reference data is verified. Fixed: `rangeDurationMinutes` (updown-title.ts, 7 regression tests)
  parses the true duration from the title; the paper script now has an `--abort-divergence`
  self-check (median |fair−mid| > 35¢ over the first 8 ticks ⇒ STRIKE-SUSPECT, exit 2, daemon
  blacklists the market); `bm_sessions` records the question for forensics; the 9 poisoned
  sessions were purged from the paper DB (6 valid daily-strike sessions remain).
- **G2 forward track** — ✅ RUNNING as of 2026-06-10 23:28 ET (restarted with the strike fix
  2026-06-11 00:11 ET; the ≥2-week clock restarts then). `maker:paper:daemon`
  (`scripts/maker-paper-daemon.ts`) rolls the paper maker market-to-market unattended:
  Gamma-discovers the soonest BTC Up/Down market (hourly AND the 15-minute series, which is
  BACK as of 2026-06-10 — gamma shows live "11:15PM-11:30PM ET" markets — and is the
  highest-delta venue available), derives the strike from the Binance candle open, runs
  `binary-maker-paper` until expiry, repeats. launchd KeepAlive job
  `com.isaiahdupree.hft.makerpaper` (logs: /tmp/hft-makerpaper.log). Judge with
  `maker:paper:report` — per-session paper PnL + the baseline-vs-enhanced Brier A/B against
  the approximate realized outcome (knife-edge sessions excluded, optimistic-fill caveat
  stands). The ≥2-week clock starts now; still wanted: proxied CLOB trade WS for fill realism.
- **Improve the fair value** — ✅ BUILT 2026-06-10 (same day, second pass). A maker with a fair
  value no better than the mid has no edge — this was the make-or-break. Two opt-in upgrades in
  `binary-fair-value.ts`, both default-OFF (baseline bit-identical), 34 unit tests, suite green:
  - `estimateDriftPerBar` — EWMA momentum with t-stat (signal-to-noise) shrinkage
    μ_use = μ̂·t²/(1+t²); choppy tape → 0 (no false momentum), sustained trend → tilt. A
    pricing-level cap |drift_total| ≤ capSigmaMult·σ_total (default 1) keeps a trend from ever
    dominating diffusion.
  - `estimateHorizonSigma` — variance-ratio scaling: σ(n bars) = σ_bar·n^H with
    H = ½ + ln(VR)/(2·ln k), clamped [0.35, 0.7]; honest H=0.5 fallback when the buffer is too
    short for a VR. Fixes the 1-min→14h √t understatement.
  - `maker:paper` now computes BOTH models every tick and snapshots them side by side
    (`p_fair_base`/`p_fair_enh`/`mu_per_hour`/`hurst` columns; `--fv enhanced|baseline` picks
    which one quotes, default enhanced). The forward track is therefore a live A/B — whether
    the enhanced fair actually beats the market is decided by data, not by the modeler.
- A cross-session sibling effort (`polymarket-2dollar-bot`/`TradingBot2`, see memory) independently
  forward-walked 21 paper daemons and concluded the **only surviving theses are structural lanes:
  merge-maker + rebates, LP rewards, small near-cert taker** — copy-trading and 3-down reversion
  were FORWARD-FALSIFIED. That corroborates this lane (merge-maker + rebates) and warns off the
  others. Reconcile the two efforts before any capital.

## 6. Quarantine protocol for adopted repos

```bash
# NEVER clone article repos into HFT-work (its .env.local holds funded keys).
mkdir -p ~/Documents/Software/quarantine && cd ~/Documents/Software/quarantine
git clone https://github.com/evan-kolberg/prediction-market-backtesting
git clone https://github.com/NYTEMODEONLY/polyterm
git clone https://github.com/ent0n29/polybot
# read package.json/setup.py for install hooks BEFORE any install
# pipx for polyterm; venv-isolated for the backtester; polybot: read-only design review
```

## Measurements log

| Date | Market | Binance→Poly best-lag (xcorr) | Event-study median reprice | Stale ≥30s | Notes |
|---|---|---|---|---|---|
| 2026-06-10 | ETH >$1,600 Jun-13 daily strike | n/a — 0 book updates in 180s | n/a | n/a | market too quiet ($955/24h); added REST poller |
| 2026-06-10 | BTC >$62,000 Jun-11 strike (mid 0.465, NTM) | ~11.3s, corr 0.24 (weak, n small) | — | **2/2 events no reprice in 30s** | 13,166 Binance trades vs **5** Poly mid updates in 300s. Quotes are sticky for tens of seconds — but a 5bps BTC move barely shifts a daily binary's fair value, so stickiness ≠ edge at this threshold. Rerun with --move-bps 20-30 and on the hourly Up/Down series where delta is large. |
| 2026-06-10 | BTC Up/Down 11PM ET HOURLY (mid 0.41, τ 43min, $12.4k/24h) | **0.50s, corr 0.32** | — | 0 events ≥10bps in a quiet 60s window | First hourly-series datapoint: repricing on the hourly Up/Down is ~20× faster than the daily strike — competition is live there. The G1 question is now how OFTEN the stale triple still appears at ≥20bps; the cron answers it. |

**G1 campaign is automated as of 2026-06-10:** `npm run leadlag:campaign`
(`scripts/leadlag-campaign.ts`) auto-discovers the livest NTM near-expiry BTC/ETH binaries via
Gamma each run, measures each (300s, ≥20bps), and appends structured rows to
`leadlag-campaign.jsonl` (passport). Scheduled hourly at :48 by
`~/Library/LaunchAgents/com.isaiahdupree.hft.leadlag.plist` (logs: /tmp/hft-leadlag.log). After
~a week, the G1 verdict (taker sniping live vs maker-path-only) comes from those counts.

**Interpretation so far:** the article's "2.7s lag" framing belongs to the 5/15-min series,
which in June 2026 appears to have been replaced by HOURLY Up/Down + daily strikes
(gamma shows 5-min markets only up to ~Jan 2026). On daily strikes Polymarket is much
slower than 2.7s — effectively minutes — but the exploitable combination is (big CEX move)
× (high-delta market near expiry) × (stale quote wider than spread+fees). That triple is
what the G1 cron campaign must count per day. The maker path (coinman2's actual strategy)
does not depend on winning that race — it profits from being the one who reprices.
