# Microstructure Signals — OBI, Microprice, OFI/TFI, VPIN, Sweep & Iceberg Detection

> **Family:** 4 — Microstructure signal trading
> **Variants covered:** Order-Book Imbalance (OBI) · Microprice · Order-Flow Imbalance (OFI) · Trade-Flow Imbalance (TFI) · VPIN (toxicity) · Sweep detection · Iceberg/hidden-order detection · Queue-burst
> **Repo modules:** `src/lib/hft/dydx/signals.ts` (microprice + OBI + spread + obiWidenMultiplier), `src/lib/strategies/orderbook-imbalance.ts` (Polymarket OBI detector)
> **Cross-asset coverage:** US equities (Alpaca L2 add-on) · crypto spot (Coinbase WS L2) · crypto perps (dYdX, Hyperliquid, Paradex WS) · prediction markets (Polymarket WS book)

---

## 1. TL;DR

The order book holds a tick-ahead opinion about price. Microstructure
signals are the formal extractors of that opinion.

Seven canonical signals form the menu:

1. **Microprice** — size-weighted "fair" between bid and ask. Better short-horizon predictor than mid or weighted-mid.
2. **OBI** (order-book imbalance) — snapshot ratio of bid/ask depth at top-N levels. Cheap, noisy.
3. **OFI** (order-flow imbalance) — *event-driven* version of OBI; counts book *changes* at top-of-book, not snapshots. Linear in price impact.
4. **TFI** (trade-flow imbalance) — signed trade volume aggregated over an interval. Beats OFI for horizons > 10s.
5. **VPIN** (volume-synchronized prob. of informed trading) — toxicity flag from buy-sell volume imbalance per volume bucket. Predicted the 2010 Flash Crash 1h ahead.
6. **Sweep detection** — large market order eating multiple levels; the most aggressive form of "informed flow showing itself."
7. **Iceberg detection** — large hidden orders revealed by post-trade book-refresh patterns.

All seven are signals *of* short-horizon price movement, not strategies in
themselves. They feed two consumers:

- **Market makers** (Family 1) widen quotes, shift reservation price, or pause when signals turn toxic.
- **Directional taker bots** enter brief positions when the signal aligns with edge sources from other strategies.

This repo already implements microprice and OBI in `src/lib/hft/dydx/signals.ts`.
The other five are not yet implemented — this doc seeds them.

---

## 2. Mechanism

### 2.1 Microprice (Stoikov, 2017)

The mid-price `(bid + ask) / 2` is naïve — it weights both sides equally
regardless of depth. If `bid_size = 100` and `ask_size = 5`, the next
trade is almost certainly a buy that lifts the ask; "fair" sits closer to
ask, not mid.

The **microprice** corrects this:

```
microprice = (bid_size × ask_price + ask_size × bid_price) / (bid_size + ask_size)
```

Note the cross-weighting: bid size weights the *ask* price (and vice
versa). The intuition: heavier bids → ask is the more credible price
because that's where the next trade prints.

Stoikov[^stoikov2017] proved that the microprice is a *martingale* under
mild assumptions (no drift, locally stationary book), which means it's
the conditional expected price given the order book — exactly what "fair
value" should mean.

**Implementation** (already in repo): `src/lib/hft/dydx/signals.ts:17` —
`computeMicroprice(bids, asks)`.

**Modern extensions:** Stoikov + others have proposed higher-order
microprice estimators that use 2nd-level book depth, not just top-of-book.
A 2024 arXiv paper extends it with Tsetlin-machine-based corrections from
deeper book features.[^tsetlin2024] For T3 retail, top-of-book microprice
is usually enough.

### 2.2 OBI — order-book imbalance (snapshot)

The classical signal:

```
OBI = (Σ bid_size_top_N − Σ ask_size_top_N) / (Σ bid_size_top_N + Σ ask_size_top_N)
∈ [−1, +1]
```

Positive → bid side heavier → upward pressure. Negative → ask heavier →
downward pressure.

**Choice of N.** Most production implementations use N = 1 (top-of-book
only) for the fastest signal, or N = 5-10 for a slower but more robust
read. N = 3 is a good default for thin books (Polymarket); N = 5 for
liquid markets (BTC/ETH on tier-1 venues).

**Implementation** (already in repo):
- `src/lib/hft/dydx/signals.ts:33` — `computeOBI(bids, asks, levels = 5)` for perps.
- `src/lib/strategies/orderbook-imbalance.ts` — variant for Polymarket binaries with persistence, signal-strength normalization, and "trigger ratio" thresholding (3× imbalance = signal fires).

**Spoofing risk.** A 2025 academic survey notes spoofing is the dominant
false-positive source for snapshot OBI.[^johal2025] Mitigations:

1. **Persistence filter.** Require the imbalance to persist across N consecutive snapshots (default `n_persist = 3` at 1s polls).
2. **Discount oversize orders.** If a single level is >5× the median level size, halve its weight in the OBI computation (these are the spoof candidates).
3. **Confirm via trades.** Combine OBI with TFI (§2.4); if OBI says "buy pressure" but recent TFI is sell-skewed, suspect a spoof. Don't act.

### 2.3 OFI — order-flow imbalance (event-driven)

Cont, Kukanov & Stoikov (2014)[^cks2014] showed that *changes* in book
depth at top-of-book — not snapshots — are linearly related to price
change. The metric is:

