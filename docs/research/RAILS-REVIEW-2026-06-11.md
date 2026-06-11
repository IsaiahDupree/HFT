# Rails Review — binary maker paper track (2026-06-11)

Code review of the G2 forward-paper rails built 2026-06-09→10: `scripts/binary-maker-paper.ts`,
`scripts/maker-paper-daemon.ts`, `scripts/maker-paper-report.ts`, `scripts/leadlag-campaign.ts`,
`scripts/binance-poly-leadlag.ts`, `src/lib/strategies/binary-fair-value.ts`,
`src/lib/strategies/binary-maker.ts`, `src/lib/strategies/updown-title.ts`, and their use of
`src/lib/strategies/as-market-maker.ts`. Review only — no code changed.

**Live context being explained:** ~18h forward track, 183 paper sessions on BTC 5-min/15-min/hourly
Up/Down. Paper PnL −$2,066 (optimistic fills), 1,650 fills, rebates only $118. Sessions repeatedly max
the 250-share inventory cap directionally and ride it into resolution (±$100 per-session swings).
Model A/B: baseline Brier 0.1068 beats enhanced 0.1105. Wallet forensics: profitable makers on these
markets run $1–14 median fills, quote the 0.02→0.99 lifecycle, requote ~3s, and the big winners are
MERGE/pair makers, not naked one-token quoters.

Stance per `TRADING_POLICY.md`: the maker thesis (price off the CEX feed, get paid by stale flow) is
still live — the forward track is doing its job by losing *visibly*. The findings below are what the
rails must fix before the −$2k can be trusted as a verdict on the strategy rather than on the
plumbing, and what the strategy itself is missing vs the verified winners.

Verdict in one line: **the current loop is a naked directional inventory accumulator with a
self-disabling exhaust valve, scored against a partially circular label, on a fill simulator whose
optimism and pessimism both point the wrong way at once.** Fix P0 items, rerun the track, then judge.

---

## P0 — Correctness bugs (these distort the −$2,066 and the A/B verdict)

### 1. The minEdge gate withdraws the inventory-REDUCING quote exactly when inventory is at cap

**Where:** `src/lib/strategies/binary-maker.ts:143-151` (gate), interacting with the A-S skew from
`src/lib/strategies/as-market-maker.ts:63-65` and the params at `scripts/binary-maker-paper.ts:202`.

**What happens (verified by arithmetic, not assumption).** When long, the reservation is skewed down
by `q·γσ²τ` in logit space. The ask (the side that would *reduce* inventory) is priced at
`reservation + half`, so its measured "edge vs fair" is `half − skew + rebate`. The gate at
`binary-maker.ts:149` requires this to clear `minEdge` — i.e. the exhaust valve is held to the same
profitability bar as the accumulating side. With the daemon's actual params (γ=0.08, σ=0.25,
half=0.02, minEdge=0.008, rebate≈0.0036/share at p≈0.5):

- price-space skew at p=0.5 ≈ `q·0.005·τ·0.25`. The ask survives only while skew ≤ 0.0156, i.e.
  `q·τ ≤ 12.5 share·hours`.
- **Hourly session at q=250:** τ>0.05h ⇒ ask withdrawn. The reducing quote is dead for the first
  ~57 minutes of the hour. Bid is dead too (hard cap, `binary-maker.ts:140`). Net: both sides
  withdrawn → the position rides to resolution. This is precisely the observed cap-and-ride.
- **5-min session at q=250:** ask withdrawn for the first ~2 of 5 minutes, returns only as τ decays.

So the only de-risking mechanism in the whole system (opposite-side fills) is disabled by its own
edge gate whenever it's needed most. The −$2,066 is dominated by exactly these ridden positions.

**Fix sketch:** exempt (or use a separate, lower/negative `minEdgeReduce` for) the side that reduces
|inventory|. A reducing fill at `fair ± ε` is portfolio-positive even at zero quote edge because it
cancels resolution variance. Concretely in `planQuotes`: compute `reducingSide = inv > 0 ? ask :
bid`, gate that side with `minEdgeReduce` (default ≤ 0, e.g. −0.005), keep `minEdge` for the
increasing side. Add a test: at q = maxInventory with realistic τ, the reducing side must be active.

