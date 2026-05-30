/**
 * The research loop, third iteration.
 *
 * For each active strategy:
 *  1. Builds a candidate universe (sampling markets, sliced to RESEARCH_SAMPLE_SIZE).
 *  2. Fetches prices-history at 1m fidelity for each candidate token.
 *  3. Computes per-token signals (1d return, 1w return, realized vol, z-score
 *     vs rolling mean) — see src/lib/polymarket/signals.ts.
 *  4. Builds an AgentContext snapshot (capsules, risk limits, kill-switch
 *     state, recent rejects, recent evolution events, last backtest).
 *  5. Runs a strategy-specific evaluator with { strategy, current, signals, context }.
 *     Evaluators may return: null | propose-version | research-note | submit-order.
 *  6. For propose-version: writes the new strategy_version, then auto-runs the
 *     backtester against recent market_snapshots and stamps the score into
 *     backtest_summary + performance_metrics.
 *  7. For research-note: writes the note.
 *  8. For submit-order: dispatches through the unified router — but ONLY if
 *     the current version's stage is in {paper, live} AND order.capsuleId is
 *     set. Otherwise logs a skipped event.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { poly } from "../src/lib/polymarket/client.ts";
import { realizedVol, returnOver, summarize, zScoreVsRollingMean, type PricePoint, type Signal } from "../src/lib/polymarket/signals.ts";
import { insertEvolutionEvent, insertResearchNote, recordMarketSnapshot } from "../src/lib/db/queries.ts";
import { buildAgentContext, summarizeContext } from "../src/lib/agents/context.ts";
import { backtestProposedSpec } from "../src/lib/agents/backtest-loop.ts";
import { getDefaultRouter } from "../src/lib/venue/router.ts";
import type { Evaluator, EvaluatorArgs, EvaluatorVerdict, StrategyRow, StrategyVersionRow } from "../src/lib/agents/types.ts";

async function buildSignals(limit: number): Promise<Signal[]> {
  const sampling = await poly.samplingMarkets(limit);
  const signals: Signal[] = [];
  for (const m of sampling.data) {
    const yes = m.tokens?.find((t: any) => t.outcome === "Yes");
    const tokenId = yes?.token_id ?? m.tokens?.[0]?.token_id;
    if (!tokenId || !m.condition_id) continue;
    const [mid, spread, history] = await Promise.all([
      poly.midpoint(tokenId).catch(() => null),
      poly.spread(tokenId).catch(() => null),
      poly.pricesHistory(tokenId, "1w", 60).catch(() => null),
    ]);
    const series: PricePoint[] = (history?.history ?? []) as PricePoint[];
    const midpoint = mid ? Number((mid as any).mid) : 0;
    const spreadVal = spread ? Number((spread as any).spread) : 0;
    signals.push({
      tokenId,
      conditionId: m.condition_id,
      question: m.question ?? "(no question)",
      midpoint,
      spread: spreadVal,
      ret1d: returnOver(series, 86400),
      ret1w: returnOver(series, 7 * 86400),
      realizedVol: realizedVol(series),
      zScore: zScoreVsRollingMean(series),
      samples: series.length,
    });
    recordMarketSnapshot({
      condition_id: m.condition_id,
      token_id: tokenId,
      question: m.question ?? "(no question)",
      yes_price: yes?.price ?? null,
      no_price: m.tokens?.find((t: any) => t.outcome === "No")?.price ?? null,
      midpoint,
      spread: spreadVal,
      volume_24h: null,
      open_interest: null,
      liquidity_usd: null,
    });
  }
  return signals;
}

// ----------------------------------------------------------------------------
// Evaluators — each one takes the unified args object now, returns an
// EvaluatorVerdict. Same logic as before; just plumbed onto the new signature.
// ----------------------------------------------------------------------------

export const evaluators: Record<string, Evaluator> = {
  // Atlas Macro — fade-headline-spikes
  "fade-headline-spikes": ({ current, signals, context }: EvaluatorArgs) => {
    const moves = signals
      .map((s) => Math.abs(s.ret1d ?? 0) * 100)
      .filter((m) => Number.isFinite(m) && m > 0);
    if (moves.length < 6) return null;
    const stats = summarize("|ret1d|%", moves);
    const spec = JSON.parse(current.spec_json) as any;
    const currentThreshold = Number(spec.entry?.threshold_pts ?? 8);
    const targetThreshold = Math.max(2, Math.round(stats.p90));
    if (Math.abs(currentThreshold - targetThreshold) < 1) return null;
    // Signal-aware guard: if tracked conviction_traders are accumulating on
    // markets in this dataset, the "spikes" may be informed demand rather
    // than noise to fade. Skip the threshold drift in that case.
    const convictionAccumulators = context.recentTradeClassifications.filter((tc) =>
      tc.intent === "accumulation" &&
      context.recentTypologies.find((t) => t.wallet === tc.wallet)?.copyabilityClass === "potentially_copyable",
    );
    if (convictionAccumulators.length >= 3) {
      return {
        kind: "research-note",
        topic: `fade-headline-spikes: ${convictionAccumulators.length} conviction-trader accumulations active — holding threshold`,
        body: `Observed ${convictionAccumulators.length} accumulation-intent trades from potentially_copyable wallets in last 15min. Current threshold ${currentThreshold}pts wouldn't be auto-recalibrated to ${targetThreshold}pts because informed demand may be driving the moves rather than noise. Operator: review per-wallet activity in /tracked before manually adjusting.`,
        sourceUrls: [],
        confidence: 0.6,
        tags: ["fade-headline-spikes", "signal-deferred", "auto"],
      };
    }
    return {
      kind: "propose-version",
      rationale: `Across ${moves.length} sampled markets, p90 |1d return| is ${stats.p90.toFixed(2)} pts (mean ${stats.mean.toFixed(2)}). Current entry threshold is ${currentThreshold} pts — recalibrating to ${targetThreshold} so we fire on top-decile moves, not on noise.`,
      specPatch: { entry: { ...(spec.entry ?? {}), threshold_pts: targetThreshold } },
      backtestSummary: { observed: stats, prior_threshold: currentThreshold, proposed_threshold: targetThreshold },
    };
  },

  // Ember Momentum — breakout-rider
  "breakout-rider": ({ current, signals, context }: EvaluatorArgs) => {
    const vols = signals.map((s) => s.realizedVol).filter((v) => Number.isFinite(v) && v > 0);
    if (vols.length < 6) return null;
    const stats = summarize("realizedVol", vols);
    const spec = JSON.parse(current.spec_json) as any;
    const currentGate = Number(spec.entry?.vol_multiple_min ?? 2);
    let targetGate = Math.max(1.5, Math.min(4, +((2 + 4 * stats.mean).toFixed(2))));
    // Signal-aware adjustment: if there's an active orderbook-imbalance signal
    // aligned with momentum direction, tighten the gate slightly (microstructure
    // confirms the regime). Conversely if the consensus pipeline is firing
    // against momentum (multiple wallets fading the move), widen the gate.
    const obiActive = context.recentStrategyOpportunities.filter((o) => o.type === "orderbook-imbalance").length;
    const consensusActive = context.recentConsensusSignals.filter((c) => c.effectiveWallets >= 3).length;
    let signalNote = "";
    if (obiActive >= 2 && consensusActive === 0) {
      targetGate = +(targetGate * 0.9).toFixed(2);
      signalNote = ` Signal-adjustment: ${obiActive} orderbook-imbalance signals active and no contrarian consensus → tightened gate 10% to ride microstructure confirmation.`;
    } else if (consensusActive >= 2 && obiActive === 0) {
      targetGate = +(targetGate * 1.15).toFixed(2);
      signalNote = ` Signal-adjustment: ${consensusActive} cross-wallet consensus signals active without orderbook confirmation → widened gate 15% to avoid getting faded.`;
    }
    if (Math.abs(currentGate - targetGate) < 0.2) return null;
    return {
      kind: "propose-version",
      rationale: `Mean realized vol across ${vols.length} candidate markets is ${stats.mean.toFixed(4)} (p90 ${stats.p90.toFixed(4)}). Current vol_multiple_min is ${currentGate} — recalibrating to ${targetGate} so the breakout gate scales with current vol regime.${signalNote}`,
      specPatch: { entry: { ...(spec.entry ?? {}), vol_multiple_min: targetGate } },
      backtestSummary: { observed: stats, prior_gate: currentGate, proposed_gate: targetGate, signal_adjustment: signalNote || null },
    };
  },

  // Scribe Sports — stale-quote-arb (REST cadence can't see <3s windows)
  "stale-quote-arb": ({ current }: EvaluatorArgs) => {
    const spec = JSON.parse(current.spec_json) as any;
    if (spec.requires_websocket === true) return null;
    return {
      kind: "propose-version",
      rationale: `Empirical NBA-arb research shows median arbitrage window is 3.6 seconds — REST polling cannot see them. Marking the strategy as requires_websocket=true so the runner won't fire under REST-only conditions, eliminating false confidence.`,
      specPatch: { requires_websocket: true, exit: { ...(spec.exit ?? {}), max_age_ms: 1500 } },
      backtestSummary: { rationale_source: "arxiv:2605.00864", median_window_seconds: 3.6 },
    };
  },

  // ──────────────────────────────────────────────────────────────────────
  // Gen-2 evaluators — one per new strategy slug shipped with seed-gen2.
  // Each reads the signal arrays from AgentContext (no upstream signals
  // dependency) and emits research notes summarizing recent scanner output
  // for that strategy. They DO NOT propose spec versions in v1 — tuning
  // their thresholds is operator work after observing scanner cadence.
  // ──────────────────────────────────────────────────────────────────────

  // Nereid Scrape — near-resolution-scrape
  "near-resolution-scrape": ({ context }: EvaluatorArgs): EvaluatorVerdict => {
    const nrs = context.recentStrategyOpportunities.filter((o) => o.type === "near-resolution");
    if (nrs.length === 0) return null;
    const highYield = nrs.filter((o) => (o.annualizedEdge ?? 0) >= 0.5);
    const topByEdge = [...nrs].sort((a, b) => (b.annualizedEdge ?? 0) - (a.annualizedEdge ?? 0)).slice(0, 5);
    return {
      kind: "research-note",
      topic: `Nereid: ${nrs.length} NRS opportunities (last 30min), ${highYield.length} ≥50% APY`,
      body:
        `Near-resolution scanner activity summary.\n\n` +
        `- Total opportunities in window: ${nrs.length}\n` +
        `- High-yield (annualizedEdge ≥ 50%): ${highYield.length}\n` +
        `- Top 5 by annualized edge:\n` +
        topByEdge
          .map((o, i) => `  ${i + 1}. ${(o.marketTitle ?? o.marketKey).slice(0, 60)} — ${((o.annualizedEdge ?? 0) * 100).toFixed(0)}%apy, edge ${(o.edge * 100).toFixed(2)}pp, side=${o.side}`)
          .join("\n") +
        `\n\n**Action**: \`npm run worker:nrs-exec\` to auto-execute (sim by default). The Nereid Scrape strategy spec controls thresholds; tune via spec patches if cadence is too low/high.`,
      sourceUrls: [],
      confidence: 0.7,
      tags: ["nereid-scrape", "auto", "scanner-summary"],
    };
  },

  // Lyra Cross-Timeframe — cross-timeframe-spread-trade
  "cross-timeframe-spread-trade": ({ context }: EvaluatorArgs): EvaluatorVerdict => {
    const cts = context.recentStrategyOpportunities.filter((o) => o.type === "cross-timeframe-spread");
    if (cts.length === 0) return null;
    const topByEdge = [...cts].sort((a, b) => b.edge - a.edge).slice(0, 5);
    return {
      kind: "research-note",
      topic: `Lyra: ${cts.length} CTS spread signals (last 30min)`,
      body:
        `Cross-timeframe spread scanner activity.\n\n` +
        `- Total signals in window: ${cts.length}\n` +
        `- Top 5 by edge:\n` +
        topByEdge
          .map((o, i) => `  ${i + 1}. ${(o.marketTitle ?? o.marketKey).slice(0, 60)} — edge ${(o.edge * 100).toFixed(2)}pp, side=${o.side ?? "?"}\n     ${o.reason.slice(0, 100)}`)
          .join("\n") +
        `\n\n**Action**: Lyra has no auto-executor in v1 (signal decays faster than polling can react). Manual review via /opportunities; execute via venue router with tight time-stop.`,
      sourceUrls: [],
      confidence: 0.6,
      tags: ["lyra-cross-timeframe", "auto", "scanner-summary"],
    };
  },

  // Pulse Microstructure — orderbook-imbalance-watch (research-only by design)
  "orderbook-imbalance-watch": ({ context }: EvaluatorArgs): EvaluatorVerdict => {
    const obi = context.recentStrategyOpportunities.filter((o) => o.type === "orderbook-imbalance");
    if (obi.length === 0) return null;
    const buySide = obi.filter((o) => o.side === "BUY").length;
    const sellSide = obi.filter((o) => o.side === "SELL").length;
    return {
      kind: "research-note",
      topic: `Pulse: ${obi.length} OBI signals (last 30min, ${buySide} bid-heavy / ${sellSide} ask-heavy)`,
      body:
        `Orderbook imbalance scanner activity (RESEARCH-ONLY).\n\n` +
        `- Total signals: ${obi.length} (BUY ${buySide} / SELL ${sellSide})\n` +
        `- Top 5 by signal strength:\n` +
        [...obi].sort((a, b) => (b.signalStrength ?? 0) - (a.signalStrength ?? 0)).slice(0, 5)
          .map((o, i) => `  ${i + 1}. ${(o.marketTitle ?? o.marketKey).slice(0, 60)} — strength ${((o.signalStrength ?? 0) * 100).toFixed(0)}%, side=${o.side}\n     ${o.reason.slice(0, 80)}`)
          .join("\n") +
        `\n\n**Pulse is research-only by design.** Signal decays in seconds; polling-based execution cannot reliably capture. Other agents (Ember Momentum especially) consume these via AgentContext.recentStrategyOpportunities to adjust their own gates.`,
      sourceUrls: [],
      confidence: 0.5,
      tags: ["pulse-microstructure", "auto", "scanner-summary", "research-only"],
    };
  },

  // Hydra Consensus — consensus-tail-follow
  "consensus-tail-follow": ({ context }: EvaluatorArgs): EvaluatorVerdict => {
    const cs = context.recentConsensusSignals;
    if (cs.length === 0) return null;
    const strong = cs.filter((c) => c.effectiveWallets >= 3);
    const topByTrust = [...cs].sort((a, b) => b.combinedTrust - a.combinedTrust).slice(0, 5);
    return {
      kind: "research-note",
      topic: `Hydra: ${cs.length} consensus signals (last 1h), ${strong.length} ≥3 effective wallets`,
      body:
        `Cross-wallet consensus pipeline activity.\n\n` +
        `- Total signals in window: ${cs.length}\n` +
        `- Strong signals (≥3 effective wallets): ${strong.length}\n` +
        `- Top 5 by combined trust:\n` +
        topByTrust
          .map((c, i) => `  ${i + 1}. ${(c.marketTitle ?? c.marketKey).slice(0, 60)} — ${c.direction} @ ${c.avgPrice.toFixed(3)}, ${c.effectiveWallets} wallets, trust=${c.combinedTrust}, $${c.combinedUsd.toFixed(0)} combined`)
          .join("\n") +
        `\n\n**Action**: \`npm run worker:consensus-exec\` to auto-execute (sim by default; \`CONSENSUS_AUTO_EXEC_LIVE=1\` to arm). The Hydra strategy spec controls min_effective_wallets + min_combined_trust thresholds.`,
      sourceUrls: [],
      confidence: 0.75,
      tags: ["hydra-consensus", "auto", "scanner-summary"],
    };
  },

  // Oracle Research — heuristic deep-dive ranker (default).
  // The LLM-driven Oracle (oracle-llm.ts) is swapped in at startup when
  // ORACLE_LLM=1 and Anthropic auth is available.
  "weekly-deep-dives": ({ signals, context }: EvaluatorArgs): EvaluatorVerdict => {
    // Signal-aware reranking: |z-score| is the base rank, but we boost when a
    // market also appears in recent consensus signals or strategy opportunities.
    // Bonus values are small (max +0.5) so they tie-break without overwhelming
    // strong z-score signals.
    const consensusByMarket = new Map<string, number>();
    for (const c of context.recentConsensusSignals) {
      consensusByMarket.set(c.marketKey, Math.max(consensusByMarket.get(c.marketKey) ?? 0, c.effectiveWallets));
    }
    const oppByMarket = new Map<string, { type: string; edge: number; annualizedEdge?: number }>();
    for (const o of context.recentStrategyOpportunities) {
      const prev = oppByMarket.get(o.marketKey);
      if (!prev || o.edge > prev.edge) oppByMarket.set(o.marketKey, o);
    }
    const ranked = [...signals]
      .filter((sig) => Number.isFinite(sig.zScore))
      .map((sig) => {
        const baseScore = Math.abs(sig.zScore);
        const consensusBoost = Math.min(0.3, (consensusByMarket.get(sig.conditionId) ?? 0) * 0.1);
        const opp = oppByMarket.get(sig.conditionId);
        const oppBoost = opp ? Math.min(0.2, (opp.edge ?? 0) * 10) : 0;
        return { sig, baseScore, score: baseScore + consensusBoost + oppBoost, consensusBoost, oppBoost, opp };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    if (ranked.length === 0) return null;
    const tags = ["deep-dive", "candidates", "auto"];
    if (ranked.some((r) => r.consensusBoost > 0)) tags.push("consensus-boosted");
    if (ranked.some((r) => r.oppBoost > 0)) tags.push("opportunity-boosted");
    return {
      kind: "research-note",
      topic: `Deep-dive candidates ${new Date().toISOString().slice(0, 16)}`,
      body:
        `Top 5 markets by |z-score| (with cross-wallet-consensus + strategy-opportunity rerank) from this pass:\n\n` +
        ranked
          .map((r, i) => {
            const sig = r.sig;
            const boosts: string[] = [];
            if (r.consensusBoost > 0) boosts.push(`+${r.consensusBoost.toFixed(2)} consensus(${consensusByMarket.get(sig.conditionId)} wallets)`);
            if (r.oppBoost > 0 && r.opp) boosts.push(`+${r.oppBoost.toFixed(2)} ${r.opp.type}(edge=${(r.opp.edge * 100).toFixed(1)}%)`);
            const boostNote = boosts.length ? ` [boost: ${boosts.join(", ")}]` : "";
            return `${i + 1}. **${sig.question}** — score=${r.score.toFixed(2)}${boostNote}, z=${sig.zScore.toFixed(2)}, mid=${sig.midpoint.toFixed(3)}, spread=${sig.spread.toFixed(3)}, 1d=${(sig.ret1d ?? 0 * 100).toFixed(2)}%, 1w=${((sig.ret1w ?? 0) * 100).toFixed(2)}%\n   token=\`${sig.tokenId}\`\n   condition=\`${sig.conditionId}\``;
          })
          .join("\n\n") +
        `\n\nProcess: for each, write a fresh thesis covering priced_yes, model_yes, edge_bps, horizon_days, invalidation.`,
      sourceUrls: ["https://docs.polymarket.com/api-reference/markets/get-prices-history"],
      confidence: 0.5,
      tags,
    };
  },
};

async function maybeInstallLlmOracle(): Promise<void> {
  if (process.env.ORACLE_LLM !== "1") return;
  try {
    const mod = await import("../src/lib/agents/oracle-llm.ts");
    if (mod.oracleLlmAvailable()) {
      evaluators["weekly-deep-dives"] = mod.oracleLlmEvaluator;
      console.log("[research-loop] Oracle Research swapped to LLM-driven evaluator");
    } else {
      console.log("[research-loop] ORACLE_LLM=1 set but Anthropic auth unavailable — staying on heuristic");
    }
  } catch (err) {
    console.warn(`[research-loop] failed to load LLM Oracle: ${(err as Error).message}`);
  }
}

/**
 * Wire the blueprint trader agent into the dispatch. Gated on TRADER_LLM=1 so it
 * stays inert by default; it only ACTS when its strategy ("llm-trader") has an
 * active capsule, and every order still passes the router's halt→capsule→risk
 * gates. Mirrors maybeInstallLlmOracle's load-on-demand + auth-check pattern.
 */