```
OFI_t = Σ over book events in (t−Δt, t]:
        +Δsize  if bid_price_event ≥ previous_best_bid and event is add/refresh
        −Δsize  if bid_price_event < previous_best_bid (cancel/decrement)
        −Δsize  if ask_price_event ≤ previous_best_ask (add/refresh)
        +Δsize  if ask_price_event > previous_best_ask (cancel/decrement)
```

In English: it sums *additions* at-or-better than current best bid (bullish)
minus *additions* at-or-better than current best ask (bearish), with
analogous treatment of cancellations.

**Why OFI > OBI.** OBI tells you *what the book looks like*; OFI tells you
*how the book is changing*. The latter is the signal. Cont et al. found
R² > 65% relating OFI to short-horizon price changes — exceptional for any
microstructure signal.

**Requires event-level data.** OFI needs every L2 *event* (add, cancel,
modify, trade), not just snapshots. Coinbase WS, dYdX WS, Hyperliquid WS,
and Polymarket WS all stream events; Alpaca free tier does not.

### 2.4 TFI — trade-flow imbalance

Aggregate signed trade volume over the interval `(t−Δt, t]`:

```
TFI_t = Σ trade_size × sign(trade)
        where sign = +1 if taker bought (lifted offer), −1 if taker sold (hit bid)
```

When trade tape doesn't carry an explicit `taker_side` flag (it does on
most modern venues), use the Lee-Ready algorithm[^leeready1991] to infer:
trade at-or-above mid → taker bought; below mid → taker sold; exact mid →
look at next trade or previous trade.

**Findings (Cont et al. extended work):** TFI beats OFI as a predictor at
horizons > 10s. At 1-hour horizon, TFI's R² vs price change reaches
~75%, vs OFI's ~55%.[^medium_orderflow]

**Practical use:** TFI is a slower, smoother signal than OFI. It's the
right input for "stay in or get out" decisions on positions held for
minutes-to-hours. OFI is the right input for tick-level MM decisions.

### 2.5 VPIN — volume-synchronized PIN (toxicity)

Easley, Lopez de Prado, O'Hara (2010-2012)[^elop2010] generalized the
Glosten-Milgrom adverse-selection idea into a *real-time* toxicity
indicator. The construction:

1. **Volume buckets.** Aggregate trades into equal-volume buckets (e.g. each bucket = 1% of average daily volume). Time is *not* uniform — buckets close when volume threshold is hit, not when a clock ticks.
2. **Per-bucket signed-volume imbalance.** Inside each bucket, sum buy volume `V_B` and sell volume `V_S`. Imbalance metric:
   ```
   |V_B − V_S| / V_bucket  ∈ [0, 1]
   ```
3. **VPIN = rolling mean** of the imbalance over the last `N` buckets (typical N = 50).

A high VPIN means recent buckets had lopsided buy/sell flow → informed
traders are likely dominating → liquidity providers face adverse selection.

**Famous result:** VPIN spiked 1 hour *before* the May 6, 2010 Flash
Crash[^vpin_flash], giving market-maker engines lead time to widen quotes
or flatten. Modern HFT MM engines watch VPIN as an automatic kill-switch.

**Practical use:**
- VPIN > 0.4 → widen quotes 2-3×; cancel aggressive orders.
- VPIN > 0.6 → pause MM entirely; flatten inventory.
- VPIN < 0.2 → normal regime; tighten quotes if other signals agree.

### 2.6 Sweep detection

A "sweep" is a single market order that eats multiple price levels — the
most aggressive signal that informed flow is active. Two definitions:

**Cross-level sweep:** a trade prints at price `p_3` (third-best ask)
without intermediate prints at `p_1` (best ask) and `p_2` (second-best
ask). The taker placed an IOC limit at `p_3` to consume all liquidity up
to that level.

**Same-side sweep:** a sequence of trades within `< 100ms` consuming
`> 50%` of displayed top-of-book size on one side.

**Why it matters:** sweeps are not random; they're someone-knows-something
moments. Post-sweep, the mid typically moves another 30-100% of the sweep
distance within seconds (the rest of the iceberg shows itself, other
algos pile in).

**Implementation sketch:**

```ts
function detectSweep(
  events: BookEvent[],
  trades: Trade[],
  windowMs = 200,
): SweepEvent | null {
  // group trades within windowMs; if total taker volume on one side
  // exceeds prior top-of-book size for that side, flag a sweep.
  // Return side, total volume, levels-eaten, price range.
}
```

### 2.7 Iceberg / hidden-order detection

An iceberg order shows a small visible size but has a much larger total
size hidden behind it. Detection methods differ by venue type:

**Native icebergs (exchange-managed).** The exchange refreshes the
visible portion immediately after a fill, using the *same order ID*. The
trade message includes the *total* fill size (including the hidden
portion). Detection: trade size > previously displayed size at that
price → native iceberg confirmed.[^zotikov2019]

**Synthetic icebergs (trader-managed).** A trader uses successive small
limit orders, each placed shortly after the previous one fills. Detection:
within `< 100ms` after a trade at price `p`, a new limit order at the
*same* `p` arrives → likely synthetic iceberg. The "tell" is the timing
pattern: human or naïve algo refreshes are not that fast.

**Why it matters:** an iceberg means the visible book *understates* the
true liquidity at that level. If you were planning a sweep, you'll get
adverse fills. If you were market-making, your quote at the level above
the iceberg is likely to be picked off as the iceberg gets eaten.

**Detection requires MBO (market-by-order) data**, not just MBP (market-
by-price). Coinbase Full Channel WS provides MBO; dYdX Indexer does not
(MBP only); Polymarket WS provides per-order events; Alpaca free tier
provides nothing.