### 2. Final mark falls back to mid = 0.5 when the last book fetch fails — up to ±$125/session of fake PnL

**Where:** `scripts/binary-maker-paper.ts:363-364`:
`const markMid = lastBook ? (lastBook.bid + lastBook.ask) / 2 : 0.5;`

**Why it matters.** Sessions end 20s before expiry with up to 250 shares of inventory in a market
whose true value is by then ≈0 or ≈1. If the final `fetchBook()` fails (proxy flake — the same flake
the context confirms is intermittent), a long-250 position in a market resolving YES is marked at
$125 instead of ~$250 (and symmetrically the other way). This noise feeds straight into
`summary.pnlMarkUsd`, which is what `maker-paper-report.ts:80-81` sums into the −$2,066 headline.
Same problem in milder form even when the fetch succeeds: near-expiry books are often wide/garbage
(1¢/99¢ ⇒ mid 0.5 on an effectively-resolved market).

**Fix sketch:** never mark terminal inventory to a fallback constant. Order of preference:
(a) resolve post-hoc against the Binance candle close (the session knows `strike` + `expiry_iso`;
one kline fetch) → realized PnL `cash + inv·{0,1} + rebates`; (b) if marking, use the last *good*
snapshot mid and record `markSource` in the summary; (c) reject mids from books wider than a few
cents at |τ|<60s. Add a `pnl_resolved` column so the report can prefer it.

### 3. Brier A/B label is circular and 20s-stale; pooled-tick scoring is hourly-session-weighted

**Where:** `scripts/maker-paper-report.ts:57-79` (label + scoring), daemon stop at
`scripts/maker-paper-daemon.ts:38,115` (`--stop-before-sec 20`).

Three distinct problems:

- **Label leakage (circularity).** The outcome label is `last.spot > strike` from the final
  snapshot. But the *models being scored* compute late-tick `p_fair` from the same spot vs the same
  strike, and both collapse toward a step function as τ→0 (`binary-fair-value.ts:83-89`). So late
  ticks are scored nearly perfectly *by construction* — the label is derived from the model's own
  input. This dilutes the pooled Brier with thousands of free near-zero terms and means the A/B
  difference lives only in early/mid-session ticks, which is not what the headline number implies.
- **20s gap + knife-edge mis-set.** Daemon kills the child 20s before expiry; official resolution is
  the candle close. BTC moves >5bps in 20s routinely; the 5bps knife-edge exclusion
  (`maker-paper-report.ts:42,64-67`) is ~$52 at BTC≈105k and does not cover this. Sessions whose
  spot crossed the strike in the final 20s are labeled wrong — those are exactly the sessions where
  a max-inventory position flips between −$125 and +$125, and where model calibration near 0.5
  matters most. Additionally, if the Binance WS died mid-session (finding 10), `last.spot` is frozen
  and the label can be hours-stale; nothing detects this.
- **Weighting.** Every snapshot tick is scored equally (`maker-paper-report.ts:71-74`). An hourly
  session contributes ~1,800 ticks, a 5-min session ~135 — pooled Brier is a ~12:1 hourly-weighted
  number while the PnL damage is concentrated in the 5-min series. Ticks are also autocorrelated
  (acknowledged in the output, but the `≥500 ticks` winner-call threshold at
  `maker-paper-report.ts:95` can be satisfied by a *single* hourly session). Does scoring every tick
  favor the less responsive model? Not mechanically — but it favors whichever model is closer to the
  step at the end (free points) and punishes any model that adds variance early; combined with
  finding 5 (the momentum estimator passes ~1/3 of pure noise through), the current A/B says less
  "momentum has no value" and more "this momentum estimator adds noise" — don't over-read it.

**Fix sketch:** (a) resolve the label from the Binance 1m kline close at expiry (post-hoc fetch in
the report; cache in `bm_sessions.outcome`); (b) score at fixed times-to-expiry (e.g. τ = 4, 3, 2,
1 min — one observation per session per τ-bucket) instead of every tick; (c) report per-session
mean-Brier paired differences with a sign test, split by series duration (5m/15m/60m); (d) keep the
knife-edge exclusion but apply it to the *kline close*, not the last snap.

