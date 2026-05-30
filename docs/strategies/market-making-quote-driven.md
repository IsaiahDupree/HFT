# Market Making — Quote-Driven (Avellaneda-Stoikov & Variants)

> **Family:** 1 — Market making (passive liquidity)
> **Variants covered:** baseline quote-driven · Avellaneda-Stoikov inventory-aware · OBI-enhanced · queue-position aware
> **Repo modules:** `src/lib/hft/dydx/mm.ts`, `mm-engine.ts`, `signals.ts`
> **Cross-asset coverage:** US equities (Alpaca) · crypto spot (Coinbase) · crypto perps (dYdX, Hyperliquid) · prediction markets (Polymarket)

---

## 1. TL;DR

Post a bid below and an ask above the fair price. Earn the spread on every
round-trip fill. The naïve version loses money because (a) you accumulate
inventory at exactly the wrong times (Glosten-Milgrom adverse selection) and
(b) you can't size the spread to the actual volatility (Avellaneda-Stoikov's
contribution).

The Avellaneda-Stoikov (A-S) model gives you two numbers per tick:

- **Reservation price** `r = mid − q · γ · σ² · (T−t)` — your fair value shifted *against* your inventory.
- **Optimal spread** `δ = γ · σ² · (T−t) + (2/γ) · ln(1 + γ/k)` — wider when volatility, inventory cost, or order-flow toxicity are high.

You quote `bid = r − δ/2`, `ask = r + δ/2`. That's the entire skeleton.

Everything modern is a variant: RL-tuned γ, OBI-adjusted reservation price,
queue-position-aware aggressiveness, multi-level laddering. All inherit the
A-S core.

---

## 2. Mechanism

### 2.1 Why spreads exist at all (Glosten-Milgrom)

Glosten & Milgrom (1985) [^gm1985] proved that in a market with informed and
uninformed traders, even a risk-neutral, zero-profit dealer must quote a
*positive* bid-ask spread. The reason:

- Half the time you trade against an uninformed trader (no edge to either side).
- Half the time you trade against an informed trader (you're on the wrong side, by definition).

Pricing the bid at `E[V | sell order arrives]` and the ask at `E[V | buy order arrives]` — both Bayesian updates of the dealer's prior given the order — gives a positive spread whose width is set by:

```
spread ∝ P(informed) · variance_of_V
```

The higher the share of informed flow, the wider the spread you must quote
to break even. This is *adverse selection cost*.

**Practical takeaway:** if your venue's flow is dominated by informed
traders (a 0-fee retail venue with high signal-to-noise ratio), you cannot
make money market making no matter how good your quote logic is. You're
selecting for being on the wrong side.

### 2.2 Avellaneda-Stoikov (2008): putting inventory into the price

Avellaneda & Stoikov [^as2008] frame MM as a stochastic optimal control
problem. The MM has utility `U = -exp(-γ · X_T)` over terminal wealth (CARA
risk preferences), inventory `q_t` that evolves with each fill, and faces a
mid-price following Brownian motion.

The HJB equation has a closed-form solution. The MM should quote:

**Reservation price** — the "indifference price" given current inventory:

```
r(t) = s(t) − q · γ · σ² · (T − t)
```

where
- `s(t)` = current mid-price
- `q` = current inventory (signed; positive = long)
- `γ` = risk aversion (units: 1 / $)
- `σ²` = mid-price variance (per unit time)
- `(T − t)` = time remaining to end-of-session

**Optimal spread** — width of the bid-ask quote pair around `r`:

```
δ_total = γ · σ² · (T − t) + (2/γ) · ln(1 + γ/k)
```

where
- `k` = order-arrival intensity decay rate (how fast quote arrival drops as you move away from mid)

You then place:
- `bid = r − δ_total / 2`
- `ask = r + δ_total / 2`

**Why the math has the shape it does.**

- The `-q · γ · σ² · (T−t)` term in `r` *pulls your quotes away from inventory*. If you're long, your reservation price shifts down → you raise your bid less aggressively and lower your ask more aggressively → you start losing inventory. The further into the session, the smaller `(T−t)`, so the term shrinks and you stop fighting inventory as the deadline approaches. This is "inventory penalization that wears off."
- The first term of `δ_total` is the inventory-risk premium — wider spread when volatility, risk aversion, or remaining time is high.
- The second term `(2/γ) · ln(1 + γ/k)` is the asymmetric-information premium — the *quote-only* width that makes the dealer indifferent between zero-fills and one-fills under Poisson arrival.

### 2.3 Why operators don't use raw A-S in production

The classical A-S has three weaknesses that production crypto/equities MMs
all patch:

1. **`T → ∞` is the right limit for crypto perps.** A-S assumes a finite session ending at `T` (an inventory deadline like equities close). Crypto has 24/7 markets. The fix: use a "rolling horizon" — set `T` to e.g. 24h ahead and renew each minute. Alternatively, use the *infinite-horizon* Cartea-Jaimungal variant [^cj2015].
2. **Constant `σ²` is wrong during news.** Inventory penalization scales linearly with `σ²`; if your vol estimate is stale, the quote widths are wrong by orders of magnitude during a print. Fix: EWMA-based `σ̂_t²` updated tick-by-tick (typical half-life 30s–5min depending on asset).
3. **Constant `k` ignores order-flow toxicity.** When informed flow ramps up, `k` should rise (your quotes get hit faster *and* on the wrong side). Production MMs replace `k` with an OBI-aware or VPIN-aware function.

Marin & Vera (2022) [^mv2022] address all three via deep RL, where a neural
network tweaks `γ` per state. Their Alpha-AS-1 and Alpha-AS-2 backtested on
30 days of BTC-USD show ~30-40% improvement in Sharpe over vanilla A-S, with
the bulk of the gain coming from regime-aware `γ` adjustment around
high-volatility periods.

### 2.4 The OBI extension (this repo's pragmatic choice)

OBI (order-book imbalance, see `src/lib/strategies/orderbook-imbalance.ts`)
gives you a tick-by-tick estimate of *short-term* directional pressure. A
simple, widely-used extension:

```
r_obi(t) = r_AS(t) + λ · OBI(t) · spread_AS(t)
```

with `λ ∈ [0, 0.5]` typically. OBI ∈ [−1, +1]: `+1` is all bid, `−1` is all
ask. This *shifts* the reservation price toward where the book pressure
points, capturing a chunk of the directional move before the mid-price
catches up.

This is the variant the dYdX MM in this repo runs (`src/lib/hft/dydx/mm.ts`,
which calls `src/lib/hft/dydx/signals.ts` for the OBI input).

---

## 3. Where it works

| Asset class | Venue | Verdict | Notes |
|---|---|---|---|
| US equities | Alpaca paper/live | ⚠️ feasible mid-cap only | Retail MM tier doesn't exist; you compete with HFT firms at NBBO. Workable: post inside-the-spread on mid-caps with wide effective spreads (>10 bps) during low-vol periods. Alpaca's L2 add-on is required. |
| US equities | IEX / Boxing-router | ❌ | T0 game. Move on. |
| Crypto spot | Coinbase Adv | ✅ tier-gated | Maker fee 0 → −15 bps at top tier. Get to tier *before* deploying capital; below tier the fees eat the spread. |
| Crypto spot | Binance, OKX | ✅ | Same shape; tighter spreads on majors so smaller edge per fill but more fills. |
| Crypto perps | dYdX v4 | ✅ | Maker rebate active; this repo's `dydx/mm.ts` lives here. |
| Crypto perps | Hyperliquid | ✅ | Maker discount; deeper books than dYdX, more competition. |
| Crypto perps | Paradex | ✅ | Smaller volume but cleaner book; less queue contention. |
| Polymarket binaries | Polymarket CLOB | ✅ | Thin books, wide spreads (often 100-500 bps), low queue contention. The single best venue for retail-scale MM. |

**Capital scale where each is viable:**

- Polymarket: $500 → $50k notional per side. Above that, your quotes *are* the book and adverse selection eats you.
- Coinbase Adv: $5k → $500k. Maker tier requires >$50M 30d volume for the top rebate, so capital needs to recycle.
- dYdX: $5k → $250k. Above that, fills get sparse because top-of-book size is limited.
- Alpaca equities: $25k → $100k per name. Pattern Day Trader rules apply <$25k.

---

## 4. Edge magnitude

What to expect, with citations. All numbers are gross of operating cost
(VPS, data feeds, dev time) and assume the MM is *well-parameterized*.

| Venue / asset | Annualized return on notional capital | Sharpe | Source |
|---|---|---|---|
| Polymarket binaries (thin books) | 20-60% on small size, decays fast above $10k | 1.5-3.0 | Operator backtests; no public benchmark |
| dYdX perp MM (BTC/ETH) | 5-15% net of fees | 1.0-2.5 | dYdX trading rewards + this repo's testnet sweeps |
| Coinbase spot MM (top tier) | 3-10% | 1.0-2.0 | Public Hummingbot operator reports |
| Crypto spot MM (no rebate tier) | -2 to +3% | ~0 | Same — without rebates, you're paying the spread to nobody |
| Alpaca equity MM (mid-cap, retail) | 0-5% gross, often negative net | 0-1.0 | Limited public data; this is "hobbyist tier" |
| A-S with RL γ tuning (Alpha-AS-2) | +30-40% Sharpe lift over vanilla A-S on BTC-USD | not reported as absolute | Marin & Vera 2022 [^mv2022] |

**Decay over time.** All MM edges decay. The 60% Polymarket number above
was probably true in 2024; by mid-2026 the thinner BTC binaries are tighter
and the number is closer to 20-30%. New venues open new edges; old venues
close them.

---

## 5. What kills it

Ranked by how often it kills MM strategies in practice.

1. **Tier loss / fee changes.** You're earning on a rebate that flips to a fee. Daily PnL check should include "what's my next-tier breakeven?" Monitor: track 30d volume, rebate tier, and per-fill economics in your live dashboard.
2. **Adverse selection (Glosten-Milgrom realized).** Your fills are biased to wrong-side. Detection: track post-fill markout at 1s, 10s, 60s. If your average markout against you exceeds half the spread you captured, your effective edge is negative.
3. **Inventory accumulation across regimes.** A-S assumes mean-reverting price; in a strong trend, the inventory penalty wears off too slowly and you carry directional risk into the next regime. Mitigation: hard inventory cap with kill-switch; reduce `γ` during low-vol if you can tolerate the inventory.
4. **Latency-driven stale quotes.** Mid-price moved 5 bps; your quote is still at the old mid. A faster MM lifts your ask. Mitigation: cancel-replace on a deadband (e.g. cancel if mid moved more than `0.5 · spread/2`); use WS for venue feeds; co-locate when budget allows.
5. **Quote-stuffing / spoofing on the other side.** Especially in crypto: a fake big bid appears, your OBI extension shifts your reservation price up, you raise your bid, the fake bid vanishes, your bid is now the top of the book and gets hit by toxic flow. Mitigation: persistence filter on OBI (require N consecutive snapshots before acting); discount large outsized orders that haven't been there >5s.
6. **Funding rate shocks (perps only).** Holding inventory across funding payment with the wrong sign costs you the funding rate. Mitigation: in `dydx/mm.ts`, gate quote aggressiveness by hours-to-next-funding × current-funding-rate.
7. **Exchange downtime / quote rejection.** Your kill-switch must trigger on (a) order placement failures, (b) feed staleness, (c) sudden book-collapse. Don't just rely on PnL drawdown.

---

## 6. Parameters

Every A-S MM has these. Defaults are starting points; tune via grid search
on a paper-trading slice.

| Param | Symbol | Units | Default | Sensible range | What it does |
|---|---|---|---|---|---|
| Risk aversion | `γ` | 1/$ | 0.1 | [0.01, 1.0] | Higher → wider spread + faster inventory bleed-off |
| Inventory cap | `q_max` | base units | 10 contracts | venue-dependent | Hard stop on signed inventory |
| Vol window | EWMA half-life | seconds | 60s | [10s, 600s] | Faster reactions but noisier σ̂ |
| Quote refresh deadband | `δ_refresh` | bps | 1.0 | [0.2, 5.0] | Cancel-replace if mid moves > this since last quote |
| Quote ladder depth | `n_levels` | int | 1 | [1, 5] | More levels = more notional posted but harder to manage |
| Per-level size | `s_level` | base units | 0.05 BTC | depends on venue | Notional per quote level |
| Session horizon | `T − t` | seconds | 86400 (1 day rolling) | [3600, 604800] | Inventory penalty scaler; tune for asset's reversion speed |
| Order-arrival intensity decay | `k` | events/bp | 0.5 | [0.1, 2.0] | A-S spread term; fit from historical fill data |
| OBI weight | `λ` | dimensionless | 0.2 | [0, 0.5] | OBI extension strength |
| OBI persistence | `n_persist` | snapshots | 3 | [1, 10] | Anti-spoof: require N consecutive imbalance reads |
| Markout window | `t_markout` | seconds | 30 | [1, 300] | Adverse-selection monitor horizon |
| Kill-switch drawdown | `dd_max` | bps of equity | 100 | [10, 500] | Halt MM if intraday DD exceeds |
| Funding-gate distance | `t_funding` | seconds | 600 | [60, 3600] | Reduce inventory before funding payment if `|rate| > X` |

---

## 7. Fill model (for backtesting)

The single biggest gap between paper and live MM PnL is the fill model.
Choose the model that matches your venue's matching engine.

### 7.1 Pessimistic (default for first backtest)

You fill **only if the market trades through your quote**. Specifically:
your bid at `B` fills when a market sell trade prints at price ≤ `B`. Your
ask at `A` fills when a market buy trade prints at price ≥ `A`.

Pros: doesn't overestimate fills.
Cons: doesn't model partial fills, queue position, or fills *at* your quote
price (which happen often in liquid books).

### 7.2 Queue-aware (the realistic model)

Maintain an estimate of `your_position_in_queue(price)` for each of your
resting orders. When a trade prints at your price `P` with size `v`:

- If `v ≥ your_queue_position`, you fill — fully if `v ≥ your_queue_position + your_size`, partially otherwise.
- If `v < your_queue_position`, queue advances by `v`.

When other orders arrive at your price ahead of you, they don't affect you
unless they're an *amend* by a higher-priority order. When orders arrive at
your price behind you, they sit behind you.

When you cancel-replace, you go to the back of the new price's queue.

This is the model used by HFT backtesters like [`hftbacktest`](https://hftbacktest.readthedocs.io/) [^hftb]. Implementing it requires per-tick L2 snapshots *and* per-tick trades stream — both available from Coinbase, dYdX, Hyperliquid; partially available from Polymarket.

### 7.3 Adverse-selection injection

Even with a queue model, paper MM tends to overestimate. Inject an adverse
selection cost: every fill is followed by a `markout_τ` price move *against*
you with probability `p_adv`, where `p_adv` is calibrated from historical
live trading (start with `p_adv = 0.55`, `markout = 0.5 · spread`).

This forces your backtest to honestly account for being the *liquidity
provider* to traders who picked you.

---

## 8. Backtest design

### 8.1 Data

| Source | What you need | Where |
|---|---|---|
| L2 book snapshots | 100ms or 1s, top 10 levels | Tardis.dev (paid), Coinbase WS captured live, dYdX Indexer captured live |
| Trade tape | every fill with timestamp, side, size, price | same |
| Funding rate history | hourly, per perp | dYdX Indexer `/historicalFunding`, Binance/Hyperliquid REST |
| Fee schedule snapshots | per-day rebate tier per venue | maintain a CSV |

### 8.2 Metrics

Required:

- **PnL net of fees** — daily and cumulative.
- **Sharpe** — daily; annualize × √252.
- **Maximum drawdown** — and DD duration.
- **Fill rate** — fills per quote per hour.
- **Inventory excursions** — distribution of `|q|`; check tail.
- **Markout (1s, 10s, 60s)** — distribution; the post-fill price move per side.
- **Quote-update latency** — your decision-to-ack histogram.

Reject if:

- Average markout against you > 0.5 × captured spread (adverse selection too strong)
- Inventory tail beyond `q_max` (kill-switch wasn't aggressive enough)
- Sharpe < 0.5 after fees on paper (won't survive live)

### 8.3 Walk-forward

Slice the data into rolling windows: train on 30 days, test on the next 7,
roll forward by 7 days. Re-tune `γ` per window. If the test-window Sharpe
collapses while train-window Sharpe stays high, you're overfitting `γ` to
regime. The fix is either RL-tuned `γ` (Alpha-AS variant) or a regime
classifier upstream.

### 8.4 Look-ahead traps

- **Don't use the trade's print as your fill timestamp.** You'd have needed the order in the book *before* the print. Use book-snapshot timestamps.
- **Don't use future mid to compute current OBI.** Snap a book, compute OBI from that snap, act on the *next* snap.
- **Don't use perfect cancel timing.** Add a `t_cancel` latency (typically 50ms-500ms) before your cancel takes effect; during that window you can still be filled.

---

## 9. Code skeleton

Drop-in shape for a new market this repo doesn't yet quote. Follows the
conventions of `src/lib/hft/dydx/mm.ts`:

```ts
// src/lib/hft/<venue>/mm.ts
import type { Venue } from "../venues";
import { evaluateEdge } from "../edge";
import type { OrderbookSnapshot } from "@/lib/strategies/orderbook-imbalance";

export type ASConfig = {
  gamma: number;          // risk aversion γ
  kIntensity: number;     // order-arrival decay k
  sessionSec: number;     // T − t, in seconds
  invMaxBase: number;     // q_max in base units
  obiWeight: number;      // λ, OBI extension
  obiPersist: number;     // anti-spoof: # snapshots
  quoteSize: number;      // size per side per level
  refreshDeadbandBps: number;
};

export type MmTick = {
  ts: number;
  mid: number;
  sigmaSq: number;        // EWMA-estimated mid-variance, per unit time
  inventoryBase: number;  // signed q in base units
  obi: number;            // ∈ [−1, +1]
  obiSnapshotsAgreeing: number;
  book: OrderbookSnapshot;
};

export type Quote = { bid: number; ask: number; size: number };

export function quoteAS(tick: MmTick, cfg: ASConfig): Quote | null {
  const { mid, sigmaSq, inventoryBase: q, obi, obiSnapshotsAgreeing } = tick;
  const T = cfg.sessionSec;

  // Hard inventory cap → don't widen further; flat-only quotes.
  if (Math.abs(q) >= cfg.invMaxBase) {
    return q > 0
      ? { bid: NaN, ask: mid + 1e-9, size: cfg.quoteSize }  // sell only
      : { bid: mid - 1e-9, ask: NaN, size: cfg.quoteSize };
  }

  // Reservation price: pull away from inventory.
  const inventoryPenalty = q * cfg.gamma * sigmaSq * T;
  let r = mid - inventoryPenalty;

  // OBI extension — only if persistence threshold met.
  if (obiSnapshotsAgreeing >= cfg.obiPersist) {
    const spreadAS = cfg.gamma * sigmaSq * T
      + (2 / cfg.gamma) * Math.log(1 + cfg.gamma / cfg.kIntensity);
    r += cfg.obiWeight * obi * spreadAS;
  }

  // Half-spread.
  const halfSpread =
    (cfg.gamma * sigmaSq * T
      + (2 / cfg.gamma) * Math.log(1 + cfg.gamma / cfg.kIntensity)) / 2;

  return {
    bid: r - halfSpread,
    ask: r + halfSpread,
    size: cfg.quoteSize,
  };
}

/** Edge-gate the quote: refuse to post if net expected edge < 0. */
export function shouldPost(
  q: Quote,
  venue: Venue,
  spreadBpsObserved: number,
  fillsPerDayEst: number,
): boolean {
  const halfSpreadBps = ((q.ask - q.bid) / 2) /
    ((q.ask + q.bid) / 2) * 10_000;
  const edge = evaluateEdge({
    notionalUsd: q.size * (q.ask + q.bid) / 2,
    expectedEdgeBps: halfSpreadBps,          // we capture half-spread per round trip
    spreadBps: 0,                            // maker doesn't cross spread
    slippageBps: 0,
    latencyPenaltyBps: 0.5,
    adverseSelectionBps: halfSpreadBps * 0.4, // start with 40% adverse haircut
    side: "maker",
    fillsPerDay: fillsPerDayEst,
    fillRate: 1.0,
  });
  return edge.passes;
}
```

Wire-up notes (matches dYdX MM engine):

- `MmTick` is produced by a per-tick aggregator (see `dydx/signals.ts`).
- `quoteAS` is pure — easy to unit-test (`tests/unit/dydx-mm.test.ts` pattern).
- `shouldPost` gates posting via `src/lib/hft/edge.ts` so the cost-edge invariant is machine-checked.
- The engine wrapper (`mm-engine.ts`) handles cancel-replace, kill-switch, and inventory hard cap.

---

## 10. Implementation path here

To add a new venue's MM (e.g. Coinbase spot, Alpaca equities, Polymarket):

1. **Add the venue to `src/lib/hft/venues.ts`** with its fee/rebate tier (already present for Coinbase + Polymarket; Alpaca needs an entry).
2. **Add `src/lib/hft/<venue>/signals.ts`** producing the `MmTick` shape above. Inputs: venue WS feed adapter + L2 snapshot stream. Output: `(ts, mid, sigmaSq, inventoryBase, obi, obiSnapshotsAgreeing, book)`.
3. **Add `src/lib/hft/<venue>/mm.ts`** with `quoteAS(tick, cfg)` (paste the skeleton above; adjust types).
4. **Add `src/lib/hft/<venue>/mm-engine.ts`** that wires `signals → quoteAS → shouldPost → place/cancel`. Mirror `dydx/mm-engine.ts`.
5. **Tests** — copy `tests/unit/dydx-mm.test.ts` and adapt. Add a fixture L2 snapshot for each MM regime (balanced book, bid-heavy, ask-heavy, one-sided, dust book).
6. **Integration** — add the engine to `src/lib/hft/dydx/engine-registry.ts`-style registry so the `/hft` page can render its status.
7. **Killswitch** — wire the engine into `src/lib/risk/kill-switch.ts` (per-engine `kill()` method, drain inventory or just cancel-all).
8. **Backtest harness** — add a `scripts/backtest-<venue>-mm.ts` modeled on the existing arena backtests; emits `docs/<venue>-mm-results.json` (which the widened gitignore now catches automatically — don't worry about leaking).

**Single-file MVPs** are good for first-cut research; promote to the
`signals → mm → engine` split once you've shown it pencils on paper.

---

## 11. Asset-specific gotchas

### Equities (Alpaca)

- **No maker rebate.** Alpaca passes through exchange routing; you don't get IEX or NYSE rebates as a retail customer. This kills classical A-S economics unless effective spread > ~10 bps.
- **PDT rule.** Under $25k equity, you can't make 4 day-trades in 5 days. MM exceeds that on a busy hour.
- **L2 data.** Free tier is L1 only. Paid feed required for OBI. Budget $99/mo for Alpaca Market Data Plus or use IEX DEEP via Polygon as alternative.
- **Halts.** Single-stock halts happen often (LULD bands). Your engine must handle quote rejection during halts.
- **What works:** mid-cap MM with `spread > 8 bps` baseline. Avoid the top 100 most-liquid names — those are owned by Citadel/Virtu.

### Crypto spot (Coinbase Adv)

- **Tier-gated economics.** At <$10M 30d volume, maker fee is ~0 bps; at top tier it's −15 bps (rebate). Plan capital recycling to climb the tier.
- **API rate limits.** REST is throttled; use WS for L2. Coinbase WS is reliable but disconnects happen — engine must auto-reconnect.
- **Cancel-all latency.** Mass-cancel on regime change can take 1-3s during high vol. Plan inventory caps assuming you cannot cancel instantly.
- **Stablecoin pairs.** USDC pairs have tighter spreads than USD pairs; consider venue routing.

### Crypto perps (dYdX, Hyperliquid)

- **Funding rate is your hidden tax.** Holding inventory across the hourly funding window can erase a day of MM gains. The `funding-gate` parameter exists for this.
- **Liquidation-cascade volatility.** Perps have endogenous vol spikes around liquidation levels. Your σ̂ estimator should weight recent ticks heavily (low half-life, e.g. 30s) to catch these.
- **dYdX specifics:** order rejection on undercollateralization is silent; engine must verify the order is in the book each tick. Hyperliquid: faster placement, but cancel-replace counts toward rate limits aggressively.
- **Maker rebate paid in token (dYdX rewards).** Treat rewards as deferred income; don't credit them to per-fill PnL.

### Prediction markets (Polymarket)

- **Discrete probability bounds.** Quote `bid > 0`, `ask < 1`. Reservation price must be clipped: `r ∈ [ε, 1−ε]`.
- **Resolution risk.** Holding inventory through resolution is a binary payoff — you either get $1 or $0 per share. MM logic should drain inventory before resolution (cf. `src/lib/strategies/near-resolution-scrape.ts` for the inverse — *taking* this risk intentionally).
- **Complement-sum constraint.** YES + NO of a binary should sum to ≤ $1 net of fees. If your bid YES + bid NO > $1, you're being arbed (see `complement-sum-arb.ts`).
- **What works:** binary BTC/ETH up-down markets near resolution where the order book is genuinely thin and CEX gives a clean fair value (cf. `src/lib/hft/polymarket-btc.ts`).

---

## 12. Open questions worth answering (research directions)

1. **Can RL-tuned `γ` outperform on Polymarket?** Marin-Vera showed +30-40% Sharpe on BTC-USD spot. The Polymarket binary regime (discrete payoffs, resolution clock) might break the assumption — worth a backtest.
2. **OBI persistence vs. quote latency.** What's the optimal `n_persist` for a 5-50ms quote-cancel-replace cycle? Heuristic suggestion: `n_persist ≈ ceil(50ms / snapshot_period_ms)`.
3. **Multi-venue inventory netting.** If you MM dYdX BTC-USD and Coinbase BTC-USD with linked inventory caps, can you reduce `γ` per venue (since cross-venue hedging absorbs inventory risk)? Plausible; needs simulation.
4. **Polymarket binary as a vol surface.** Each binary at a strike on a price-up-down market is a digital option. The market-implied prices form a (very sparse) vol surface. Worth experimenting.

---

## 13. References

[^gm1985]: Glosten, L. R., & Milgrom, P. R. (1985). "Bid, ask and transaction prices in a specialist market with heterogeneously informed traders." *Journal of Financial Economics*, 14(1), 71-100. — Foundation of adverse-selection MM theory. [Columbia archive](https://business.columbia.edu/faculty/research/bid-ask-and-transaction-prices-specialist-market-heterogeneously-informed-traders).

[^as2008]: Avellaneda, M., & Stoikov, S. (2008). "High-frequency trading in a limit order book." *Quantitative Finance*, 8(3), 217-224. — The closed-form reservation-price / optimal-spread MM model. [Stanford MS&E448 reading PDF](https://stanford.edu/class/msande448/2018/Final/Reports/gr5.pdf).

[^cj2015]: Cartea, Á., Jaimungal, S., & Penalva, J. (2015). *Algorithmic and High-Frequency Trading.* Cambridge University Press. — Textbook treatment including infinite-horizon MM variants.

[^mv2022]: Marin, J., & Vera, M. (2022). "A reinforcement learning approach to improve the performance of the Avellaneda-Stoikov market-making algorithm." *PLOS ONE*, 17(12), e0277042. — Alpha-AS-1 and Alpha-AS-2 RL-tuned variants. [PMC full text](https://pmc.ncbi.nlm.nih.gov/articles/PMC9767337/).

[^hftb]: hftbacktest project. "Market Making with Alpha — Order Book Imbalance." [Read the Docs tutorial](https://hftbacktest.readthedocs.io/en/latest/tutorials/Market%20Making%20with%20Alpha%20-%20Order%20Book%20Imbalance.html).

**Industry references**
- Hummingbot. "Guide to the Avellaneda & Stoikov Strategy." [hummingbot.org/blog](https://hummingbot.org/blog/guide-to-the-avellaneda--stoikov-strategy/) — production Python implementation, parameters explained for ops.
- Udit Samani. "Optimal Market Making (Avellaneda-Stoikov)." [uditsamani.com/avellaneda-stoikov](https://uditsamani.com/avellaneda-stoikov/) — clean derivation walk-through.
- QuantLabsNet. "Ultra Low Latency High Frequency Market Making: A Comprehensive Analysis of the Avellaneda-Stoikov Framework with Order Flow Imbalance Enhancement." [quantlabsnet.com](https://www.quantlabsnet.com/post/ultra-low-latency-high-frequency-market-making-a-comprehensive-analysis-of-the-avellaneda-stoikov-f).

**Related modules in this repo**
- `src/lib/hft/dydx/mm.ts` — current dYdX MM with A-S + OBI extension.
- `src/lib/hft/dydx/signals.ts` — OBI + microprice + σ̂ estimation.
- `src/lib/hft/dydx/mm-engine.ts` — engine wrapper, cancel-replace logic.
- `src/lib/hft/edge.ts` — the cost-edge inequality this strategy must pass.
- `src/lib/strategies/orderbook-imbalance.ts` — Polymarket-side OBI detector.
- `tests/unit/dydx-mm.test.ts` — unit tests for the quote-derivation logic.
