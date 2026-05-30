# Execution Algorithms — TWAP, VWAP, POV, IS, Adaptive

> **Family:** 6 — Execution algorithms
> **Variants covered:** TWAP · VWAP · POV (Participation) · Implementation Shortfall · Adaptive (alpha-aware / RL-tuned) · Iceberg / child-order splitting
> **Repo modules:** *none yet — this doc seeds the implementation*; ties into `src/lib/venue/router.ts` and `src/lib/venue/ExecutionRouter`
> **Cross-asset coverage:** US equities (Alpaca) · crypto spot (Coinbase, Binance) · crypto perps (dYdX, Hyperliquid) · prediction markets (Polymarket — IS only; POV doesn't apply to thin binaries)

---

## 1. TL;DR

When the strategy says "open a $100k BTC long," the execution algo
decides *how to do it without giving back the alpha to the market*.
Naive market orders work fine for $500 trades; for $50k+ they're an
edge-erasure machine.

Six canonical algos:

1. **TWAP** — slice the order into equal-sized child orders at equal time intervals. Dumb but predictable. Use when you have no view of intraday volume patterns.
2. **VWAP** — slice in proportion to *historical volume profile*. Better than TWAP when intraday volume has a stable shape (U-curve on equities, U-shape on crypto majors).
3. **POV (Participation)** — child-order rate scales with *current* market volume so you stay at fixed % of throughput. Self-paces during quiet/busy periods.
4. **Implementation Shortfall (IS)** — minimize the slippage between *decision price* (when you decided to trade) and *fill price*. The default for any "alpha-driven" trade where speed matters.
5. **Adaptive / alpha-aware** — IS variant that speeds up when price is moving with you, slows down when moving against you. Modern variants are RL-tuned (RBC Aiden, Citadel internals).
6. **Iceberg / child-order splitting** — display only a small fraction of the true size as a limit order; refresh as filled. Crosses with hidden-order detection on the receiving end.

The right algo depends on **what you're trying to minimize**: tracking
error vs benchmark (VWAP/POV), slippage vs arrival price (IS), or signal
leakage (iceberg). Choose by the strategy's economics, not by which is
"best in general."

This doc is the **execution overlay** every other strategy in the
dossier should use at size. Without it, MM positions exit at terrible
fills, arb hedges leak edge, and pairs strategies get picked off on
rebalances.

---

## 2. Mechanism

### 2.1 The cost-impact dichotomy (Almgren-Chriss)

Almgren & Chriss (2000)[^ac2000] showed every execution algo trades off
two costs:

- **Market impact** — moving the price by the act of trading. Decomposes into:
  - **Temporary impact** — your large order eats levels; price snaps back after you stop.
  - **Permanent impact** — the market infers your information from your trading; price stays moved.
- **Timing risk** — uncertainty about price during the time you take to trade. Longer execution = more timing risk = more volatility-induced cost.

Faster execution → more market impact, less timing risk.
Slower execution → less market impact, more timing risk.

The Almgren-Chriss closed-form solution gives the optimal trade trajectory
`x(t)` for liquidating `X` shares over horizon `T`:

```
x(t) = X · sinh(κ(T−t)) / sinh(κT)
```

where `κ = √(λ · σ² / η)` is the urgency coefficient, with:
- `λ` = risk aversion (USD-units of vol penalty)
- `σ²` = price volatility per unit time
- `η` = temporary impact coefficient

When `λ → 0` (risk-neutral): straight-line liquidation (TWAP).
When `λ → ∞` (extreme risk aversion): front-loaded — dump fast.

**This is the formal mother of all execution algos.** TWAP, VWAP, POV, IS
are all specializations or simplifications of this framework.

### 2.2 TWAP — Time-Weighted Average Price

Divide the total order size `Q` into `n` slices, place one slice every
`T/n` seconds. Each slice can be:

- A market order (fastest, most impact)
- A marketable limit (limit at touch + small buffer; almost-immediate fill)
- A passive limit slightly inside the spread (slowest, lowest impact but uncertain fill)

**When to use TWAP:**
- The host strategy has no urgency (slow signal).
- You have no reliable model of intraday volume.
- You need a transparent, auditable execution for compliance.

**When NOT:**
- Volume is highly U-shaped (you'll miss the deep-liquidity windows).
- Other algos can read your pattern and front-run (TWAP is the most predictable algo — predatory HFT firms specialize in detecting it).

**Anti-prediction trick (industry standard):** apply 10-20% jitter to the
size and timing of each slice so the pattern isn't perfectly periodic.
Adds ~1 bp of variance but removes the predator targeting.

### 2.3 VWAP — Volume-Weighted Average Price

Slice in proportion to *expected* market volume over the horizon. If you
expect 30% of the day's volume in the opening 30 minutes and 20% in the
last 30 minutes (the classic U-shape), execute 30% / 20% of your order
in those windows.

The benchmark is the day's realized VWAP:

```
VWAP_realized = Σ (price_trade × volume_trade) / Σ volume_trade
```

Execution quality = `|avg_fill_price − VWAP_realized| / VWAP_realized`.
A "good" VWAP execution beats benchmark by 1-3 bps; "excellent" by 5+ bps.

**Where the volume curve comes from:**
- US equities: extensively measured; SIP historical data → consistent U-curve with opening/closing humps.
- Crypto majors: similar U-curve, but per-pair and per-day-of-week shape varies. Build a 30-day rolling average to seed.
- Prediction markets: no stable volume curve; VWAP doesn't apply.

**2024 advance:** RBC's Aiden VWAP[^aiden2024] uses deep RL to *learn*
the volume curve in real time and adjust slice sizes when the day's
realized volume deviates from history. Reported 1-3 bp improvement vs.
fixed-curve VWAP.

### 2.4 POV — Participation (Percentage of Volume)

Instead of pre-planning slice sizes, *react* to the market: at each
interval, place an order sized as `α · market_volume_in_last_Δt`. Default
`α = 0.10` (10% of throughput).

**Pros:**
- Self-paces during quiet/busy periods automatically.
- Hides better than TWAP/VWAP because slice timing depends on the market, not a fixed schedule.

**Cons:**
- Order completion time is *not deterministic*. If the day is unexpectedly quiet, you may not finish.
- Vulnerable to *volume manipulation*: predators can flood the market with their own volume to make POV scale up its slices, fading them.

**Hard-cap variants:** "POV with max participation 15% AND max execution time 4h, finish-MOO if not done" — combines POV's adaptivity with TWAP's deterministic completion.

### 2.5 IS — Implementation Shortfall

The benchmark is the **arrival price**: the bid-ask mid at the time the
parent order entered the algo (= when the strategy "decided to trade").
The cost is the slippage between arrival mid and average fill price.

IS algorithms typically:

1. **Front-load opportunistically.** If the market is currently quiet and spreads are tight, execute aggressively now. If volatility spikes, slow down.
2. **Use limit orders inside the touch.** Pay no spread; settle for partial fills.
3. **Sweep when alpha decays.** If the host signal has a short half-life, the algo accelerates as the half-life elapses to avoid losing the alpha to the market.

The Kissell & Glantz framework[^kissell2003] formalizes IS into a
constrained optimization: minimize expected cost subject to a risk
constraint (max acceptable PnL standard deviation during execution).

**Key insight from Kissell-Glantz:** the *right* trading horizon is a
function of the strategy's signal half-life, not the trader's general
patience. A strategy with 30-second alpha half-life that takes 2 hours
to execute is leaving most of the alpha on the table; the IS optimizer
should aggress to finish in 1-5 minutes even if that pays 3× the
market impact.

### 2.6 Adaptive / alpha-aware

"Adaptive" is the catch-all for algos that mutate their behavior based
on real-time observations:

- **Alpha-aware IS** — speed up when price is moving with you, slow down when moving against. Implementation: track signed price-velocity over last 30s; if positive (buying and price rising), reduce participation by half.
- **Toxicity-gated** — pause when VPIN > threshold (see microstructure-signals.md §2.5). RBC Aiden and Citadel both use this.
- **Liquidity-seeking** — when an unusually large opposite-side resting order appears, send a chunk to capture before it's pulled.
- **Volatility-aware** — widen target tracking-error tolerance when realized vol jumps; tighten when calm.

Modern implementations are RL-based (PPO or DQN). The 2024 dual-level
RL approach (Wang et al.)[^wang2024] uses a Transformer to capture the
day-level U-shape and an LSTM for the intra-window order distribution;
reported significant VWAP-tracking improvement vs. fixed-schedule.

### 2.7 Iceberg / child-order splitting

Place a large limit order, but only *display* a small portion (the "tip
of the iceberg"). When the visible tip is filled, the exchange (native
iceberg) or your algo (synthetic iceberg) refreshes the displayed size.

**Why use it:**
- Reduces signal leakage: predators see a small limit order, not a $1M block.
- Captures fills at the chosen price level rather than walking the book.

**Tradeoff:**
- Visible portion = no queue-position advantage; bigger orders behind you in the same-price queue can be filled first.
- If iceberg detection algos (see microstructure-signals.md §2.7) catch your refresh pattern, predators front-run.

**Implementation note:** native icebergs are venue-supported on Coinbase,
Binance, Hyperliquid, dYdX (limited), and most equity venues. Synthetic
icebergs (your code does the refresh) work everywhere but are detectable
via timing patterns.

---

## 3. Where it works

| Asset class | Best execution algo | Notes |
|---|---|---|
| US equities | VWAP/IS for institutional flow; TWAP for retail compliance | Alpaca's order types support marketable limit + IOC; you implement the splitting client-side |
| Crypto spot (large, e.g. >$50k BTC) | IS for alpha-driven, POV for accumulation, iceberg on top | Coinbase/Binance support native icebergs; the cost-impact tradeoff is steeper than equities (thinner overall books) |
| Crypto spot (small, <$10k) | Market or marketable limit; no algo needed | Below the impact threshold |
| Crypto perps | IS for fast signals, POV for slow position-building | Funding cycles affect optimal timing — don't be holding inventory mid-execution at funding settlement |
| Polymarket binaries | IS only; volume too unpredictable for VWAP/POV | Iceberg is moot — books are thin enough that you'd hide your own bid from yourself |
| Equity options (Alpaca) | IS with tight per-contract slicing | Options spreads are wide; minimize crossing |

**Capital scale for "do I need an algo at all":**
- Below 0.01% × ADV: market order. Algo overhead exceeds savings.
- 0.01-0.5% × ADV: TWAP with 4-8 slices.
- 0.5-2% × ADV: VWAP or POV.
- 2-5% × ADV: IS with adaptive overlays.
- > 5% × ADV: bespoke algo + RFQ + dark venues (institutional only).

---

## 4. Edge magnitude

Measured as savings vs the naive baseline (market order at parent order
arrival).

| Algo | Asset / regime | Typical savings vs market | Source |
|---|---|---|---|
| TWAP (no jitter) | Equities, mid-cap | 2-5 bps | Industry baseline |
| TWAP + jitter | Equities | 4-7 bps | Industry baseline + anti-predator |
| VWAP (fixed curve) | Equities, S&P 500 names | 3-8 bps | CFA Institute Trade Strategy [^cfa2026] |
| VWAP (RL-tuned, Aiden) | Equities, European | +1-3 bp over fixed VWAP | RBC 2024 [^aiden2024] |
| POV (10%) | Crypto BTC/ETH | 5-12 bps vs market | Operator benchmarks |
| IS (default settings) | Equities, alpha-driven | 8-20 bps for high-urgency, 3-8 for low-urgency | Kissell & Glantz [^kissell2003] |
| Adaptive RL (PPO, dual-level) | Equities | 1-3 bp over IS | Wang et al. 2024 [^wang2024] |
| Iceberg | Anywhere with thick books | 2-5 bp via reduced impact | Bookmap research [^bookmap] |

**Honest cap:** savings beyond ~20 bps are rare for a single algo
choice. The biggest factor is *whether you used any algo at all* vs a
market order at 5% of ADV (which can cost 50-200 bps in impact).

---

## 5. What kills it

Ranked by frequency.

1. **Predictability → predatory front-run.** TWAP at fixed intervals is the textbook target. Modern HFT firms detect it within 2-3 slices and trade ahead. Always add 10-20% jitter and randomize start.
2. **Misaligned horizon vs signal half-life.** Executing slowly (POV 5%) when the strategy's alpha has 5-min half-life means the alpha is gone before the position is filled. Choose horizon ≤ signal half-life.
3. **VWAP curve drift.** Volume profile shifts due to event (earnings, macro print, holiday) and your fixed curve over-weights the wrong window. Mitigation: dynamic curve refresh; cap deviation from realized volume.
4. **POV ratio too high.** At 15%+ POV, you are most of the volume; your behavior becomes the market. Self-impact dominates. Stay below 10%.
5. **IS over-aggression.** "Just finish" mode in IS can pay 50-100 bps in impact during volatile windows. Cap aggression; pause-and-reassess gates required.
6. **Toxicity-blind execution.** Without VPIN gating, your algo grinds through a toxic regime (informed flow against you) paying full adverse selection. Wire microstructure-signals.md outputs in.
7. **Hidden-order detection on your icebergs.** If predator detects your iceberg refresh pattern, they pre-empt every slice. Mitigation: randomize refresh timing and display sizes; vary the price-tick offset.
8. **Cross-venue race conditions.** When the same instrument trades on multiple venues, your algo on Venue A is blind to Venue B's flow; arbitrageurs sync the two and pick you off. Mitigation: consolidated quote view (SIP in equities, aggregated WS feed in crypto).

---

## 6. Parameters

A single Execution module can serve all six algos via shared params + per-algo specialization.

### 6.1 Shared (all algos)

| Param | Units | Default | Range | Purpose |
|---|---|---|---|---|
| `total_qty` | base units | required | — | Size of parent order |
| `horizon_sec` | seconds | required | [1, 86400] | Target completion window |
| `max_participation_pct` | percent | 10 | [1, 30] | Cap on % of market volume per interval |
| `urgency` | enum | `medium` | `low / medium / high / critical` | Shorthand for risk-aversion preset |
| `jitter_pct` | percent | 15 | [0, 40] | Randomization of slice size/timing |
| `min_slice_qty` | base units | 0.001 BTC | venue-dependent | Don't go below venue's min order size |
| `child_order_type` | enum | `marketable_limit` | `market / marketable_limit / passive_limit / ioc / iceberg` | Default child-order kind |
| `tolerance_bps` | bps | 50 | [10, 500] | Acceptable slippage vs benchmark; alert if exceeded |
| `kill_drawdown_bps` | bps | 100 | [20, 500] | Halt algo if slippage exceeds; escalate to operator |

### 6.2 TWAP-specific

| Param | Default | Range | Purpose |
|---|---|---|---|
| `n_slices` | 10 | [2, 200] | Total child orders |

### 6.3 VWAP-specific

| Param | Default | Range | Purpose |
|---|---|---|---|
| `volume_curve_lookback_days` | 30 | [5, 365] | Days of history for the curve |
| `curve_refresh_intra_day` | true | bool | Reweight remaining slices using realized volume |
| `max_deviation_from_curve_pct` | 25 | [10, 100] | Cap on dynamic adjustment |

### 6.4 POV-specific

| Param | Default | Range | Purpose |
|---|---|---|---|
| `target_participation_pct` | 10 | [1, 30] | Your % of market volume |
| `volume_window_sec` | 60 | [10, 600] | Trailing window to compute market volume |
| `min_completion_pct_at_horizon` | 80 | [50, 100] | If at horizon you're below this, switch to TWAP/finish-MOO |

### 6.5 IS-specific

| Param | Default | Range | Purpose |
|---|---|---|---|
| `arrival_price` | required | — | Snapshot mid when algo started |
| `alpha_half_life_sec` | 600 | [10, 86400] | Strategy's signal half-life (drives urgency) |
| `risk_aversion_lambda` | 1.0 | [0.1, 10] | Almgren-Chriss `λ` |
| `impact_eta_bps_per_pct_adv` | 5 | [1, 20] | Temporary impact coefficient |

### 6.6 Adaptive-specific

| Param | Default | Range | Purpose |
|---|---|---|---|
| `accelerate_with_alpha` | true | bool | Speed up when price moves with you |
| `slowdown_factor_against` | 0.5 | [0.1, 1.0] | Multiplier when price moves against |
| `vpin_pause_threshold` | 0.6 | [0.4, 0.8] | Pause when toxicity exceeds |
| `liquidity_burst_chase` | true | bool | Send chunk when large opposite-side order appears |

### 6.7 Iceberg-specific

| Param | Default | Range | Purpose |
|---|---|---|---|
| `display_pct` | 10 | [1, 50] | Visible fraction of total qty |
| `refresh_jitter_ms` | 100 | [0, 500] | Randomize refresh timing to defeat detection |
| `display_size_jitter_pct` | 20 | [0, 50] | Randomize visible size |
| `min_refresh_qty` | venue.min_qty | — | Floor to prevent dust orders |

---

## 7. Fill model (backtesting)

### 7.1 Market / marketable limit children

Walk the book at fill time:

```
fill_avg_price = Σ (level_price × min(remaining_size, level_size))
                 / Σ min(remaining_size, level_size)
```

Apply a **latency penalty** = the price's expected move in your latency
window: `0.5 × σ × √(latency_ms / 1000)` (one-sided expected move).

### 7.2 Passive limit children

Use queue-aware fill model (see market-making-quote-driven.md §7.2). For
icebergs, your hidden portion is *behind* same-price visible orders in
queue priority.

### 7.3 Permanent impact (Almgren-Chriss)

Apply a per-trade permanent impact:

```
mid_price_after = mid_before + γ × (q_filled / V_avg)
```

where `γ` is the permanent impact coefficient (typically 2-10 bp per 1%
ADV traded; calibrate per asset).

### 7.4 Temporary impact

Used for slice-by-slice impact calc:

```
slip_bps = η × (slice_qty / volume_in_window)^β
```

where `η ≈ 5` (bp/percent-of-ADV) and `β ≈ 0.5` (square-root model — the
industry-standard Bouchaud calibration[^bouchaud2018]).

### 7.5 Adverse selection during execution

The Lehmann-style adverse-selection injection (see
market-making-quote-driven.md §7.3): with probability `p_adv = 0.30`
during execution, the mid moves against you by `markout_τ = 0.3 × spread`
over the next `τ = 30s`.

---

## 8. Backtest design

### 8.1 Data

| Algo | Data required |
|---|---|
| TWAP | Per-second top-of-book + trade tape |
| VWAP | Per-minute volume bars (5+ years for curve fit) + intraday tape for live runs |
| POV | Per-second trade tape (for current volume rate) |
| IS | Per-second top-of-book + trade tape + spread + ADV |
| Adaptive | All of the above + microstructure signals (microprice, OBI, VPIN) |
| Iceberg | Per-second L2 book snapshots + iceberg detector output |

### 8.2 Metrics

For each algo, evaluate vs the appropriate benchmark:

- **TWAP:** slippage vs day TWAP price (computed from market trades during execution window).
- **VWAP:** slippage vs day realized VWAP.
- **POV:** completion-rate within horizon; slippage vs interval-weighted average.
- **IS:** slippage vs *arrival mid*; this is the strict best-execution standard.
- **Adaptive / Iceberg:** same as IS, plus signal-leakage metric (mid drift in first 30s post-completion as % of order size).

Also track:
- **Variance of slippage** (not just mean) — predator-targeting shows as fat tails.
- **Completion rate at horizon** — POV's key weakness.
- **% of fills in passive vs aggressive child orders.**

### 8.3 Walk-forward

VWAP volume curves and IS impact coefficients drift; rerun fits monthly
on rolling 60-day window. Adaptive (RL) models need bigger windows
(months of data) and are best left to model-retrain pipelines outside
the per-strategy loop.

### 8.4 Look-ahead traps

- **Don't use the realized day-VWAP to plan a VWAP execution at 09:31.** Use only data available by 09:31.
- **POV uses *current* market volume** — backtest must aggregate trade tape strictly up to slice-decision time.
- **IS arrival price** must be the venue's mid at the *exact* moment the parent order entered, not a 1-sec lookahead average.

---

## 9. Code skeleton

### 9.1 Unified executor interface

```ts
// src/lib/exec/types.ts

export type ChildOrder = {
  orderId: string;
  ts: number;
  side: "BUY" | "SELL";
  qty: number;
  type: "market" | "marketable_limit" | "passive_limit" | "ioc" | "iceberg";
  limitPrice?: number;     // for limit kinds
  displayQty?: number;     // for iceberg
};

export type ExecutionState = {
  parentId: string;
  totalQty: number;
  filledQty: number;
  avgFillPrice: number;
  arrivalPrice: number;     // for IS
  arrivalTs: number;
  startedAt: number;
  status: "running" | "completed" | "halted" | "paused";
  children: ChildOrder[];
  benchmarkSlippageBps: number;  // current realized slippage vs benchmark
};

export type MarketTick = {
  ts: number;
  midPrice: number;
  bestBid: number;
  bestAsk: number;
  bidSize: number;
  askSize: number;
  trailingVolume: number;        // volume in last N seconds
};

export interface Executor {
  /** Produce the next child order(s) given current market state and execution state. */
  nextChildren(tick: MarketTick, state: ExecutionState): ChildOrder[];
  /** Update state after fills arrive. */
  onFill(fillQty: number, fillPrice: number, state: ExecutionState): ExecutionState;
  /** Should the execution pause/halt? */
  shouldHalt(tick: MarketTick, state: ExecutionState): { halt: boolean; reason?: string };
}
```

### 9.2 TWAP

```ts
// src/lib/exec/twap.ts
import type { Executor, MarketTick, ExecutionState, ChildOrder } from "./types";

export type TwapCfg = {
  totalQty: number;
  horizonSec: number;
  nSlices: number;
  jitterPct: number;
  childOrderType: "market" | "marketable_limit";
};

export function createTwap(cfg: TwapCfg): Executor {
  const sliceTargetSec = cfg.horizonSec / cfg.nSlices;
  return {
    nextChildren(tick, state) {
      const elapsed = (tick.ts - state.startedAt) / 1000;
      const expectedFilled = (cfg.totalQty * elapsed) / cfg.horizonSec;
      const behind = expectedFilled - state.filledQty;
      const sliceBase = cfg.totalQty / cfg.nSlices;
      // Jitter the slice size between 1±jitter
      const jit = 1 + (Math.random() * 2 - 1) * (cfg.jitterPct / 100);
      const sliceQty = Math.min(behind, sliceBase * jit);
      if (sliceQty < 0) return [];
      return [{
        orderId: `${state.parentId}-${state.children.length}`,
        ts: tick.ts,
        side: cfg.totalQty > 0 ? "BUY" : "SELL",
        qty: Math.abs(sliceQty),
        type: cfg.childOrderType,
        limitPrice: cfg.childOrderType === "marketable_limit"
          ? tick.bestAsk + 0.01 * tick.bestAsk * 0.0001  // 1 bp through touch
          : undefined,
      }];
    },
    onFill(qty, price, state) {
      const newFilled = state.filledQty + qty;
      const newAvg = state.filledQty === 0
        ? price
        : (state.avgFillPrice * state.filledQty + price * qty) / newFilled;
      return { ...state, filledQty: newFilled, avgFillPrice: newAvg };
    },
    shouldHalt(_tick, state) {
      if (state.benchmarkSlippageBps > 100) {  // kill switch
        return { halt: true, reason: "slippage > 100 bps" };
      }
      return { halt: false };
    },
  };
}
```

### 9.3 IS — Implementation Shortfall (Almgren-Chriss closed form)

```ts
// src/lib/exec/is.ts

export type IsCfg = {
  totalQty: number;
  horizonSec: number;
  arrivalPrice: number;
  alphaHalfLifeSec: number;
  riskAversionLambda: number;
  sigmaPerSec: number;       // price vol per second
  impactEtaBpsPerPctAdv: number;
};

/**
 * Almgren-Chriss optimal liquidation trajectory:
 *   x(t) = X * sinh(κ(T-t)) / sinh(κT)
 * where κ = sqrt(λ * σ² / η)
 */
export function isTargetRemainingQty(cfg: IsCfg, elapsedSec: number): number {
  const T = cfg.horizonSec;
  const t = elapsedSec;
  const kappa = Math.sqrt(
    (cfg.riskAversionLambda * cfg.sigmaPerSec * cfg.sigmaPerSec) /
    (cfg.impactEtaBpsPerPctAdv / 10_000),
  );
  if (t >= T) return 0;
  return cfg.totalQty * Math.sinh(kappa * (T - t)) / Math.sinh(kappa * T);
}

export function createIs(cfg: IsCfg, alphaAware = true): Executor {
  return {
    nextChildren(tick, state) {
      const elapsed = (tick.ts - state.startedAt) / 1000;
      const targetRemaining = isTargetRemainingQty(cfg, elapsed);
      const targetFilled = cfg.totalQty - targetRemaining;
      let behind = targetFilled - state.filledQty;

      // Alpha-aware: speed up if price moving with us
      if (alphaAware) {
        const movedBps = ((tick.midPrice - cfg.arrivalPrice) / cfg.arrivalPrice) * 10_000;
        const direction = cfg.totalQty > 0 ? +1 : -1;
        const movingWith = movedBps * direction > 0;
        if (movingWith) behind *= 1.5;
        else behind *= 0.5;
      }

      if (behind <= 0) return [];
      return [{
        orderId: `${state.parentId}-${state.children.length}`,
        ts: tick.ts,
        side: cfg.totalQty > 0 ? "BUY" : "SELL",
        qty: Math.abs(behind),
        type: "marketable_limit",
        limitPrice: cfg.totalQty > 0 ? tick.bestAsk : tick.bestBid,
      }];
    },
    onFill(qty, price, state) {
      const newFilled = state.filledQty + qty;
      const newAvg = state.filledQty === 0
        ? price
        : (state.avgFillPrice * state.filledQty + price * qty) / newFilled;
      const slipBps = ((newAvg - cfg.arrivalPrice) / cfg.arrivalPrice) * 10_000
        * (cfg.totalQty > 0 ? +1 : -1);
      return { ...state, filledQty: newFilled, avgFillPrice: newAvg, benchmarkSlippageBps: slipBps };
    },
    shouldHalt(tick, state) {
      if (state.benchmarkSlippageBps > 50) {
        return { halt: true, reason: "IS slippage > 50 bps" };
      }
      return { halt: false };
    },
  };
}
```

### 9.4 POV

```ts
// src/lib/exec/pov.ts

export type PovCfg = {
  totalQty: number;
  horizonSec: number;
  targetParticipationPct: number;
  minCompletionPctAtHorizon: number;
};

export function createPov(cfg: PovCfg): Executor {
  return {
    nextChildren(tick, state) {
      const elapsed = (tick.ts - state.startedAt) / 1000;
      const remaining = cfg.totalQty - state.filledQty;
      if (remaining <= 0) return [];

      // Switch to finish-mode if behind at end of horizon
      if (elapsed > cfg.horizonSec) {
        return [{
          orderId: `${state.parentId}-${state.children.length}`,
          ts: tick.ts,
          side: cfg.totalQty > 0 ? "BUY" : "SELL",
          qty: remaining,
          type: "market",
        }];
      }

      // Target slice = participation% × recent market volume
      const sliceQty = Math.min(
        remaining,
        tick.trailingVolume * (cfg.targetParticipationPct / 100),
      );
      if (sliceQty <= 0) return [];

      return [{
        orderId: `${state.parentId}-${state.children.length}`,
        ts: tick.ts,
        side: cfg.totalQty > 0 ? "BUY" : "SELL",
        qty: sliceQty,
        type: "marketable_limit",
        limitPrice: cfg.totalQty > 0 ? tick.bestAsk : tick.bestBid,
      }];
    },
    onFill(qty, price, state) {
      const newFilled = state.filledQty + qty;
      const newAvg = state.filledQty === 0
        ? price
        : (state.avgFillPrice * state.filledQty + price * qty) / newFilled;
      return { ...state, filledQty: newFilled, avgFillPrice: newAvg };
    },
    shouldHalt(_tick, state) {
      if (state.benchmarkSlippageBps > 80) {
        return { halt: true, reason: "POV slippage > 80 bps" };
      }
      return { halt: false };
    },
  };
}
```

### 9.5 Hook into the venue router

The executors above produce `ChildOrder`s; the actual exchange hits go
through the existing `ExecutionRouter` so the halt-gate / capsule-gate /
risk-gate still applies:

```ts
// src/lib/exec/engine.ts
import { Executor, MarketTick } from "./types";
import { ExecutionRouter } from "@/lib/venue/router";

export async function runExecution(
  parentId: string,
  executor: Executor,
  router: ExecutionRouter,
  tickStream: AsyncIterable<MarketTick>,
) {
  const state: ExecutionState = /* initialize */ {} as any;

  for await (const tick of tickStream) {
    const halt = executor.shouldHalt(tick, state);
    if (halt.halt) {
      console.warn(`[exec ${parentId}] halted: ${halt.reason}`);
      break;
    }
    const children = executor.nextChildren(tick, state);
    for (const c of children) {
      const result = await router.submit(c);  // routes through halt/capsule/risk gates
      if (result.kind === "filled" || result.kind === "partial") {
        Object.assign(state, executor.onFill(result.filledQty, result.filledPrice, state));
      }
    }
    if (state.filledQty >= state.totalQty) break;
  }
  return state;
}
```

---

## 10. Implementation path here

1. **Add `src/lib/exec/` directory** with `types.ts`, `twap.ts`, `is.ts`, `pov.ts`, `vwap.ts` (skipped above; same shape), `adaptive.ts`, `iceberg.ts`, `engine.ts`.
2. **Augment `src/lib/venue/router.ts`** to expose a `submit(childOrder)` interface that the executor calls. Use the existing halt/capsule/risk gates.
3. **VWAP curve loader.** `src/lib/exec/vwap-curve.ts` — pulls per-pair, per-day-of-week, per-time-of-day volume profile from the historical candle store. Add a script `scripts/build-vwap-curves.ts` to refresh nightly.
4. **Signal hook for Adaptive.** `adaptive.ts` consumes `SignalSnapshot` from microstructure-signals.md §9.6 (the aggregator). Pause on VPIN > threshold; chase on liquidity-burst signals.
5. **Wire into strategies.** Refactor the existing strategy adapters in `src/lib/strategies/` so that *all entry/exit orders* route through the executor instead of the venue adapter directly. Default to IS for size > threshold; market for tiny.
6. **Tests:**
   - `tests/unit/exec-twap.test.ts` — TWAP slice schedule with/without jitter, kill-switch fires on slippage.
   - `tests/unit/exec-is.test.ts` — Almgren-Chriss trajectory unit tests with known params; alpha-aware acceleration trigger.
   - `tests/unit/exec-pov.test.ts` — POV target vs trailing volume, finish-MOO behavior.
   - `tests/unit/exec-vwap.test.ts` — VWAP curve adherence, intra-day rebalancing.
   - `tests/integration/exec-flow.test.ts` — end-to-end: parent order → child orders → mock-fill round-trip.
7. **Backtest harness:** `scripts/backtest-exec.ts` evaluates each algo against TWAP/VWAP/arrival benchmarks across historical days; outputs `docs/exec-results.json` (gitignored).
8. **UI:** add a "Live executions" panel to `src/app/hft/page.tsx` showing parent orders in progress, completion %, slippage vs benchmark, child orders fired.

---

## 11. Asset-specific gotchas

### US equities (Alpaca)

- **VWAP curves are mature** — public SIP data, vendors like Bloomberg / FactSet publish them. For free, build from Alpaca historical 1-min bars.
- **Closing auctions matter.** Equity VWAP must account for the closing-cross volume (often 5-10% of day's volume in one moment). Reserve quantity for the close if your horizon ends at 16:00 ET.
- **Halts.** LULD halts can interrupt execution. Algo must pause + resume after halt clears; recompute remaining time and slice schedule.
- **Reg NMS routing** is handled by Alpaca's smart router for you; your algo just sends child orders.

### Crypto spot

- **No closing auction**, but funding-rate windows in adjacent perp markets cause spot volume spikes. Build the volume curve aware of UTC funding clock.
- **Pair-specific spread regimes.** USDC pairs typically tighter than USD pairs; calibrate VWAP execution per-pair.
- **Withdrawal events.** Big USDT mints/burns or large CEX withdrawals cause sudden volume — POV's auto-scaling handles, fixed-curve VWAP doesn't.

### Crypto perps

- **Funding settlement windows.** Avoid executing during the final 60-300s before funding settlement; books thin out and funding-rate uncertainty adds risk.
- **Liquidation cascades.** Mid-execution liquidation cascade can blow your IS slippage past kill-switch. The cascade-aware variant: when `realized_5min_vol > 3 × trailing_vol`, pause for 30s to reassess.
- **Leverage interaction.** If your strategy uses leverage, executing a 5% position with 10× leverage means 50% market exposure for the unfilled portion — kill-switch on completion-rate is essential.

### Polymarket binaries

- **No VWAP/POV** — volume too sparse and irregular.
- **IS only** with very small slice sizes (often 1 share = $0.50). Iceberg pointless; books are thinner than your hidden portion would be.
- **Resolution-clock-aware horizon** — for markets closing in <1h, the execution horizon must respect the resolution time, not a fixed default.

### Equity options (Alpaca)

- **Per-contract slicing** — the underlying instrument is the contract, not the share. Min size is 1 contract.
- **IV regime matters.** If implied vol is rising during execution (signal of news), pause and reassess rather than push through.
- **Quote-stuffing on multi-leg orders.** Building complex spreads (vertical, condor) one leg at a time exposes the strategy. Use combo orders where the venue supports them.

---

## 12. Open questions worth answering (research directions)

1. **Crypto-specific VWAP curve learning.** Is the BTC/USD intraday volume profile stable enough that a 30-day rolling curve outperforms naive TWAP by a meaningful margin? Replicate Wang et al. 2024 dual-level RL approach on crypto data.
2. **VPIN-gated IS on dYdX perps.** Test integration of microstructure-signals.md VPIN flag into the IS executor; measure slippage reduction during high-toxicity windows.
3. **Iceberg detection of own algo.** Run a synthetic iceberg through the iceberg detector (§7 of microstructure-signals.md); how detectable is your own algorithm? Tune `display_pct` and `refresh_jitter_ms` until your detector misses.
4. **Cross-venue smart routing.** For a single asset on multiple venues, can a single IS executor split children across venues optimally? Worth a backtest comparing single-venue IS vs cross-venue IS on BTC across Coinbase + Binance.
5. **Adaptive POV with alpha decay.** Combine POV's volume-following with IS's alpha-half-life decay: child order rate = `max(base_pov, decay_factor)` where decay accelerates as alpha half-life elapses.

---

## 13. References

[^ac2000]: Almgren, R., & Chriss, N. (2000). "Optimal Execution of Portfolio Transactions." *Journal of Risk* 3(2), 5-39. [smallake.kr PDF](https://www.smallake.kr/wp-content/uploads/2016/03/optliq.pdf). — The foundational paper; closed-form optimal liquidation trajectory.

[^kissell2003]: Kissell, R., Glantz, M., & Malamut, R. (2003-2004). Series of papers culminating in *The Science of Algorithmic Trading and Portfolio Management* (Kissell, 2014). [Book PDF excerpt](https://storage.sandtears.com/06_Book/The%20Science%20of%20Algorithmic%20Trading%20and%20Portfolio%20Management,%20Robert%20Kissell.pdf). — Practitioner framework for IS.

[^bouchaud2018]: Bouchaud, J.-P., Bonart, J., Donier, J., & Gould, M. (2018). *Trades, Quotes and Prices: Financial Markets Under the Microscope*. Cambridge University Press. — Empirical calibration of square-root impact law across asset classes.

[^aiden2024]: RBC Capital Markets. "Aiden VWAP: A New Era of AI Trading in Europe." 2024. [thetradenews.com](https://www.thetradenews.com/thought-leadership/rbcs-aiden-vwap-a-new-era-of-ai-trading-in-europe-leveraging-advanced-ai-and-deep-reinforcement-learning-to-achieve-optimised-execution/) · [RBC press](https://www.rbccm.com/en/insights/story.page?dcr=templatedata/article/story/data/2024/04/rbcs-aiden-vwap-a-new-era-of-ai-trading-in-europe).

[^wang2024]: Wang et al. "An Adaptive Dual-level Reinforcement Learning Approach for Optimal Trade Execution." arXiv:2307.10649 (2024 extended). [arxiv.org/abs/2307.10649](https://arxiv.org/abs/2307.10649). — Dual-level: Transformer for U-shape + LSTM for intra-window.

[^bookmap]: Bookmap. "Iceberg Orders Tracker." [bookmap.com/knowledgebase](https://bookmap.com/knowledgebase/docs/KB-Bookmap-Wiki-Iceberg-Orders-Tracker) — practitioner reference.

[^cfa2026]: CFA Institute. "Trade Strategy and Execution." Refresher reading 2026. [cfainstitute.org](https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/trade-strategy-execution).

**Other primary sources**
- Implementation Shortfall — Wikipedia. [en.wikipedia.org/wiki/Implementation_shortfall](https://en.wikipedia.org/wiki/Implementation_shortfall).
- Quantitative Brokers. "A Brief History of Implementation Shortfall." [quantitativebrokers.com/blog](https://www.quantitativebrokers.com/blog/a-brief-history-of-implementation-shortfall).
- "Implementation Shortfall – One Objective, Many Algorithms." Penn CIS reading. [cis.upenn.edu/~mkearns/finread/impshort.pdf](https://www.cis.upenn.edu/~mkearns/finread/impshort.pdf).
- QuestDB. "Optimal Execution Strategies — Almgren-Chriss Model." [questdb.com/glossary](https://questdb.com/glossary/optimal-execution-strategies-almgren-chriss-model/).

**Related modules in this repo**
- *(no exec modules yet — this doc seeds the implementation)*
- `src/lib/venue/router.ts` — the existing routing layer; executor calls `router.submit(childOrder)`.
- `src/lib/venue/ExecutionRouter` — halt → capsule → risk gates already applied.
- `src/lib/hft/edge.ts` — every parent order should pass edge.ts before being submitted to the executor (gate at strategy level, not exec level).
- `src/lib/strategies/*` — all of these would benefit from defaulting to IS executor for entry/exit at meaningful size.
- microstructure-signals.md §9.6 — `aggregator.ts` produces the `SignalSnapshot` the Adaptive executor consumes.