### 4. Fill simulation: quote is recomputed with information that postdates the print it fills against

**Where:** `scripts/binary-maker-paper.ts:308-337`. Each tick the loop (1) computes fair from the
*current* spot, (2) publishes a fresh `liveQuote`, then (3) fills that fresh quote against an LTP
print that occurred at some unknown time in the previous ~2s.

**Why it matters — this is lookahead in the maker's favor.** A real resting order is hit *before*
you can reprice on the CEX move; here the sim reprices first, then checks the old print. When spot
drops, the bid drops below the print → the most adverse fills are *skipped*. So the sim
**understates adverse selection** — meaning the live −$2,066 is, if anything, generous, and the
naked-inventory loss is worse than recorded. Related details in the same block:

- `fillFromTrade(mkt.ltp, Infinity)` (`:333`) — assumed-infinite print size always fills the whole
  25-share clip. Optimistic on size per event.
- Fills only fire when `mkt.ltp !== lastLtp` (`:329`) at a 2s poll — repeated prints at the same
  price and all intra-tick flow are invisible. **This is the one genuinely PESSIMISTIC leg:** it
  undercounts benign back-and-forth churn, which is where a real maker earns spread+rebate volume.
  ($118 of rebates on 1,650 fills is partly this undercount.)
- `LTP_BAND = 0.03` (`:325-332`) rejects prints >3¢ outside the touch as garbage. Stale-print
  hygiene is right, but genuine sweep prints through a thin book — the *most* adverse fills a real
  maker eats — are also rejected. Optimistic.
- First tick: `lastLtp` is NaN so `mkt.ltp !== lastLtp` is true — the session can "fill" against a
  print that happened before the session existed (`:329`). One-off lookahead per session; with 183
  sessions it's a real term.
- Quote granularity: quotes are placed at 0.0001 resolution (`binary-maker.ts:124,166-168`,
  `TICK=0.001` + `round4`) but the venue's tick for these markets is $0.01 (the repo's own execution
  lib assumes `[0.01, 0.99]` bounds — `src/lib/polymarket/execute.ts:164-169`). Paper quotes rest at
  prices a live order can't, and "improving the touch by 0.001" is free in paper, impossible live.

**Net direction:** optimistic where it hurts (adverse selection understated, sweeps excluded,
front-of-queue, infinite size), pessimistic only on benign churn volume. That asymmetry exactly
reproduces the observed profile: tiny rebate income, large inventory losses — and means the TRUE
naked-maker PnL is worse than −$2,066, while the true rebate line is somewhat better.

**Fix sketch:** fill against the quote from the *previous* tick (keep `prevQuote`; fill it with the
new LTP before replanning); snap quotes to the per-market `tick_size` from the CLOB; initialize
`lastLtp` from the first book fetch before arming fills; tag band-rejected prints in the DB so their
frequency/size is measurable instead of silently dropped; long-term, replace LTP polling with the
market WS trade channel through the proxy so prints carry size.

### 5. `estimateDriftPerBar` shrinkage passes ~1/3 of pure noise through — the documented "t≈0 on flat tape" claim is false in expectation

**Where:** `src/lib/strategies/binary-fair-value.ts:151-179` (estimator; the claim is at `:146-148`),
consumed via `fairValueFromMinuteCloses` (`:297-309`) with daemon-scaled `halfLifeBars=5`
(`scripts/binary-maker-paper.ts:81`).

**What's wrong.** Under the null (no drift), `t = μ̂/(sd/√nEff)` is ~N(0,1) — its *expectation* is 0
but `E[t²] = 1`, so the shrink factor `t²/(1+t²)` has expectation ≈ 0.35, not ≈ 0. The estimator
therefore passes roughly a third of pure noise drift into the fair value on every tick. Magnitude at
the 5-min horizon: halfLife 5 ⇒ nEff ≈ 14, SE(μ̂) ≈ 0.26σ/bar; E[|μ̂|·shrink] ≈ 0.12σ/bar; over a
5-bar horizon driftTotal ≈ 0.6σ vs σ_total = σ√5 ≈ 2.24σ ⇒ the Normal argument `d` is shifted by
~0.25 on *noise* ⇒ ATM fair value tilted by up to ~10¢ with zero signal (the `capSigmaMult=1` cap at
`:301-306` only binds beyond a full σ). This is sufficient, on its own, to explain the enhanced
model losing the A/B (0.1105 vs 0.1068): it's not that 5-min momentum can't exist, it's that this
estimator manufactures tilt from noise at exactly this horizon.