### 2.8 Queue-burst

A burst of new top-of-book orders arriving on one side within a tight
window → indicates an algorithm has decided to layer in passive interest
(could be hedge, could be MM repositioning, could be inventory unwind).

```
queue_burst_t = count(new_orders_arriving_at_top_of_book in (t-Δt, t]) / mean_arrival_rate
```

A `queue_burst > 5` (5× mean rate) is meaningful. Usually preceded by an
OFI move in the *opposite* direction (one side cancels, the other side
ramps up).

---

## 3. Where it works

| Asset class | Venue | Best signals | Notes |
|---|---|---|---|
| US equities | Alpaca paid feed | OBI, TFI | Paid L2 required; OFI possible if you upgrade to a real MBO feed |
| US equities | IEX DEEP via Polygon | OBI, OFI, TFI | IEX has unique anti-HFT design; signals behave differently |
| Crypto spot | Coinbase Adv (Full Channel WS) | All seven | Full MBO available → iceberg detection works |
| Crypto spot | Binance, OKX | OBI, OFI, TFI, VPIN | MBP-only WS limits iceberg detection |
| Crypto perps | dYdX Indexer WS | OBI, microprice, TFI | OFI possible from event stream; iceberg detection partial |
| Crypto perps | Hyperliquid | OBI, OFI, microprice, TFI | Deep books; OFI is strongest |
| Crypto perps | Paradex | OBI, microprice | Less event volume → less signal |
| Polymarket binaries | Polymarket WS | OBI, microprice (clipped) | Thin books; persistence filter critical |

**Latency tiers:**
- **T1-T2 (sub-100ms):** OBI, microprice, OFI usable for *quote-decision* (which price to post).
- **T3 (100ms-10s):** all signals usable for *position-decision* (open/close), MM gating.
- **T4 (>10s):** VPIN, TFI usable as regime classifiers (toxic vs calm). OBI and OFI decay too fast at T4 to be tactical.

**Capital scale:** these signals are mostly *advisors*, not standalone
strategies. The strategy on top determines capital scale. A microstructure-
augmented MM scales to whatever the underlying MM scales to; a microstructure-
augmented taker bot is limited by its alpha source.

---

## 4. Edge magnitude

Microstructure signals are *force multipliers*, not standalone strategies.
The honest measurement is incremental Sharpe lift over the host strategy.

| Signal | Use case | Sharpe lift over host strategy | Source |
|---|---|---|---|
| Microprice in MM (vs mid) | quote-setting on liquid CLOBs | +20-40% Sharpe vs mid-based MM | hftbacktest tutorials [^hftb] |
| OBI persistence-filtered in MM | quote shift + cancel-replace | +10-25% Sharpe | Operator benchmarks; this repo's dYdX MM uses this |
| OFI as MM quote-shifter | tick-by-tick reservation-price drift | +30-50% Sharpe | Cont/Kukanov/Stoikov 2014, replicated [^cks2014] |
| TFI as position-hold timer | "hold or get out" on a short directional position | +0.2-0.5 Sharpe units | Cont et al. extended |
| VPIN as MM kill-switch | pause-during-toxic | drawdown reduction 30-60% | Easley/Lopez de Prado/O'Hara |
| Sweep detection as take signal | brief directional position post-sweep | 5-15 bps per signal; ~5-20 signals/day on liquid pairs | Operator anecdote; no public benchmark |
| Iceberg detection in MM | avoid quoting above-iceberg | reduces adverse selection by 10-20% | Zotikov 2019 [^zotikov2019] |

**Reality check:** the lifts above are *additive in good regimes*. In
bad regimes (high toxicity, mid moving in regime breaks), microstructure
signals can produce *negative* lift because the underlying assumption
(local stationarity) is broken. Backtest across regimes.

---

## 5. What kills it

Ranked by how often these break microstructure-signal strategies.

1. **Spoofing & layering.** Adversarial book actors place large orders meant to look like genuine pressure, then cancel before being hit. OBI is the most exposed signal; OFI and TFI more resistant because they count actual fills. Mitigation: persistence filter; oversize-order discount; cross-confirm OBI vs TFI before acting.
2. **Latency leakage of your own signal.** Your observation-to-decision latency exceeds the signal half-life. By the time you cancel-replace your quote, the OFI move is over and you're adversely selecting yourself. Mitigation: budget signal half-life vs your tick-to-ack latency; if observation latency exceeds 50% of signal half-life, the signal is unusable.
3. **Microprice martingale assumption breaks.** During news prints or large directional flow, microprice is not a martingale; it's a delayed lag of where the mid is going. Mitigation: use VPIN or rapid TFI to detect toxicity regime; fall back to mid-based decisions during high-toxicity windows.
4. **VPIN bucket calibration drift.** Volume buckets sized for normal regimes are wrong during low-volume periods (buckets take too long → VPIN smooths over events) and during high-volume periods (buckets close too fast → VPIN is jumpy). Mitigation: dynamic bucket sizing (`bucket_size = max(min_bucket, 0.1 × trailing_5min_volume)`).
5. **Sweep detection false positives from chunked orders.** A genuine TWAP execution looks like a sweep in 100ms windows. Mitigation: require sweep volume > 2× displayed top-of-book on one side AND simultaneous activity on opposite side absent (genuine TWAP often has both-side activity).
6. **Iceberg detection on venues with order-ID rotation.** Some venues rotate order IDs on refresh, breaking the "same ID = same iceberg" detection. Mitigation: fall back to timing-pattern detection (refresh within 100ms post-trade at same price).
7. **MBP vs MBO data quality.** Many "L2" feeds are aggregated by price (MBP) rather than per-order (MBO). MBP-only loses iceberg detection completely. Mitigation: know your feed type; only deploy iceberg detection on venues providing MBO.