async function maybeInstallLlmTrader(): Promise<void> {
  if (process.env.TRADER_LLM !== "1") return;
  try {
    const mod = await import("../src/lib/agents/trader-llm.ts");
    if (mod.traderLlmAvailable()) {
      evaluators["llm-trader"] = mod.traderLlmEvaluator;
      console.log("[research-loop] LLM Trader registered (strategy slug: llm-trader)");
    } else {
      console.log("[research-loop] TRADER_LLM=1 set but Anthropic auth unavailable — trader not registered");
    }
  } catch (err) {
    console.warn(`[research-loop] failed to load LLM Trader: ${(err as Error).message}`);
  }
}

function proposeVersion(strategyId: number, parent: StrategyVersionRow, patch: Record<string, unknown>, rationale: string, backtestSummary: Record<string, unknown>): { id: number; version: number; spec: Record<string, unknown> } {
  const handle = db();
  const nextVersion = (handle.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM strategy_versions WHERE strategy_id = ?").get(strategyId) as any).v as number;
  const merged = { ...JSON.parse(parent.spec_json), ...patch };
  const result = handle.prepare(
    `INSERT INTO strategy_versions
       (strategy_id, parent_version_id, version, spec_json, rationale, backtest_summary, introduced_by, is_current)
     VALUES (?, ?, ?, ?, ?, ?, 'research-loop', 0)`,
  ).run(
    strategyId,
    parent.id,
    nextVersion,
    JSON.stringify(merged),
    rationale,
    JSON.stringify(backtestSummary),
  );
  return { id: result.lastInsertRowid as number, version: nextVersion, spec: merged };
}

(async () => {
  console.log(`[research-loop] starting at ${new Date().toISOString()}`);
  await maybeInstallLlmOracle();
  await maybeInstallLlmTrader();
  const sampleSize = Number(process.env.RESEARCH_SAMPLE_SIZE ?? "12");
  const signals = await buildSignals(sampleSize);
  console.log(`[research-loop] computed signals for ${signals.length}/${sampleSize} markets`);

  if (signals.length > 0) {
    const vols = summarize("vol", signals.map((s) => s.realizedVol).filter((x) => x > 0));
    const spreads = summarize("spread", signals.map((s) => s.spread).filter((x) => x > 0));
    insertResearchNote({
      topic: `Cross-sectional sweep ${new Date().toISOString().slice(0, 16)}`,
      body: `Captured ${signals.length} sampling-markets. Spread (mean=${spreads.mean.toFixed(3)}, p90=${spreads.p90.toFixed(3)}). Realized vol (mean=${vols.mean.toFixed(4)}, p90=${vols.p90.toFixed(4)}). Strongest |z|=${Math.max(...signals.map((s) => Math.abs(s.zScore))).toFixed(2)}.`,
      source_urls_json: JSON.stringify(["https://clob.polymarket.com/sampling-markets", "https://clob.polymarket.com/prices-history"]),
      confidence: 0.6,
      tags_json: JSON.stringify(["sweep", "auto"]),
    });
  }

  const handle = db();
  const strategies = handle.prepare("SELECT * FROM strategies WHERE status = 'active'").all() as StrategyRow[];
  const signalsUniverse = signals.map((s) => ({ tokenId: s.tokenId, zScoreAbs: Math.abs(s.zScore) }));
  let proposals = 0;
  let notes = 0;
  let submits = 0;
  let submitsSkipped = 0;
  const router = getDefaultRouter();

  for (const s of strategies) {
    const cur = handle.prepare("SELECT * FROM strategy_versions WHERE strategy_id = ? AND is_current = 1").get(s.id) as StrategyVersionRow | undefined;
    if (!cur) continue;
    const evaluator = evaluators[s.slug];
    if (!evaluator) continue;

    const context = buildAgentContext(s.id);
    console.log(`[research-loop] ${s.slug} ${summarizeContext(context)}`);

    let verdict: EvaluatorVerdict;
    try {
      verdict = await evaluator({ strategy: s, current: cur, signals, context });
    } catch (err) {
      console.error(`[research-loop] evaluator ${s.slug} threw: ${(err as Error).message}`);
      continue;
    }
    if (verdict == null) continue;

    if (verdict.kind === "propose-version") {
      const newVer = proposeVersion(s.id, cur, verdict.specPatch, verdict.rationale, verdict.backtestSummary);
      insertEvolutionEvent({
        agent_id: s.agent_id,
        strategy_id: s.id,
        from_version_id: cur.id,
        to_version_id: newVer.id,
        event_type: "proposal",
        summary: `Proposed v${newVer.version} of "${s.name}"`,
        payload_json: JSON.stringify({ rationale: verdict.rationale, patch: verdict.specPatch, backtest: verdict.backtestSummary }),
      });
      proposals++;
      console.log(`[research-loop] proposed v${newVer.version} for ${s.name} (id=${s.id})`);

      // Auto-backtest the proposal so its score lands in backtest_summary + performance_metrics.
      const bt = backtestProposedSpec({
        versionId: newVer.id,
        strategyId: s.id,
        version: newVer.version,
        spec: newVer.spec,
        signalsUniverse,
      });
      if (bt.reason === "ok" && bt.result) {
        console.log(`[research-loop]   backtest: score=${bt.result.score.toFixed(1)} pnl=$${bt.result.pnlUsd.toFixed(2)} trades=${bt.result.tradesCount} (token=${bt.tokenIdUsed?.slice(0, 10)}..)`);
      } else {
        console.log(`[research-loop]   backtest: skipped (${bt.reason})`);
      }
      continue;
    }

    if (verdict.kind === "research-note") {
      insertResearchNote({
        agent_id: s.agent_id,
        strategy_id: s.id,
        topic: verdict.topic,
        body: verdict.body,
        source_urls_json: JSON.stringify(verdict.sourceUrls ?? []),
        confidence: verdict.confidence ?? 0.5,
        tags_json: JSON.stringify(verdict.tags ?? []),
      });
      notes++;
      console.log(`[research-loop] research-note from ${s.name}: ${verdict.topic}`);
      continue;
    }

    if (verdict.kind === "submit-order") {
      const stage = cur.stage ?? "sim";
      const stageAllowsTrade = stage === "paper" || stage === "live";
      if (!stageAllowsTrade) {
        submitsSkipped++;
        insertEvolutionEvent({
          agent_id: s.agent_id,
          strategy_id: s.id,
          to_version_id: cur.id,
          event_type: "submit-skipped",
          summary: `Skipped submit for ${s.name}: stage=${stage} (needs paper or live)`,
          payload_json: JSON.stringify({ stage, order: verdict.order, note: verdict.note }),
        });
        console.log(`[research-loop]   submit-order skipped (stage=${stage}) for ${s.name}`);
        continue;
      }
      if (!verdict.order.capsuleId) {
        submitsSkipped++;
        insertEvolutionEvent({
          agent_id: s.agent_id,
          strategy_id: s.id,
          to_version_id: cur.id,
          event_type: "submit-skipped",
          summary: `Skipped submit for ${s.name}: order missing capsuleId`,
          payload_json: JSON.stringify({ stage, order: verdict.order, note: verdict.note }),
        });
        console.log(`[research-loop]   submit-order skipped (no capsuleId) for ${s.name}`);
        continue;
      }
      const submitVerdict = await router.submit(verdict.order);
      submits++;
      insertEvolutionEvent({
        agent_id: s.agent_id,
        strategy_id: s.id,
        to_version_id: cur.id,
        event_type: submitVerdict.ok ? "submit-ok" : "submit-rejected",
        summary: `${s.name} → ${verdict.order.venue} ${verdict.order.side} ${verdict.order.symbol}: ${submitVerdict.ok ? ("status" in submitVerdict ? submitVerdict.status : "ok") : submitVerdict.code}`,
        payload_json: JSON.stringify({ stage, order: verdict.order, verdict: submitVerdict, note: verdict.note }),
      });
      console.log(`[research-loop]   submit-order ${submitVerdict.ok ? "OK" : `REJECTED (${submitVerdict.code})`} for ${s.name}`);
    }
  }
  console.log(`[research-loop] done — ${proposals} proposals, ${notes} notes, ${submits} submits (${submitsSkipped} skipped) across ${strategies.length} active strategies`);
})().catch((err) => {
  console.error("[research-loop] failed:", err);
  process.exit(1);
});