**Fix sketch:** make the shrinkage honest under the null — e.g. `shrink = max(0, (t² − 1)/t²)`
(positive-part James-Stein, zero mean pass-through under the null) or require `|t| > 2` before any
tilt. Re-run the A/B after the label fix (finding 3) before concluding momentum is dead; per
TRADING_POLICY, pair this skeptic fix with the advocate check (test a horizon-matched momentum
signal, e.g. 1-min OFI/return over the last 60–90s, which is what the market was actually pricing).

### 6. `estimateHorizonSigma` measures persistence at the wrong aggregation scale for 5-min markets; σ window is 10 returns

**Where:** `src/lib/strategies/binary-fair-value.ts:204-236` (VR with `aggBars` default 15, not
scaled by the daemon), `:275-279` (σ from `volBars+1` closes), `scripts/binary-maker-paper.ts:80`
(`VOL_BARS = max(10, min(60, durationMin))` ⇒ 10 for 5-min markets).

**What's wrong / degenerate cases:**

- The variance ratio is computed at k=15-minute aggregation (`fairValueFromMinuteCloses` passes
  `horizonVol: true` ⇒ default `aggBars: 15`) but applied as `σ_min·n^H` for n ≤ 5 bars. H measured
  at 15-min scale says nothing reliable about 1→5-min scaling; minute-level microstructure
  mean-reversion (H<0.5) and 15-min trend persistence (H>0.5) routinely coexist. The daemon scales
  `VOL_BARS` and `MOM_HALF_LIFE` to the market duration but **not** `aggBars` — an inconsistency.
- VR sampling error: with the ~120–240-close buffer, the k=15 overlapping VR has huge variance;
  the [0.35, 0.7] clamp (`:209-210`) saves it from absurdity but the estimate inside the clamp is
  still mostly noise, and `n^H` vs `n^0.5` at n=5 changes σ_total by ±20%+ tick to tick.
- σ_per_minute from 10 returns (`VOL_BARS=10`): relative SE ≈ 1/√(2·10) ≈ 22%, which propagates 1:1
  into `d`. Combined with finding 5, the enhanced model's inputs at the 5-min horizon are nearly all
  estimation noise.
- True degenerate path: if the WS dies and `rollMinute` keeps pushing a frozen spot
  (`binary-maker-paper.ts:163-169`), returns go to exactly 0 ⇒ `sigmaPerMinute = 0` ⇒
  `priceAboveStrike` hits the `denom === 0` step branch ⇒ pFair ∈ {0, 1} ⇒ `planQuotes` rejects
  pFair out of (0,1) and quoting silently stops. Survivable but invisible — no alert distinguishes
  "withdrawn on signal" from "withdrawn because the feed died".

**Fix sketch:** scale `aggBars` with horizon (k ≈ duration, i.e. k=5 for 5-min markets, needing
≥20 returns — available); floor σ with a longer-window estimate blended toward the short window;
treat `sigmaPerMinute === 0` as a feed-health error, not a price.

### 7. `leadlag-campaign` logs the configured capture length, not the actual one

**Where:** `scripts/leadlag-campaign.ts:207` computes the clamped `capSec` (5-min markets get
120–270s, not 300), but the JSONL row at `:217-225` records `captureSeconds: SECONDS`.

**Why it matters.** G1's whole deliverable is *counts per unit observation time*. Every row from a
short-lived market overstates its observation window (300 vs e.g. 150), so per-hour stale-quote
rates computed downstream are biased low on exactly the 5-min series the audit cares about.
**Fix:** `captureSeconds: capSec` (one token), keep `requestedSeconds: SECONDS` if useful.

### 8. `binance-poly-leadlag` Polymarket side uses unproxied channels the sibling script documents as geo-blocked