---

## 6. Parameters

A single microstructure-signals module covers all seven primitives. Per-
signal params:

### 6.1 Microprice

| Param | Default | Range | Purpose |
|---|---|---|---|
| `levels_for_size_weight` | 1 (top-of-book only) | [1, 5] | Stoikov original = 1; higher-order microprice uses deeper levels with diminishing weights |
| `min_size_per_side` | 1 base unit | [0, 1000] | If top size < min, return null (book too thin to trust) |

### 6.2 OBI

| Param | Default | Range | Purpose |
|---|---|---|---|
| `levels` | 5 | [1, 20] | Top-N for size aggregation |
| `oversize_discount_threshold` | 5× median | [2, 10] | Suspicious-large-level threshold |
| `oversize_discount_factor` | 0.5 | [0, 1] | Weight multiplier on suspicious levels |
| `persistence_snapshots` | 3 | [1, 20] | Anti-spoof: require N consecutive agreeing reads |
| `signal_trigger_ratio` | 3.0 | [1.5, 10] | bid/ask ratio that triggers a "signal fires" flag |

### 6.3 OFI

| Param | Default | Range | Purpose |
|---|---|---|---|
| `interval_ms` | 100 | [10, 1000] | Aggregation window for event sum |
| `levels_tracked` | 1 (top-of-book) | [1, 5] | Cont/Kukanov original = 1 |
| `event_types` | `[add, cancel, modify, trade]` | subset | Which book events to count |

### 6.4 TFI

| Param | Default | Range | Purpose |
|---|---|---|---|
| `interval_ms` | 10_000 (10s) | [1_000, 600_000] | Trade-aggregation window |
| `lee_ready_fallback` | true | bool | Use Lee-Ready algo when taker_side not in trade msg |
| `volume_normalize` | true | bool | Express TFI as fraction of total volume in window |

### 6.5 VPIN

| Param | Default | Range | Purpose |
|---|---|---|---|
| `bucket_volume` | 0.01 × ADV | dynamic | Volume threshold to close a bucket |
| `n_buckets` | 50 | [10, 500] | Rolling-mean window length |
| `pause_threshold` | 0.6 | [0.4, 0.8] | VPIN level at which MM should pause |
| `widen_threshold` | 0.4 | [0.2, 0.6] | VPIN level at which MM should widen 2-3× |

### 6.6 Sweep detection

| Param | Default | Range | Purpose |
|---|---|---|---|
| `window_ms` | 200 | [50, 1000] | Trade-aggregation window |
| `min_volume_pct_top` | 50 | [25, 200] | Fraction of pre-sweep top-of-book size required |
| `cross_level_required` | false | bool | Require trades at 2+ levels in window |

### 6.7 Iceberg detection

| Param | Default | Range | Purpose |
|---|---|---|---|
| `min_visible_size` | 1 | depends on venue | Skip dust |
| `min_refresh_count` | 3 | [2, 20] | Refreshes required to label as iceberg |
| `refresh_window_ms` | 100 | [10, 1000] | Time after fill to count as iceberg refresh |
| `order_id_tracking` | true | bool | Use order ID where venue rotates it |

### 6.8 Queue-burst

| Param | Default | Range | Purpose |
|---|---|---|---|
| `mean_arrival_rate_window_min` | 5 | [1, 60] | Trailing window to estimate mean arrival rate |
| `burst_multiplier` | 5 | [2, 50] | k×mean to flag a burst |
| `min_orders_for_burst` | 3 | [1, 50] | Minimum orders in window to be considered |

---

## 7. Fill model (when using these signals to *take*)

When a microstructure signal is used to *take* a position (not just to
adjust passive MM quotes), the fill model needs to account for the fact
that the signal is *also visible to other algos*. You're racing.

### 7.1 Realistic taker fill model

```
P(fill at observed_top_of_book) = exp(−latency_ms / signal_half_life_ms)
```

For OBI/microprice signals with ~500ms half-life and your 200ms latency:
`P(fill) = exp(−200/500) = 0.67`. The other 33% of the time, the price
moved while you were sending, and you fill at a worse level.

### 7.2 Slippage on chase fills

When you miss the top-of-book, model the chase:

```
chase_slippage_bps = 0.5 × spread_bps × (1 + signal_strength)
```

Strong signals → larger chase slippage because other algos crowded in.

### 7.3 For MM use: integrated cost of acting on signals

When using a signal to shift your quote, model:

- Cost of the cancel-replace itself (rate-limit risk, queue position loss).
- Cost of being wrong half the time on the signal (the signal isn't a guarantee; it's a probability).
- Expected gain from being right (the captured spread on the side the signal favors).

A signal is worth using in MM iff:

```
P(correct) × edge_when_correct − P(incorrect) × cost_when_incorrect − cost_of_acting > 0
```

For OBI persistence-filtered, on dYdX BTC-PERP: `P(correct) ≈ 0.58`,
`edge_when_correct ≈ 0.6 × half_spread`, `cost_when_incorrect ≈ 0.4 × spread`,
`cost_of_acting ≈ 0.1 × half_spread` → net positive.

---

## 8. Backtest design

### 8.1 Data

