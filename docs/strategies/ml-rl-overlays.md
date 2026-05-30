# ML / RL Overlays for Trading

> **Family:** 10 — ML/RL overlays (cross-cutting)
> **Variants covered:** RL parameter tuning (Alpha-AS, Aiden) · LSTM/Transformer microstructure prediction · DQN/PPO execution agents · contextual bandit venue routing · LLM trader-as-agent (this repo's `trader-llm.ts`) · ensemble allocator
> **Repo modules:** `src/lib/agents/trader-llm.ts`, `src/lib/agents/oracle-llm.ts`, `src/lib/arena/allocator.ts`, `research/sim-lab/` (Python reference loop)
> **Cross-asset coverage:** all asset classes — ML overlays wrap an underlying strategy from any other family

---

## 1. TL;DR

ML/RL doesn't *generate* alpha. It **tunes**, **routes**, **predicts**, or
**aggregates** the alpha that classical strategies produce. The fifteen
years of "ML for trading" academic literature mostly proves this: standalone
ML strategies underperform; ML wrappers around well-designed strategies
genuinely lift performance 10-50%.

Six places ML/RL meaningfully helps in this repo:

1. **RL-tuned parameters** for parametric strategies — `γ` in Avellaneda-Stoikov MM, `λ` in IS execution, etc. Alpha-AS-1/2 [^marin2022] shows +30-40% Sharpe lift over vanilla A-S on BTC-USD. RBC Aiden [^aiden2024] does the same for VWAP execution.
2. **LSTM/Transformer microstructure prediction** — short-horizon (1-30 second) directional prediction from order-book state. Lifts classical OBI/microprice signals by 15-30% IC.
3. **DQN/PPO execution agents** — replace deterministic schedules with learned agents that optimize per-tick action under live conditions. Wang et al. 2024 dual-level RL shows the strongest gains.
4. **Contextual bandits for venue routing** — choose which venue to send each order to based on observed fill rates, latency, slippage per (venue, asset, regime) bucket. Slow-and-steady; not glamorous; works.
5. **LLM trader-as-agent** — `src/lib/agents/trader-llm.ts` is exactly this. Claude evaluates capsule state + signals + market regime, emits ONE trade intent per tick. Per the repo's own measurement: a single LLM scalper is ~break-even; the ensemble is where edge emerges.
6. **Ensemble allocator** — `src/lib/arena/allocator.ts` routes capital across many strategies/agents based on arena fitness, capping concentration. The genuine system-level alpha source.

**The honest framing for this dossier:** ML overlays *amplify* the
edge from primitives documented in the other strategy docs. They don't
substitute for the primitives. A repo with no MM math + a DQN agent =
random PnL. A repo with A-S MM + a γ-tuning RL agent = measurable lift.

---

## 2. Mechanism

### 2.1 RL parameter tuning

**Setup:** the strategy has parameters (e.g. A-S `γ` for risk aversion).
The RL agent observes the market state, picks `γ` for the next decision
interval, the strategy operates with that `γ`, the RL agent gets PnL as
reward, learns over many episodes.

**Why it works:** classical strategies fix `γ` (or any other param)
based on a long-horizon average; live regimes vary much more. An agent
that picks `γ = 0.05` in low-vol regimes and `γ = 0.5` in high-vol
regimes outperforms a fixed `γ = 0.15` baseline simply by being
*regime-aware*.

**Algorithms used:**
- **DQN** (Deep Q-Network): pick from a discrete set of γ values; learn the Q-value of each per state. Simple, scalable.
- **PPO** (Proximal Policy Optimization): continuous γ output; more sample-efficient than DQN. The 2024 dual-level approach uses PPO.[^wang2024]
- **Genetic algorithms** for parameter sweeps: simpler than RL; works for offline tuning.

**The Alpha-AS variants (2022)**[^marin2022]: deep neural network tweaks γ and the spread output per state of (vol, OBI, inventory, time-to-close). Alpha-AS-2 reports +30-40% Sharpe over vanilla A-S on 30 days of BTC-USD.

**The cost:** RL agents need training data. For trading, that's
historical L2 + trade tape, typically months of it. Compute requirements:
single-GPU sufficient for small action spaces; multi-GPU for large.

### 2.2 LSTM / Transformer microstructure prediction

**Setup:** input is a sliding window of recent order-book features
(microprice, OBI, OFI, trade-flow, spread, depth at top 10 levels);
target is short-horizon price change (1s, 10s, 30s).

**Architectures:**
- **LSTM**: handles sequential book updates; baseline since 2018.
- **Transformer**: better for cross-asset/multi-feature; needs more data.
- **Tsetlin machines**: 2024 paper showed competitive results for microprice prediction with much lower compute cost.[^tsetlin2024]

**Output:** a per-bar prediction of directional move sign + magnitude
(usually probability distribution over discrete buckets).

**Typical performance** (well-tuned, single asset):
- 1-second horizon IC: 0.06-0.12 (vs ~0.04 for OBI alone).
- 30-second horizon IC: 0.03-0.06 (vs ~0.02 for OBI alone).

These IC lifts translate to ~20-30% Sharpe improvement on microstructure-
gated MM strategies, conditional on the prediction signal being
incorporated correctly.

**Decay:** LSTM models decay in alpha over months. Retraining cadence:
weekly on liquid markets, daily on illiquid where regime shifts faster.

### 2.3 DQN / PPO execution agents

**Setup:** state = (parent order remaining, time remaining, current
market microstructure); action = (child order size, type, price offset);
reward = negative slippage vs benchmark.

**Performance:** 2024 results show PPO outperforming DQN and A2C in
cumulative returns for equity backtests (62% vs 33% vs 45%) and
strongest Sharpe in market-making applications.[^bench2024]

**Practical caveat:** these results are *backtest* — live performance
typically 30-50% of backtest claims due to sim-to-real gap (slippage,
adverse selection, regime shifts the training data didn't cover).

### 2.4 Contextual bandits for venue routing

**Setup:** for each order, the bandit picks among N venues based on
the *context* (asset, size, time-of-day, regime). After observing fill
quality, it updates per-arm estimates.

**Algorithm:** Linear Upper Confidence Bound (LinUCB) for moderate-N
venues; Thompson Sampling for tail variance.

**Why use bandit instead of full RL:**
- Simpler; works with much less data.
- Online learning — adapts to new venues and venue policy changes within hours/days.
- Theoretical regret bounds: bandit asymptotically achieves the best fixed venue's performance, plus log-rate exploration cost.

**Where it lifts:** strategies with > 3 viable venues per asset. For
crypto MM split across Binance + Coinbase + Bybit: 5-15% slippage
reduction vs always-route-to-Binance default.

### 2.5 LLM trader-as-agent

**Setup:** the LLM (Claude, GPT-4, etc.) receives a capsule state +
signals + market regime + persona prompt; emits ONE trade intent per
decision tick (every minute / 5 min).

**This repo implements it:** `src/lib/agents/trader-llm.ts` — Claude
Haiku 4.5, OAuth-via-credentials-file, JSON-schema structured output.
Reads `prompts/llm-trader-persona.v1.md` for personality + rules.
NEVER touches a venue directly; the verdict flows through the
ExecutionRouter (halt → capsule → risk gates).

**Recent benchmarks** (2024-2025):
- **StockBench** [^stockbench2024]: most LLM agents underperform buy-and-hold; a few (Claude Sonnet 4, GPT-4.1) beat it in some regimes.
- **Agent Market Arena (AMA)** [^ama2024]: evaluates GPT-4o, GPT-4.1, Claude 3.5 Haiku, Claude Sonnet 4, Gemini 2.0 across multi-market scenarios. Results: mixed; agent architecture matters more than base model.
- **TradingAgents (UCLA/MIT)** [^tradingagents2024]: 7-role multi-agent system (Fundamental, Sentiment, News, Technical, Bull, Bear, Risk). Claims meaningful outperformance over single-agent baselines.

**The repo's honest assessment** (from `docs/blueprint/INTEGRATION.md`):

> "a single LLM-on-candles scalper is ~break-even (BTC +1.0%, ETH +0.82%
> on 5m) — which is precisely why the **allocator across many agents** is
> where the edge is, not any single hero agent."

This matches academic consensus. LLM agents are a *component*, not the
edge.

### 2.6 Ensemble allocator

**Setup:** N strategies/agents in the arena; each has a
risk-adjusted score; allocator decides who gets a capsule of capital
and how much.

**This repo implements it:** `src/lib/arena/allocator.ts`. Policy:

1. Eligibility — agent must be alive, have ≥ `minTrades`, and fitness ≥ `minFitness`.
2. Selection — top `maxCapsules` eligible agents by fitness.
3. Sizing — weight ∝ (fitness − minFitness); capped at `maxShare` of pool; remainder redistributed.

**Why this is where the edge lives:**

- Any single strategy has regime windows where it fails.
- Ensembled across regimes, the *average* strategy is positive even though no single one is consistently best.
- The allocator's concentration cap (`maxShare = 25%` default) means no single agent's blow-up kills the book.

**ML extensions to the basic allocator** (open research directions):

- **Bayesian mean-variance allocator** — instead of weight ∝ fitness, use Bayesian posterior over agent edge to size positions. Hard to converge in low-data regime.
- **Online learning** — update allocator weights on the same cycle as the arena tick.
- **Diversification penalty** — penalize correlated agent strategies in the allocation to force diversification.

---

## 3. Where it works

| Overlay variant | Best applied to | Verdict | Compute requirement |
|---|---|---|---|
| RL parameter tuning (γ in A-S) | MM on liquid CLOBs | ✅ proven | Single GPU, 1-10 days training |
| RL parameter tuning (IS λ) | Execution algos | ✅ proven | Same |
| LSTM/Transformer microstructure prediction | MM, OBI-driven taker bots | ✅ in liquid markets | Multi-GPU recommended |
| LSTM/Transformer features | Polymarket binary signals | ⚠️ data-sparse | Probably underperforms tuned classical |
| DQN/PPO execution agent | TWAP/VWAP/IS on equities, crypto | ⚠️ marginal beyond best classical | Multi-GPU; sim-to-real gap |
| Contextual bandit venue routing | Multi-venue strategies (crypto especially) | ✅ | CPU; minimal compute |
| LLM trader-as-agent | Meta-decision (regime, news reaction) | ⚠️ near-break-even alone | API cost; cents per decision |
| LLM trader-as-agent (in ensemble) | Same | ✅ in ensemble | Same |
| Ensemble allocator | Always | ✅ | CPU; trivial |
| Strategy factory (auto-sweep) | Building the ensemble candidate pool | ✅ in repo already | CPU; offline batch |

---

## 4. Edge magnitude

| Overlay | Lift over baseline | Source |
|---|---|---|
| Alpha-AS RL γ tuning | +30-40% Sharpe over vanilla A-S | Marin & Vera 2022 [^marin2022] |
| Aiden VWAP RL adjustment | +1-3 bp over fixed-curve VWAP | RBC 2024 [^aiden2024] |
| Wang 2024 PPO dual-level | Significant improvement over fixed-schedule (paper does not report a single number; framework-level improvement) | Wang et al. 2024 [^wang2024] |
| LSTM microstructure | +15-30% IC vs OBI alone | Industry replication; varies by asset |
| Tsetlin machine microprice | Competitive with much lower compute | Tsetlin 2024 [^tsetlin2024] |
| Contextual bandit venue routing | 5-15% slippage reduction | Operator data |
| LLM single agent (BTC 5m, candles only) | Near break-even | This repo's sim-lab measurement |
| LLM ensemble of 10+ diverse agents | Estimated 0.5-1.5 Sharpe units | Repo plan; not yet measured at scale |
| Ensemble allocator (rule-based weight ∝ fitness) | Removes worst-agent tail risk; ~50% drawdown reduction vs naive equal-weight | Standard portfolio-theory result |

**Honest caveat for ML overlays:** published numbers consistently
overstate live performance. Sim-to-real gaps eat 30-70% of backtest
edge. Use these magnitudes as upper bounds, not expectations.

---

## 5. What kills it

Ranked by frequency.

1. **Overfitting to backtest regime.** RL agents optimize against training data; live data doesn't match. Mitigation: walk-forward retraining; conservative position sizing; regime classifier as a kill-switch ("if current regime not in training set, fall back to classical baseline").
2. **Sim-to-real gap.** Backtest assumes you fill at observed prices; live adverse selection / partial fills / latency degrade performance by 30-70%. Mitigation: aggressive fill-model pessimism in training; gradual capital ramp from sim → paper → live.
3. **Data dredging in feature engineering.** Throwing 200 microstructure features at an LSTM produces statistically-spurious feature importance. Mitigation: Bonferroni-correct feature selection; insist on out-of-sample IC, not just train IC.
4. **Adversarial competitors.** Once your edge is in production, other ML systems detect your behavior and trade against it. Mitigation: rotate strategy families; mask actions with controlled jitter.
5. **Catastrophic forgetting.** Online-learning RL agents forget how to handle calm regimes after long runs of volatile data. Mitigation: experience replay with stratified sampling across regimes; periodic full retraining.
6. **LLM hallucination.** Claude/GPT confidently emits a trade rationale based on misremembered numbers. Mitigation: structured-output schema (JSON-validated); deterministic gate (the existing `ExecutionRouter` halt/capsule/risk gates *catch* hallucinated bad orders before they hit a venue).
7. **API rate limits and cost.** LLM agents called every minute at OpenAI/Anthropic API prices add up; per-API-call latency adds variance. Mitigation: cache the system prompt (this repo does this); batch decisions when possible; use Claude Haiku 4.5 (this repo's choice) over more expensive models.
8. **Allocator concentration risk.** Naive allocator concentrates on the *recent* winners → exposed to the recent-winners' impending mean-reversion. Mitigation: concentration cap (`maxShare = 25%`); diversification penalty across correlated agents.

---

## 6. Parameters

### 6.1 RL parameter tuning (Alpha-AS style)

| Param | Default | Range | Purpose |
|---|---|---|---|
| `state_features` | `[vol, obi, microprice_dev, inventory_norm, ttl_norm]` | extensible | Inputs to RL state |
| `action_space` | `[0.01, 0.05, 0.10, 0.20, 0.50]` (γ values) | discrete or continuous | What γ values the agent can pick |
| `reward` | Sharpe of next 60s PnL | configurable | What to optimize |
| `algorithm` | PPO | DQN/PPO/A2C | RL choice |
| `train_days` | 30 | [7, 365] | History window for training |
| `retrain_cadence_days` | 7 | [1, 90] | How often to refresh model |
| `walk_forward_test_days` | 7 | [1, 90] | Out-of-sample period |

### 6.2 LSTM microstructure prediction

| Param | Default | Range | Purpose |
|---|---|---|---|
| `lookback_bars` | 100 | [10, 1000] | Sequence length input |
| `hidden_dim` | 64 | [16, 256] | LSTM hidden size |
| `n_layers` | 2 | [1, 4] | Stacked LSTM |
| `horizon_seconds` | 10 | [1, 300] | Prediction horizon |
| `target_classes` | 5 (down-big/down/flat/up/up-big) | [3, 11] | Discretization buckets |
| `train_window_days` | 60 | [14, 365] | History |
| `retrain_cadence_days` | 7 | [1, 30] | Refresh |

### 6.3 Contextual bandit venue routing

| Param | Default | Range | Purpose |
|---|---|---|---|
| `algorithm` | LinUCB | LinUCB / Thompson / EpsilonGreedy | Bandit family |
| `context_features` | `[asset_idx, size_bucket, hour, vol_regime]` | extensible | Context vector |
| `exploration_alpha` | 0.5 | [0.1, 2.0] | LinUCB exploration coefficient |
| `reward_window_minutes` | 5 | [1, 60] | Window to compute fill-quality reward |
| `min_observations_before_exploit` | 50 | [10, 500] | Cold-start exploration |

### 6.4 LLM trader-as-agent (current repo defaults — `trader-llm.ts`)

| Param | Default | Notes |
|---|---|---|
| `model` | claude-haiku-4-5 | Repo choice for cost+latency |
| `persona_prompt_version` | v1 | `prompts/llm-trader-persona.v1.md` |
| `decision_cadence` | once per tick (~1-5 min) | Configurable per agent |
| `auth_mode` | OAuth via `~/.claude/.credentials.json` | Mirrors oracle-llm.ts |
| `output_schema` | JSON: `{action: "OPEN" | "HOLD", tokenId, side, size_usd, rationale}` | Schema-validated; bad outputs rejected |
| `max_size_per_decision_usd` | inherited from capsule | Hard upper bound from capsule envelope |
| `gate_chain` | halt → capsule → risk | Existing ExecutionRouter |

### 6.5 Ensemble allocator (current repo defaults — `allocator.ts`)

| Param | Default | Range | Purpose |
|---|---|---|---|
| `totalBudgetUsd` | 10_000 | [1_000, 10_000_000] | Pool to distribute |
| `maxCapsules` | 10 | [1, 100] | Max agents funded |
| `minFitness` | 0 | depends on score scale | Eligibility floor |
| `minTrades` | 1 | [1, 100] | Acts-at-all proof |
| `maxShare` | 0.25 | [0.05, 1.0] | Concentration cap |
| `correlation_penalty_weight` | 0 (not yet implemented) | [0, 1] | (Open research direction) |

---

## 7. Fill model (backtesting these overlays)

### 7.1 Reward function for RL training

Use *realistic* fill model in training reward computation. Common
errors:

- **Reward = market-price-fill** → agent learns to over-trade because every order fills perfectly.
- **Reward = mark-to-market PnL ignoring fees** → agent learns to churn.

Correct reward: net PnL after `fee_bps + slippage_bps + latency_penalty`,
using the same fill model the live system will face.

### 7.2 Sim-to-real gap injection

For ML overlay backtests, after training and standard backtest, **inject
a sim-to-real gap factor** = 0.5 (i.e. multiply all returns by 0.5).
This conservative estimate aligns with empirical observations from
RL-trading literature.

### 7.3 LLM agent simulation

For LLM-driven agents:

- Use the actual API (with cache) to make decisions at backtest time, OR
- Pre-compute decisions on a historical dataset, then replay.

The pre-compute approach is more reproducible but costs OpenAI/Anthropic
API tokens upfront.

### 7.4 Bandit regret bound

For backtesting venue routing bandits, report:

- Per-arm cumulative fill quality.
- Regret vs. omniscient best-arm choice.
- Cold-start performance (first 100 decisions).

---

## 8. Backtest design

### 8.1 Data

| Overlay | Data |
|---|---|
| RL param tuning | Full historical L2 + tape; same as the underlying strategy + state-action-reward triples |
| LSTM prediction | Same; need to engineer features |
| Bandit venue routing | Per-venue historical fill quality (avg slippage, fill rate, latency per asset/size) |
| LLM agent | Historical decision-points + outcomes; can pre-compute |
| Ensemble allocator | Per-strategy historical PnL, drawdown, trade count |

### 8.2 Metrics

For each overlay:

- **Out-of-sample performance** vs in-sample.
- **Stability** across train/test windows (does retraining produce wildly different agents?).
- **Sample efficiency** — how much data is needed to converge?
- **Compute cost** — train + inference per decision.

For the allocator:

- **Risk-adjusted return** vs equal-weighted baseline.
- **Drawdown reduction** vs single-best-strategy (the "we got lucky picking" baseline).
- **Concentration metric** — Herfindahl index of capsule allocations.

### 8.3 Walk-forward

Critical for ML. Standard setup:

- Train: 60-90 days history.
- Validate: 7 days, frozen agent.
- Test: 7 days, executed as backtest.
- Roll weekly.

The first time a backtest beats baseline only in train and not in test
= overfit. Don't trust it.

### 8.4 Look-ahead traps

- **Don't use post-trade outcome to compute the agent's input feature.** Common error in bandits — using actual fill quality to compute the context the agent saw.
- **Don't use future news to compute LLM agent's input.** LLM access to "current news" must be filtered to the timestamp of the decision.
- **Don't use full-history scaling.** Feature normalization must use only data available at decision time.

---

## 9. Code skeleton

### 9.1 Bandit venue router — `src/lib/venue/bandit-router.ts`

```ts
// Contextual bandit for venue selection. LinUCB algorithm.

export type RouteContext = {
  asset: string;
  sizeUsd: number;
  hourOfDay: number;
  volRegime: "low" | "medium" | "high";
};

export type VenueArm = {
  venue: string;
  // LinUCB per-arm parameters:
  A: number[][];   // d×d feature covariance + identity*alpha
  b: number[];     // d×1 weighted reward sum
  trials: number;
};

export type BanditCfg = {
  alpha: number;             // exploration coefficient
  featureDim: number;        // dimensionality of feature vector
  minTrialsBeforeExploit: number;
};

export function pickVenue(
  context: RouteContext,
  arms: VenueArm[],
  cfg: BanditCfg,
): { venue: string; predictedReward: number; uncertainty: number } {
  const x = contextToFeatures(context, cfg.featureDim);
  let best = { venue: arms[0].venue, ucb: -Infinity, mean: 0, variance: 0 };

  for (const arm of arms) {
    // theta_a = A^-1 * b
    const theta = linSolve(arm.A, arm.b);
    const mean = dot(theta, x);
    // variance = x^T * A^-1 * x
    const variance = dot(x, linSolve(arm.A, x));
    const ucb = mean + cfg.alpha * Math.sqrt(Math.max(0, variance));

    if (arm.trials < cfg.minTrialsBeforeExploit) {
      // Force exploration of under-tried arms
      return { venue: arm.venue, predictedReward: mean, uncertainty: Math.sqrt(variance) };
    }
    if (ucb > best.ucb) {
      best = { venue: arm.venue, ucb, mean, variance };
    }
  }
  return { venue: best.venue, predictedReward: best.mean, uncertainty: Math.sqrt(best.variance) };
}

export function updateArm(
  arm: VenueArm,
  context: RouteContext,
  realizedReward: number,
  cfg: BanditCfg,
): VenueArm {
  const x = contextToFeatures(context, cfg.featureDim);
  // A ← A + x * x^T
  const newA = matAdd(arm.A, outerProduct(x, x));
  // b ← b + reward * x
  const newB = arm.b.map((bi, i) => bi + realizedReward * x[i]);
  return { ...arm, A: newA, b: newB, trials: arm.trials + 1 };
}

// Utility implementations omitted (linSolve via Cholesky; matAdd; outerProduct; dot).

function contextToFeatures(ctx: RouteContext, dim: number): number[] {
  const f = [
    Math.log(ctx.sizeUsd + 1) / 10,
    ctx.hourOfDay / 24,
    ctx.volRegime === "low" ? 0 : ctx.volRegime === "medium" ? 0.5 : 1,
    1,  // intercept
  ];
  while (f.length < dim) f.push(0);
  return f.slice(0, dim);
}
function dot(a: number[], b: number[]): number { return a.reduce((s, ai, i) => s + ai * b[i], 0); }
function linSolve(A: number[][], b: number[]): number[] { /* impl */ return b; }
function matAdd(A: number[][], B: number[][]): number[][] { return A.map((r, i) => r.map((v, j) => v + B[i][j])); }
function outerProduct(a: number[], b: number[]): number[][] {
  return a.map(ai => b.map(bj => ai * bj));
}
```

### 9.2 Allocator extension — `src/lib/arena/allocator-bayesian.ts`

A Bayesian extension to the existing rule-based allocator. Per-agent
posterior over edge → weight by Sharpe-posterior.

```ts
import type { PaperAgentRow } from "./types";

export type AgentPosterior = {
  agentId: number;
  meanSharpe: number;     // posterior mean
  stdSharpe: number;      // posterior std
  posterior_n: number;    // observations behind posterior
};

export function bayesianAllocate(
  posteriors: AgentPosterior[],
  totalBudgetUsd: number,
  maxShare: number,
  riskAversion: number,    // higher → more cautious sizing
): Array<{ agentId: number; grantUsd: number; weight: number; reason: string }> {
  // Weight ∝ max(0, meanSharpe - riskAversion * stdSharpe)
  // Then cap and renormalize.
  const rawWeights = posteriors.map(p => ({
    agentId: p.agentId,
    weight: Math.max(0, p.meanSharpe - riskAversion * p.stdSharpe),
    p,
  }));
  const totalWeight = rawWeights.reduce((s, w) => s + w.weight, 0);
  if (totalWeight === 0) return [];
  return rawWeights.map(({ agentId, weight, p }) => {
    const share = Math.min(maxShare, weight / totalWeight);
    return {
      agentId,
      grantUsd: share * totalBudgetUsd,
      weight: share,
      reason: `Bayes posterior Sharpe ${p.meanSharpe.toFixed(2)}±${p.stdSharpe.toFixed(2)} (n=${p.posterior_n}); share ${(share*100).toFixed(1)}%`,
    };
  });
}
```

### 9.3 RL parameter tuner — `src/lib/strategies/ml/rl-param-tuner.ts` (Python sidecar)

The full PPO/DQN training loop typically lives in Python (PyTorch /
stable-baselines3). TypeScript can host the *inference* (a frozen
policy network) but training stays in Python.

Suggested architecture:

```
research/sim-lab/ml-trainer/
  train_ppo_param_tuner.py      # PPO on a Gym-style strategy env
  export_to_onnx.py             # freeze policy
src/lib/strategies/ml/
  rl-param-tuner.ts             # loads ONNX model, runs inference
```

The Python sim-lab in `research/sim-lab/` is already set up for this
pattern.

---

## 10. Implementation path here

The repo already has substantial agentic infrastructure. The
implementation roadmap focuses on filling gaps:

1. **Wire `trader-llm.ts` into the research-loop dispatch.** Currently inert — adding it to the dispatch enables LLM-driven trade intents through ExecutionRouter (the gate chain is already in place).
2. **Add the bandit venue router** per §9.1 — wraps existing `src/lib/venue/router.ts`. Each `router.submit()` call goes through `pickVenue(context, arms)`. Existing routing logic becomes one of the arms.
3. **Bayesian allocator extension** per §9.2 — alternative `allocate()` function in `src/lib/arena/allocator.ts` that the operator can toggle via env var.
4. **RL param tuner (Python)** — set up `research/sim-lab/ml-trainer/` with PPO on the Avellaneda-Stoikov γ-tuning environment. Export ONNX → TypeScript inference module.
5. **LSTM microstructure predictor (Python)** — same pattern. Targets: 10s and 30s directional move from OBI/microprice/OFI/spread features. Train on dYdX/Coinbase BTC L2.
6. **Ensemble metrics** — extend `src/lib/arena/score.ts` to compute per-agent correlation matrix; surface as a diversification metric the allocator can read.
7. **A/B testing harness** for ML overlays. `scripts/ab-test-overlay.ts` runs paired backtests: classical baseline vs ML-augmented; produces statistical-significance report.
8. **Tests:**
   - `tests/unit/bandit-router.test.ts` — LinUCB convergence on synthetic arm-quality, exploration phase, exploitation phase.
   - `tests/unit/allocator-bayesian.test.ts` — share-cap respected, posterior weighting math.
   - `tests/integration/llm-trader-flow.test.ts` — mock Claude API → intent → execution-router → fills (mock venue).
9. **UI surface:** extend `/hft` dashboard with:
   - Allocator state (per-agent shares, decisions).
   - Bandit per-venue posterior estimates.
   - LLM agent recent decisions + rationales (for operator review).
10. **Model registry.** `data/ml-models.db` tracks model versions, training data window, OOS Sharpe. Operator promotion from sim → paper → live requires model version registered + OOS performance certified.

---

## 11. Asset-class gotchas

### Equities

- **Data licensing**. Many ML papers train on data sources retail can't access (SIP feeds, NYSE TAQ at second-resolution). Replicating their results on free Alpaca data is harder.
- **Survivorship bias in historical universes**. Most equity ML papers use the current S&P 500 as their universe; they implicitly assume all those names existed throughout history. Live trading universe selection must be done per-window.

### Crypto

- **Listings & delistings**. Coins come and go monthly; ML models trained on a fixed universe become stale. Bandit venue router naturally handles this (new venues = new arms).
- **Regime changes faster than equities**. Crypto goes from 30% annual vol to 100% in a month. Models must retrain more frequently.
- **24/7 markets**. Standard "trading day" assumptions break; convert all time-of-day features to UTC, not local.

### Polymarket binaries

- **Sparse data per market**. Many markets resolve within hours of opening; no long history per market. ML for individual market behavior is data-limited.
- **Cross-market features can help**: pool BTC up/down markets across many expiries; treat as a feature collection rather than per-market modeling.

### Options

- **IV surface as feature input**. The IV surface itself is a tensor (strike × expiry × asset). ML models that ingest this directly can spot structural opportunities classical models miss.

---

## 12. Open questions worth answering (research directions)

1. **Multi-agent benchmark of this repo's setup.** Run the AMA / StockBench benchmark with `trader-llm.ts` as one of the agents; how does Claude Haiku 4.5 with this repo's persona compare?
2. **PPO vs LSTM-pred-then-rule.** Apply the Wang dual-level RL approach to a strategy in this repo (probably MM); measure lift vs the current rule-based system.
3. **Bayesian allocator with correlation penalty.** Implement the `correlation_penalty_weight` parameter currently set to 0; measure portfolio Sharpe lift over the current rule-based.
4. **LLM ensemble.** Run 10 LLM agents with different persona prompts simultaneously; measure ensemble Sharpe vs single-agent baseline. Does diversity of prompts produce diversity of bets?
5. **Bandit transfer.** Train a venue-routing bandit on BTC/USD; transfer to ETH/USD; measure cold-start performance vs starting from scratch. If transfer works, you can spin up new asset trading quickly.
6. **Tsetlin machine for microprice on Polymarket.** Tsetlin Machines need much less compute than LSTMs; could they make Polymarket-binary-microprice ML practical at retail compute scale?

---

## 13. References

[^marin2022]: Marin, J., & Vera, M. (2022). "A reinforcement learning approach to improve the performance of the Avellaneda-Stoikov market-making algorithm." *PLOS ONE* 17(12), e0277042. [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC9767337/). — Alpha-AS-1 and Alpha-AS-2.

[^aiden2024]: RBC Capital Markets. "Aiden VWAP: A New Era of AI Trading in Europe." 2024. [thetradenews.com](https://www.thetradenews.com/thought-leadership/rbcs-aiden-vwap-a-new-era-of-ai-trading-in-europe-leveraging-advanced-ai-and-deep-reinforcement-learning-to-achieve-optimised-execution/).

[^wang2024]: "An Adaptive Dual-level Reinforcement Learning Approach for Optimal Trade Execution." arXiv:2307.10649 (2024 extended). [arxiv.org/abs/2307.10649](https://arxiv.org/abs/2307.10649). Transformer-for-U-shape + LSTM-for-intra-window.

[^tsetlin2024]: "High Resolution Microprice Estimates from Limit Orderbook Data using Hyperdimensional Vector Tsetlin Machines." arXiv:2411.13594. [arxiv.org/abs/2411.13594](https://arxiv.org/abs/2411.13594).

[^bench2024]: "A Comparative Study of Deep Reinforcement Learning Models: DQN vs PPO vs A2C." KDD 2024 UC. [kdd2024.kdd.org PDF](https://kdd2024.kdd.org/wp-content/uploads/2024/08/18-KDD-UC-de-la-Fuente.pdf). — PPO 62%, A2C 45%, DQN 33% cumulative returns benchmark.

[^stockbench2024]: "StockBench: Can LLM Agents Trade Stocks Profitably In Real-world Markets?" arXiv:2510.02209. [arxiv.org/abs/2510.02209](https://arxiv.org/abs/2510.02209).

[^ama2024]: "When Agents Trade: Live Multi-Market Trading Benchmark for LLM Agents." arXiv:2510.11695. [arxiv.org/abs/2510.11695](https://arxiv.org/abs/2510.11695).

[^tradingagents2024]: TradingAgents — UCLA/MIT multi-agent system. [GitHub mirror](https://github.com/rev-hologaun/TradingAgents/tree/main) · paper at [arxiv.org/abs/2412.20138](https://arxiv.org/pdf/2412.20138).

**Other primary sources**
- "Deep Reinforcement Learning for Market Making Under a Hawkes Process-Based Limit Order Book Model." [arxiv.org/abs/2207.09951](https://arxiv.org/pdf/2207.09951).
- "Deep reinforcement learning applied to statistical arbitrage investment strategy on cryptomarket." [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S1568494624000292).
- "A Self-Rewarding Mechanism in Deep Reinforcement Learning for Trading Strategy Optimization." MDPI 2024. [mdpi.com](https://www.mdpi.com/2227-7390/12/24/4020).
- "AI-Trader: Benchmarking Autonomous Agents in Real-Time Financial Markets." arXiv:2512.10971. [arxiv.org/abs/2512.10971](https://arxiv.org/pdf/2512.10971).
- "Multi-Agents LLM Financial Trading Framework." arXiv:2412.20138. [arxiv.org](https://arxiv.org/pdf/2412.20138).

**Related modules in this repo**
- `src/lib/agents/trader-llm.ts` — Claude-driven LLM trader (live in repo).
- `src/lib/agents/oracle-llm.ts` — LLM research agent (live).
- `src/lib/arena/allocator.ts` — rule-based capital allocator (live).
- `scripts/strategy-factory.ts` — parameter-grid factory (live).
- `research/sim-lab/` — Python sim-lab + multi-window promotion verdict (live; provides the data pipeline for ML training).
- `src/lib/venue/router.ts` — the dispatch layer the bandit venue router would extend.
- `docs/blueprint/BLUEPRINT.md`, `docs/blueprint/INTEGRATION.md` — full context for the agentic layer.
- All other strategy docs in this folder — these are the *primitives* the ML overlays tune/route/select among.