**Where:** `scripts/binance-poly-leadlag.ts:69` (CLOB market WS created with **no** proxy agent) and
`:108-124` (REST `/book` fallback via bare `fetch`, which ignores proxy env). Contrast
`scripts/binary-maker-paper.ts:171-174`: "Node's native fetch ignores HTTPS_PROXY, and Polymarket is
geo-blocked from the local IP → must route via the proxy", and `:191-193`: "the CLOB trade WS is
geo-blocked from this IP and delivers nothing".

**Why it matters (verify before fixing).** If the paper script's geo-block findings hold for this
host too, the lead-lag tool's Polymarket side is fed by two dead channels — captures either exit on
"not enough ticks" or produce mid series sampled far sparser than believed, corrupting the
cross-correlation lag and the event-study response times that G1 aggregates. The two scripts cannot
both be right about the same endpoint. **Fix sketch:** check the campaign JSONL for suspiciously low
`polyMidUpdates`; route the REST poller through the proxy-aware `poly.orderbook` client
(`src/lib/polymarket/client.ts:141`) and pass the agent to the WS constructor like the Binance one.

---

## P1 — Strategy-mechanics gaps (why even bug-free rails would still lose)

### 9. There is NO inventory-reduction mechanism other than opposite-side maker fills — and the A-S clock removes urgency exactly when pin risk peaks

**Where:** the whole loop (`scripts/binary-maker-paper.ts:213-359`); skew τ-dependence at
`src/lib/strategies/as-market-maker.ts:63-65`; `mergeableSets` exists at
`src/lib/strategies/binary-maker.ts:175-186` but is **dead code** — exported, unit-tested
(`tests/unit/binary-maker.test.ts:153-169`), referenced by nothing in the runtime path.

**Verified mechanisms available to shed inventory:** (1) a counterparty trading into the reducing
quote — which finding 1 shows is withdrawn at high q; (2) nothing else. No taker unwind, no
complement (NO-token) leg, no merge, no end-of-session flatten, no resolution handling (terminal
inventory is just marked, `:363-376`). Worse, the A-S reservation skew scales with `τ = T − t`
(`as-market-maker.ts:64`), so it *decays to zero at expiry* — classic A-S assumes you can liquidate
continuously up to T, so urgency falls as T nears; a binary is the opposite: at T the position
resolves to 0/1 and variance is maximal at the cap. The model's risk control is pointed backwards
for this instrument.

**Why it matters.** This is the single biggest gap between this bot and the verified winners. The
wallet forensics (SWEEP round 2) say the profitable updown makers are **pair/merge makers**: buy YES
at a and NO at b with a+b < 1, merge complete sets for $1, inventory ≈ 0 at all times, edge =
1−(a+b) + rebates, no resolution risk. The current bot quotes one token naked and *hopes* for
two-sided flow. With 5-min trends, flow is one-sided by construction — hence cap-and-ride.

**Fix sketch (ordered):** (a) per finding 1, never gate the reducing side on minEdge; (b) add a
τ-floor flatten: below ~90s to expiry, switch to reduce-only quoting at/inside fair, and optionally
a paper-taker flatten (cross the spread, pay the taker fee — model it honestly) if |q| > a threshold;
(c) the real prize: a second loop quoting BOTH tokens' books with `mergeableSets` live — YES-bid +
NO-bid such that bidYES + bidNO ≤ 1 − fees − margin, merge on matched fills. That's a structurally
different (and per forensics, the actually-profitable) strategy; the complement-guard plumbing in
`planQuotes` already anticipates it (`binary-maker.ts:18-20`).

### 10. A-S parameters are hardcoded magic numbers, violating the library's own contract; σ=0.25 understates 5-min logit vol by an order of magnitude

**Where:** `scripts/binary-maker-paper.ts:201-202`:
`asParams = { gamma: 0.08, sigma: 0.25, kappa: 1.2, T: max(tauHoursAtStart, 0.01) }`. The library
header (`as-market-maker.ts:10-12`) explicitly says κ/σ_b are "intentionally NOT hardcoded; fit
per-venue, per-regime from your own captures".

**Verified consequences:**