| Signal | What you need | Source |
|---|---|---|
| Microprice, OBI | L2 snapshots at 100ms or 1s | Tardis.dev paid; Coinbase WS captured live; dYdX Indexer WS |
| OFI | L2 *event* stream (every add/cancel/modify) | Coinbase Full Channel; dYdX Indexer (partial); Hyperliquid WS |
| TFI | Trade tape with taker_side | All major venues |
| VPIN | Trade tape + total volume estimate | Same |
| Sweep detection | Trade tape + L2 snapshots | Same |
| Iceberg detection | MBO data (per-order events) | Coinbase Full Channel; not available on most venues |
| Queue-burst | L2 events (add events at top) | Same as OFI |

### 8.2 Metrics

For each signal, evaluate as a *predictor* of N-second-ahead price change:

- **Information coefficient (IC):** Spearman rank correlation between signal and N-second price change. Good signals have IC > 0.05 at the signal's half-life horizon; > 0.10 is excellent.
- **Signal half-life:** time until IC drops to half its peak. Set your decision-loop period to ≤ signal half-life.
- **Precision @ k:** of the top-k signal readings (highest signal strength), what % are followed by the predicted price move within N seconds? Useful for sweep/iceberg detection where you act on a few high-confidence events.
- **PnL contribution:** when used in a host strategy, attribute PnL: with-signal vs without-signal. Run the same strategy twice, compute the delta.

### 8.3 Walk-forward

Signals have regime-dependence. Walk-forward setup:

- Universe: rolling 30-day window for parameter calibration (VPIN bucket size, OBI persistence count, etc.)
- Test: next 7 days using the parameters from training window.
- Roll weekly.

### 8.4 Look-ahead traps