- `sigma` here is *belief* vol in logit space per √hour. On a 5-min BTC updown, the mid routinely
  travels 0.5→0.8+ (logit 0→1.4) within τ=0.083h ⇒ realized logit vol ≈ 1.4/√0.083 ≈ **4.9 per
  √hour**, ~20× the hardcoded 0.25. Since skew ∝ γσ²τ, the inventory penalty is undersized by
  ~400× relative to a calibrated σ (γ would be re-fit too, but the point stands: the *only* inventory
  control in the system is arbitrarily weak). Undersized skew ⇒ quotes barely move as inventory
  builds ⇒ cap-and-ride. (Yet the same skew is simultaneously strong enough to trip the minEdge gate
  on hourly markets — findings 1+10 together mean the skew is both too weak to manage inventory and
  strong enough to disable the exhaust valve. That coincidence only exists because nothing is
  calibrated.)
- `T = tauHoursAtStart` fixed at session start is approximately right for the daemon flow (child
  launches at candle open, T ≈ market life, t ≈ elapsed ⇒ T−t ≈ τ). Not wrong per se — but it means
  skew → 0 at expiry (finding 9). `kappa` is effectively unused: `planQuotes` takes only
  `reservationP` from `logitSpaceQuotes` and substitutes its own `baseHalfSpread`
  (`binary-maker.ts:102-113`) — the A-S optimal half-spread (the part κ parameterizes) is computed
  and discarded. Either use it or stop pretending it's wired.

**Fix sketch:** estimate σ_logit per session family from the snaps already in the DB
(`Δlogit(mid)` per √time — `bm_snaps` has everything needed); set γ so the skew reaches ~1 tick per
`quoteSizeShares` of inventory at mid-session τ; document the choice. Keep T as market life, but
replace τ-decaying skew with a binary-appropriate inventory penalty that *grows* as τ→0 (e.g. skew ∝
q·σ²·f(τ) with f increasing as resolution variance concentrates — or simply the reduce-only τ-floor
from finding 9b).

### 11. No near-expiry quote stop: as τ→0 the fair value becomes a step and quoting becomes a coin-flip race you lose

**Where:** loop runs until `now >= expiryMs` (`binary-maker-paper.ts:277`), daemon trims only the
last 20s (`maker-paper-daemon.ts:38`). `priceAboveStrike` → step as `σ√τ → 0`
(`binary-fair-value.ts:82-93`).

**Why it matters.** In the last ~60s of a 5-min market with spot within a few bps of strike, `d`
swings ±2 per tick, pFair whipsaws 0.1↔0.9, and the bot posts 25-share quotes at extreme prices on a
2s cadence. Whoever has the faster feed picks off the stale side; in paper, the LTP-poll fills land
both ways and add noise; live they'd be pure adverse selection. The per-session ±$100 swings
concentrate here and at the cap. The forensics' profitable lifecycle quoting (0.02→0.99) is about
quoting *prices* across the whole range over the market's life — not about quoting *until the final
second* at the knife edge.

**Fix sketch:** below a τ floor (e.g. 60–90s for 5-min, 3–5min for hourly), stop opening new
exposure: reduce-only (finding 9b) or full stop with a recorded `withdrawn: tau-floor` reason so the
report can attribute PnL by phase. Also log per-fill τ so the "where do we bleed" question is
answerable from `bm_fills` directly (it currently isn't — fills don't record time-to-expiry).

### 12. Report aggregates from `summary` JSON, so crashed sessions' PnL and fills silently vanish

**Where:** `scripts/maker-paper-report.ts:80-83` (`sum?.pnlMarkUsd`, `sum?.fills`,
`sum?.rebatesUsd`); the summary row is only written on clean exit
(`binary-maker-paper.ts:379-380`). Killed children (daemon's SIGKILL-after-timeout path, passport
I/O crash — finding 15, machine sleep) leave `summary = NULL` while their fills sit in `bm_fills`.