- **Don't compute the signal using future events.** The signal at time `t` must use only events with timestamp `≤ t`.
- **Don't use the trade that triggered the signal in computing the signal.** Common error in sweep detection: include the sweep trade itself in the imbalance calculation, which inflates the signal.
- **Account for venue clock skew.** L2 snapshots and trade-tape events can have different timestamps. Normalize to a single clock (typically venue's exchange-time field).
- **VPIN dynamic-bucket trap:** if you re-size buckets using future volume (e.g. "use ADV from the full year"), you've leaked future info. Use *trailing* ADV only.

---

## 9. Code skeleton

Below: the seven signals as pure functions. Microprice and OBI are
already in `src/lib/hft/dydx/signals.ts`; the rest are new.

### 9.1 New module: `src/lib/hft/signals/order-flow.ts`

```ts
// OFI: order-flow imbalance from book events at top-of-book.
// Pure function. Caller supplies the event stream filtered to a window.

export type BookEvent = {
  ts: number;
  side: "bid" | "ask";
  price: number;
  size: number;            // size after the event
  prevSize: number;        // size before the event (0 for add, 0 after cancel)
  prevBest: number | null; // best-bid (for side=bid) or best-ask (for side=ask) before event
  type: "add" | "cancel" | "modify" | "trade";
};

export function computeOFI(events: BookEvent[]): number {
  let ofi = 0;
  for (const e of events) {
    const isBid = e.side === "bid";
    const delta = e.size - e.prevSize;
    // Cont/Kukanov sign convention:
    //   bid add/refresh at-or-better than prev best  → +Δ
    //   ask add/refresh at-or-better than prev best  → −Δ
    //   bid cancel below prev best                   → −Δ
    //   ask cancel above prev best                   → +Δ
    if (e.prevBest === null) continue;
    if (isBid) {
      if (delta > 0 && e.price >= e.prevBest) ofi += delta;
      if (delta < 0 && e.price < e.prevBest) ofi += delta; // delta < 0
    } else {
      if (delta > 0 && e.price <= e.prevBest) ofi -= delta;
      if (delta < 0 && e.price > e.prevBest) ofi -= delta; // adds positive
    }
  }
  return ofi;
}
```

### 9.2 New module: `src/lib/hft/signals/trade-flow.ts`

```ts
export type Trade = {
  ts: number;
  price: number;
  size: number;
  takerSide: "buy" | "sell" | null; // null → use Lee-Ready inference
};

export function computeTFI(
  trades: Trade[],
  midAtTradeTime: (ts: number) => number, // for Lee-Ready when takerSide unknown
): { tfi: number; totalVolume: number; tfiNormalized: number } {
  let tfi = 0;
  let totalVolume = 0;
  for (const t of trades) {
    let sign = 0;
    if (t.takerSide === "buy") sign = +1;
    else if (t.takerSide === "sell") sign = -1;
    else {
      // Lee-Ready: above mid → buyer-initiated.
      const mid = midAtTradeTime(t.ts);
      sign = t.price > mid ? +1 : t.price < mid ? -1 : 0;
    }
    tfi += sign * t.size;
    totalVolume += t.size;
  }
  return {
    tfi,
    totalVolume,
    tfiNormalized: totalVolume > 0 ? tfi / totalVolume : 0,
  };
}
```

### 9.3 New module: `src/lib/hft/signals/vpin.ts`

```ts
export type VolBucket = { buyVol: number; sellVol: number; total: number; closedAt: number };

/** Build closed buckets given a trade stream and a bucket-volume threshold. */
export function bucketize(trades: Trade[], bucketVolume: number): VolBucket[] {
  const buckets: VolBucket[] = [];
  let cur: VolBucket = { buyVol: 0, sellVol: 0, total: 0, closedAt: 0 };
  for (const t of trades) {
    let remaining = t.size;
    while (remaining > 0) {
      const cap = bucketVolume - cur.total;
      const add = Math.min(remaining, cap);
      if (t.takerSide === "buy") cur.buyVol += add;
      else if (t.takerSide === "sell") cur.sellVol += add;
      cur.total += add;
      remaining -= add;
      if (cur.total >= bucketVolume) {
        cur.closedAt = t.ts;
        buckets.push(cur);
        cur = { buyVol: 0, sellVol: 0, total: 0, closedAt: 0 };
      }
    }
  }
  return buckets;
}

/** VPIN = rolling mean of |buy − sell| / total over the last N closed buckets. */
export function computeVPIN(buckets: VolBucket[], n: number): number | null {
  const recent = buckets.slice(-n);
  if (recent.length < n) return null;
  const sum = recent.reduce(
    (s, b) => s + Math.abs(b.buyVol - b.sellVol) / b.total,
    0,
  );
  return sum / n;
}
```

### 9.4 New module: `src/lib/hft/signals/sweep.ts`

```ts
export type Sweep = {
  ts: number;
  side: "buy" | "sell";
  totalVolume: number;
  levelsEaten: number;
  priceFrom: number;
  priceTo: number;
};

export function detectSweep(
  trades: Trade[],
  topOfBookAtStart: { bestBid: number; bestAsk: number; bidSize: number; askSize: number },
  windowMs: number,
  minVolumePctOfTop: number,
): Sweep | null {
  if (trades.length === 0) return null;
  const t0 = trades[0].ts;
  const within = trades.filter(t => t.ts - t0 <= windowMs);

  const bySide = (side: "buy" | "sell") =>
    within.filter(t => t.takerSide === side);
  const buyTrades = bySide("buy");
  const sellTrades = bySide("sell");

  const considerSide = (
    sideTrades: Trade[],
    topSize: number,
    refPrice: number,
    side: "buy" | "sell",
  ): Sweep | null => {
    const totalVol = sideTrades.reduce((s, t) => s + t.size, 0);
    if (totalVol < (topSize * minVolumePctOfTop) / 100) return null;
    const prices = sideTrades.map(t => t.price);
    const levels = new Set(prices).size;
    return {
      ts: sideTrades[0].ts,
      side,
      totalVolume: totalVol,
      levelsEaten: levels,
      priceFrom: side === "buy" ? Math.min(...prices) : Math.max(...prices),
      priceTo: side === "buy" ? Math.max(...prices) : Math.min(...prices),
    };
  };

  return considerSide(buyTrades, topOfBookAtStart.askSize, topOfBookAtStart.bestAsk, "buy")
    ?? considerSide(sellTrades, topOfBookAtStart.bidSize, topOfBookAtStart.bestBid, "sell");
}
```

### 9.5 New module: `src/lib/hft/signals/iceberg.ts`

```ts
export type OrderEvent = {
  ts: number;
  orderId: string;
  side: "bid" | "ask";
  price: number;
  size: number;
  type: "add" | "modify" | "cancel" | "trade";
  tradeSize?: number; // for "trade" events
};

export type IcebergDetection = {
  orderId: string | "synthetic";
  side: "bid" | "ask";
  price: number;
  refreshes: number;
  totalConsumedSoFar: number;
  firstSeen: number;
  lastRefresh: number;
};

/** Native iceberg detection — uses sustained same-order-ID refreshes after fills. */
export function detectNativeIcebergs(
  events: OrderEvent[],
  cfg: { minRefreshCount: number; refreshWindowMs: number },
): IcebergDetection[] {
  // Map orderId → running state. When trade hits orderId, expect a modify
  // event refreshing the size within refreshWindowMs. Count refreshes.
  // Implementation omitted from skeleton — see Zotikov 2019 §3.
  return [];
}

/** Synthetic iceberg detection — uses timing pattern after trades at price p. */
export function detectSyntheticIcebergs(
  events: OrderEvent[],
  cfg: { refreshWindowMs: number; minRefreshCount: number },
): IcebergDetection[] {
  return [];
}
```

### 9.6 Aggregator: `src/lib/hft/signals/aggregator.ts`

```ts
import { computeMicroprice, computeOBI, quotedSpreadBps } from "../dydx/signals";
import { computeOFI } from "./order-flow";
import { computeTFI } from "./trade-flow";
import { computeVPIN, bucketize } from "./vpin";
import { detectSweep } from "./sweep";

export type SignalSnapshot = {
  ts: number;
  midPrice: number;
  microprice: number | null;
  obi: number;
  spreadBps: number | null;
  ofi: number;
  tfi: number;
  tfiNormalized: number;
  vpin: number | null;
  lastSweep: Sweep | null;
  toxicity: "calm" | "elevated" | "toxic";
};

export function aggregateSignals(
  bids: BookLevel[],
  asks: BookLevel[],
  recentEvents: BookEvent[],
  recentTrades: Trade[],
  vpinBuckets: VolBucket[],
  cfg: { vpinWidenThreshold: number; vpinPauseThreshold: number },
): SignalSnapshot {
  const mid = (bids[0].price + asks[0].price) / 2;
  const microprice = computeMicroprice(bids, asks);
  const obi = computeOBI(bids, asks);
  const spreadBps = quotedSpreadBps(bids, asks);
  const ofi = computeOFI(recentEvents);
  const tf = computeTFI(recentTrades, () => mid);
  const vpin = computeVPIN(vpinBuckets, 50);
  const sweep = detectSweep(recentTrades, /* top of book */ { bestBid: bids[0].price, bestAsk: asks[0].price, bidSize: bids[0].size, askSize: asks[0].size }, 200, 50);

  const toxicity: SignalSnapshot["toxicity"] =
    vpin === null ? "calm"
      : vpin > cfg.vpinPauseThreshold ? "toxic"
      : vpin > cfg.vpinWidenThreshold ? "elevated"
      : "calm";

  return { ts: Date.now(), midPrice: mid, microprice, obi, spreadBps, ofi, tfi: tf.tfi, tfiNormalized: tf.tfiNormalized, vpin, lastSweep: sweep, toxicity };
}
```

---

## 10. Implementation path here

Concrete sequence to extend microstructure coverage in this repo.

1. **Lift the existing microprice/OBI primitives to `src/lib/hft/signals/`.** Currently in `src/lib/hft/dydx/signals.ts`; refactor to extract the venue-agnostic primitives into a shared location, leaving venue-specific aggregation in the dydx-subdir.

2. **Add the five new signal modules** per §9.1-9.5 (`order-flow.ts`, `trade-flow.ts`, `vpin.ts`, `sweep.ts`, `iceberg.ts`).

3. **Add the aggregator** (§9.6 — `aggregator.ts`) that the dYdX MM engine (and future MM engines) consume in place of just `dydx/signals.ts`.

4. **Wire the toxicity flag into `dydx/mm-engine.ts`** as a kill-switch: when `toxicity === "toxic"`, cancel all quotes and pause new quoting for a cool-down period. When `elevated`, widen by `cfg.toxicityWidenFactor`.

5. **Tests:**
   - `tests/unit/signals-microprice.test.ts` (exists; extend with deeper-level cases)
   - `tests/unit/signals-obi.test.ts` (exists; extend with spoofing-fixture tests)
   - `tests/unit/signals-ofi.test.ts` (new — fixtures from Cont/Kukanov 2014 paper)
   - `tests/unit/signals-tfi.test.ts` (new — Lee-Ready fallback cases)
   - `tests/unit/signals-vpin.test.ts` (new — flash-crash-like fixture with VPIN spike)
   - `tests/unit/signals-sweep.test.ts` (new — single-level sweep, multi-level sweep, no-sweep cases)
   - `tests/unit/signals-iceberg.test.ts` (new — native iceberg, synthetic iceberg, false positive)

6. **Backtest harness for signal evaluation:** `scripts/backtest-signals.ts` — replay historical L2 + trade tape, compute each signal, evaluate IC and signal half-life per asset. Output `docs/signals-results.json` (gitignored).

7. **Polymarket variant.** `src/lib/strategies/orderbook-imbalance.ts` already has Polymarket-specific OBI. Add `src/lib/strategies/microstructure-polymarket.ts` with binary-clipped microprice and TFI (Polymarket trades have known taker side from WS).

8. **UI surface.** Add a per-venue signals panel to `src/app/hft/page.tsx` showing live microprice, OBI, OFI, TFI, VPIN, and the toxicity flag. Useful for operator situational awareness.

9. **LLM trader integration.** Surface the `SignalSnapshot` to the LLM trader (`src/lib/agents/trader-llm.ts`) so it can cite microstructure in its `rationale` field. The LLM does not *compute* signals; it consumes them.

---

## 11. Asset-specific gotchas

### US equities (Alpaca + Polygon)

- **L2 feed required.** Free tier is L1; OBI/microprice need top-of-book size which means paid Market Data Plus or IEX DEEP via Polygon (~$100/mo).
- **OFI on equities is dominated by reg-NMS-routed orders.** A "new order at top" might be routed from another venue and visible only via the consolidated tape; raw exchange-level OFI undercounts. Reality: use SIP-consolidated event streams if you need true OFI, but they have ~10ms latency added.
- **VPIN buckets need volume normalization across regimes** — opening 30 min has 5× the volume of midday; same bucket size produces incomparable VPIN. Mitigation: use rolling 5-day per-time-of-day ADV for bucket sizing.
- **Iceberg detection is rare on lit equity venues** post Reg-NMS because most institutional flow uses dark pools. Don't expect strong iceberg signal on lit exchanges.

### Crypto spot

- **WS reconnect handling is critical.** OFI/event-based signals lose history during disconnects. On reconnect, re-snapshot the book and discard signal computation until enough fresh events accumulate (typical: skip first 30s of events post-reconnect).
- **Stablecoin pair signals are different from USD pair signals** — USDT pairs are dominated by Asia retail flow with different patterns than USD pairs (US institutional). Calibrate per pair, not per venue.
- **Coinbase Full Channel WS provides per-order event stream** — best venue for iceberg detection in crypto.

### Crypto perps

- **dYdX Indexer WS provides events but uses internal sequence numbers, not order IDs.** Iceberg detection requires fallback to timing-pattern (synthetic detection only).
- **Hyperliquid has the deepest books** but also the highest spoof rate among top-tier perp venues; persistence filter is essential.
- **Funding-window distortions** — books thin out 1-2 minutes before funding settlement; OFI/OBI signals are noisy then. Mitigation: gate signals by `time_to_next_funding > 300s`.

### Polymarket binaries

- **Books are thin** — OBI works at top-3 levels, not top-5; microprice is meaningful but should be clipped to `[ε, 1-ε]` (probability bounds).
- **Sweep detection has different semantics** — Polymarket binaries don't have many levels, so a "sweep" is often just a single trade consuming top-level size.
- **Iceberg detection is moot** — Polymarket CLOB doesn't support native icebergs and synthetic icebergs are rare due to thin book.

---

## 12. Open questions worth answering (research directions)

1. **Microprice vs higher-order microprice on dYdX BTC-PERP.** Stoikov's 2017 paper claims marginal lift from higher-order microprice; the Tsetlin-machine extension (2024 arXiv) claims much bigger lift on equities. Worth replicating for crypto perps.
2. **Adaptive OBI persistence threshold.** Current `n_persist = 3` is static. A regime-adaptive version (longer persistence during high-spoof regimes) could reduce false positives.
3. **TFI as standalone alpha.** Most uses of TFI are as a *helper* for MM. Standalone TFI-driven taker bots have published mediocre Sharpe (~0.5); could ML overlays improve?
4. **VPIN bucket-size auto-calibration.** Current static fraction-of-ADV approach is brittle; reinforcement-learning-tuned bucket size per asset is a clear improvement direction.
5. **Sweep + iceberg cross-signal.** A sweep that gets followed by an iceberg refresh is a much stronger signal than either alone. Build a paired-detector and measure.

---

## 13. References

[^stoikov2017]: Stoikov, S. (2017). "The Micro-Price: A High Frequency Estimator of Future Prices." SSRN 2970694. [papers.ssrn.com/abstract=2970694](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2970694).

[^cks2014]: Cont, R., Kukanov, A., & Stoikov, S. (2014). "The Price Impact of Order Book Events." *Journal of Financial Econometrics* 12(1), 47-88. [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1712822) · [arXiv 1011.6402](https://arxiv.org/abs/1011.6402).

[^leeready1991]: Lee, C. M. C., & Ready, M. J. (1991). "Inferring Trade Direction from Intraday Data." *Journal of Finance* 46(2), 733-746. — Canonical algorithm for inferring taker side when not provided.

[^elop2010]: Easley, D., Lopez de Prado, M. M., & O'Hara, M. (2012). "Flow Toxicity and Liquidity in a High-Frequency World." *Review of Financial Studies* 25(5), 1457-1493. [VPIN PDF](https://www.quantresearch.org/VPIN.pdf).

[^vpin_flash]: Easley, Lopez de Prado, O'Hara (2011). "The Microstructure of the 'Flash Crash': Flow Toxicity, Liquidity Crashes, and the Probability of Informed Trading." *Journal of Portfolio Management* 37(2), 118-128.

[^zotikov2019]: Zotikov, D. (2019). "CME Iceberg Order Detection and Prediction." arXiv:1909.09495. [arxiv.org/abs/1909.09495](https://arxiv.org/abs/1909.09495).

[^tsetlin2024]: "High Resolution Microprice Estimates from Limit Orderbook Data using Hyperdimensional Vector Tsetlin Machines." arXiv:2411.13594, 2024. [arxiv.org/pdf/2411.13594](https://arxiv.org/pdf/2411.13594).

[^hftb]: hftbacktest. "Market Making with Alpha — Order Book Imbalance." [Read the Docs tutorial](https://hftbacktest.readthedocs.io/en/latest/tutorials/Market%20Making%20with%20Alpha%20-%20Order%20Book%20Imbalance.html).

[^johal2025]: Johal. "High-Frequency Trading Algorithms: ML Strategies for Market Microstructure Analysis 2025." [johal.in](https://johal.in/high-frequency-trading-algorithms-ml-strategies-for-market-microstructure-analysis-2025/).

[^medium_orderflow]: Silantyev, E. "Order Flow Analysis of Cryptocurrency Markets." Medium. [medium.com/@eliquinox](https://medium.com/@eliquinox/order-flow-analysis-of-cryptocurrency-markets-b479a0216ad8) — practitioner replication of TFI vs OFI horizon-dependence.

**Industry / practitioner**
- VisualHFT. "Volume-Synchronized Probability of Informed Trading (VPIN)." [visualhft.com/blog](https://www.visualhft.com/blog/volume-synchronized-probability-of-informed-trading-vpin/).
- Bookmap. "Stops and Icebergs: How to Detect Hidden Orders Using MBO Data." [bookmap.com/blog](https://bookmap.com/blog/stops-and-icebergs-how-to-detect-hidden-orders-using-mbo-data).
- Federal Reserve. "Order Flow Imbalances and Amplification of Price Movements: Evidence from U.S. Treasury Markets." FEDS Notes, Nov 2025. [federalreserve.gov](https://www.federalreserve.gov/econres/notes/feds-notes/order-flow-imbalances-and-amplification-of-price-movements-evidence-from-u-s-treasury-markets-20251103.html).
- "Deep Reinforcement Learning for Optimizing Order Book Imbalance-Based High-Frequency Trading Strategies." ResearchGate 2024. [researchgate.net](https://www.researchgate.net/publication/391292844_Deep_Reinforcement_Learning_for_Optimizing_Order_Book_Imbalance-Based_High-Frequency_Trading_Strategies).

**Related modules in this repo**
- `src/lib/hft/dydx/signals.ts` — `computeMicroprice`, `computeOBI`, `quotedSpreadBps`, `obiWidenMultiplier` (live).
- `src/lib/strategies/orderbook-imbalance.ts` — Polymarket OBI detector with persistence + signal-strength normalization.
- `src/lib/hft/dydx/mm.ts` — consumer of OBI in MM quote-shift.
- `src/lib/hft/edge.ts` — cost-edge formula every signal-driven trade must pass.
- `tests/unit/signals.test.ts` — pattern for signal-primitive tests.