**Why it matters.** Crash-time inventory is the worst-case inventory (proxy failures correlate with
volatility), so the omitted sessions are plausibly the most negative ones — the −$2,066 headline can
be *understated* by exactly the sessions that died ugly. Also a selection bias on the A/B sample:
the `expired (stale tail — excluded)` branch (`:76-78`) drops sessions whose last snap is >10min
pre-expiry — i.e. crashed sessions — from the Brier comparison, skewing the scored sample toward
calm markets.

**Fix sketch:** compute aggregates from `bm_fills`/`bm_snaps` (ground truth) and report
`summary`-based numbers alongside; print a `sessions with fills but no summary: N (PnL
unrecoverable: mark from last snap + kline resolution)` line; with finding 2's `pnl_resolved`,
crashed sessions become fully recoverable post-hoc since fills + resolution are both known.

---

## P2 — Robustness / efficiency

### 13. Binance WS: no reconnect, no staleness gate — a dead feed quotes forever on a frozen spot

**Where:** `scripts/binary-maker-paper.ts:150-160` — `bn.on("error")` only logs; no `close` handler,
no reconnect, no `lastSpotAtMs`. The loop only checks `Number.isFinite(spot)` (`:278`), which a
frozen value passes indefinitely.

**Why it matters.** With the proxy intermittently failing ("Not authenticated"), a mid-session WS
drop freezes spot; fair value diverges from reality; the LTP poll keeps "filling" the bot at prices
computed off a dead feed. The strike sanity check (`:293-306`) only runs on the first 8 ticks, so it
cannot catch this. These sessions pollute fills, PnL, *and* the Brier labels (finding 3).
**Fix sketch:** track `lastSpotMs`; if `now − lastSpotMs > 10s`, withdraw quotes and mark the tick
`feed-stale` (snap column), reconnect the WS with backoff; abort the session (exit 3, daemon
re-enters) after e.g. 60s stale.

### 14. Kline fetches: no `r.ok` check, no retry, no fallback mirror — one proxy hiccup wastes an entire market

**Where:** `scripts/binary-maker-paper.ts:137-148` (`seedKlines` — single attempt; on failure
`minuteCloses` stays empty and a 5-min session can never reach `volBars+1 = 11` closes ⇒ zero quotes
all session, silently); `scripts/maker-paper-daemon.ts:97-112` (`candleOpen` — single attempt, then
a 10s sleep and full re-discovery; on a 5-min market that loses 1/3 of its life, and repeated
failures skip the market entirely — the observed "skipped markets"). `proxiedFetch` returns
`validateStatus: () => true` responses (`src/lib/data/proxy-fetch.ts:86`), so a 407/451/error body
parses as JSON garbage rather than throwing early.

**Fix sketch:** check `r.ok` explicitly; retry 2–3× with 1–2s backoff inside both helpers; fall back
to the unproxied mirror `data-api.binance.vision` for klines (public data, no auth, explicitly noted
in `proxy-fetch.ts:5-6` as the no-funding mirror — klines are available there); in the daemon,
retry `candleOpen` every 2s for up to ~30s before abandoning a market. Also have the WS-spot path
seed `spot` even when klines fail, so the session can at least start accruing live closes.

### 15. SQLite on the removable passport: unmount mid-write = uncaught crash + silently forked dataset

**Where:** DB path chosen once at process start via `existsSync("/Volumes/My Passport")`
(`binary-maker-paper.ts:98-100`, `maker-paper-report.ts:28-32`); `insSnap.run`/`insFill.run` are
called bare inside the loop (`:232,244,342`); no `PRAGMA journal_mode` is set (verified — no pragma
anywhere in either script).

**What actually happens on unmount:** better-sqlite3 throws `SQLITE_IOERR` synchronously; nothing
catches it; the child dies mid-session (→ finding 12's missing-summary hole, position vanishes from
the headline). The daemon survives and starts the next session, whose `existsSync` now fails →
falls back to `data/binary-maker-paper.db` → the forward track is split across two files and the
report (whichever machine/volume state it runs under) reads only one, with no warning. Rollback
journal on a removable volume also risks corruption on hard unplug.
**Fix sketch:** `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;` at open; wrap writes in a
try/catch that flushes a per-session JSONL fallback and exits with a distinct code; pin the path via
`BINARY_MAKER_DB_PATH` in the LaunchAgent env instead of sniffing the volume per-process; make the
report check BOTH candidate paths and warn loudly if the non-selected one also contains sessions.

### 16. Duplicate Gamma discovery implementations are already drifting — extract one

**Where:** `scripts/maker-paper-daemon.ts:52-94` vs `scripts/leadlag-campaign.ts:73-159`. Shared
verbatim: the `poly.events` window query, the `clobTokenIds` JSON.parse dance, `closed/active`
checks, `endDate` parsing, `rangeDurationMinutes` usage. Already-divergent behavior: the campaign
guards against stale `outcomePrices` with a live-book-mid preference (`:109-118`) and excludes
one-touch markets (`:96-98`); the daemon has neither (its regex incidentally excludes one-touch, but
it would happily use stale gamma fields if it ever needed a mid). Next person to fix a Gamma quirk
will fix it in one place.

**Fix sketch:** worth extracting now — `src/lib/polymarket/updown-discovery.ts` with
`discoverUpDownMarkets(opts): {question, tokenId, startMs, endMs, durMin, mid?, liq?}[]`, returning
the parsed/validated superset; daemon filters to soonest-with-τ, campaign filters to NTM+liquid.
Unit-test the token-id and duration parsing once (the updown-title tests already cover half).

### 17. Smaller items

- **Daemon blacklist is permanent and token-scoped** (`maker-paper-daemon.ts:49,163-166`): a
  strike-suspect abort caused by one transient bad kline permanently burns that market. Fine for
  5-min markets (they expire anyway); for hourly it forfeits up to an hour of track. Allow one
  re-derive of the strike before blacklisting.
- **`fetchBook` logs only the first error forever** (`binary-maker-paper.ts:174,186`):
  `bookErrLogged` never resets, so a session that degrades after tick 100 looks identical to a
  healthy one in the log. Log state *transitions* (ok→err, err→ok) instead.
- **Winner-call threshold counts ticks, not sessions** (`maker-paper-report.ts:95`): `≥500 ticks` is
  one hourly session. Gate the call on ≥ N sessions per duration bucket (e.g. 30) after the
  finding-3 rework.
- **`leadlag-campaign` event-study parse couples to console text** (`:172-187`): a wording tweak in
  `binance-poly-leadlag` silently nulls every metric (the JSONL would record `bestLagSec: null` with
  exit 0). Have the child print a single `JSON_RESULT {...}` line and parse that.
- **`updown-title.ts` is sound** — reviewed for the midnight wrap, inherited AM/PM, and
  minutes-precision cases; tests cover them (`tests/unit/updown-title.test.ts`). One residual: a
  cross-noon range like "11:55AM-12:00PM" works, but a >12h "range" would mis-wrap — unreachable for
  this family; no action.
- **Fill rows don't record τ or the market mid at fill time** (`bm_fills` schema,
  `binary-maker-paper.ts:103-107`): the two most useful columns for diagnosing adverse selection
  (was the fill near expiry? how far through the mid did the print go?) are absent. Add
  `tau_sec` and `mkt_mid` columns.

---

## What the live numbers mean once the above is applied

- The −$2,066 is currently **not a clean verdict** on the maker: finding 2 (0.5-fallback marks) and
  12 (vanished crashed sessions) distort the level in both directions, while finding 4's
  net-optimistic fill model means the true naked-inventory result is *worse*. Direction of the
  verdict is unambiguous though: naked one-token quoting with no exhaust valve loses to 5-min
  one-sided flow. That is consistent with the wallet forensics, which found zero profitable makers
  running this shape.
- The A/B "baseline beats enhanced" is **directionally believable but contaminated** (findings 3, 5):
  the enhanced model's loss is largely self-inflicted estimator noise, and the label is part-circular.
  Fix the shrinkage and the label, rerun, and only then close the book on short-horizon momentum.
- The rails-level priority order for the next iteration: **9c (merge/pair loop — the strategy the
  evidence actually supports) > 1 (reducing-side gate) > 2+3 (honest marks and labels) > 13–15
  (feed/DB robustness so the track stops eating itself)**. The forward track machinery itself —
  daemon roll, session DB, A/B snapshotting, strike sanity abort — is sound and worth keeping.
