/**
 * _loop-design-bench — which AGENT-LOOP DESIGN best decides "which strategy to deploy next", using the SMALL
 * model (claude-haiku-4-5 via the Claude Code OAuth key)? We generate a balanced set of market regimes with a
 * KNOWN ground-truth best strategy (clean signals), hand each loop the NOISY observed features, and score
 * accuracy + APR regret against two non-LLM controls (deterministic model argmax, naive biggest-signal) and a
 * random floor. The §7.6 discipline: an LLM loop only earns its place if it beats the deterministic baseline.
 *
 *   npm run bench:loops [-- --n 12]
 *
 * Loop designs: single · cot (chain-of-thought) · ensemble (k=5 self-consistency vote) · debate (2 advocates +
 * judge) · reflexion (propose → self-critique → revise). Plus controls: deterministic · naive · random.
 */
import "./_env.ts";
import { getOAuthClient, authIsAvailable } from "../src/lib/anthropic/auth.ts";
import { STRATEGIES, type Strategy, type MarketFeatures, groundTruthBest, strategyNetReturns, deterministicSelect, naiveSelect, majorityVote, scoreRun } from "../src/lib/exec/strategy-selector.ts";

const MODEL = "claude-haiku-4-5";
const N = (() => { const i = process.argv.indexOf("--n"); return i >= 0 ? Number(process.argv[i + 1]) : 12; })();

// ---- deterministic seeded regime generator (clean ground-truth + noisy observed) ----
function lcg(seed: number): () => number { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 0xffffffff; }; }
type Regime = { clean: MarketFeatures; observed: MarketFeatures; truth: Strategy; netClean: Record<Strategy, number> };
const TYPES = ["clear-funding", "clear-calendar", "clear-vrp", "clear-staking", "thin", "trap-nohedge", "trap-tail"] as const;
function makeRegimes(n: number, seed = 7): Regime[] {
  const r = lcg(seed), out: Regime[] = [];
  for (let i = 0; i < n; i++) {
    const type = TYPES[i % TYPES.length];
    const base: MarketFeatures = { fundingApr: 5 + r() * 6, fundingPersistence: 0.6 + r() * 0.35, hedgeAvailable: true, basisAnnApr: 2 + r() * 3, ivMinusRv: 1 + r() * 4, stakeApy: 2 + r() * 3, tailRisk: r() * 0.3, riskFreeApr: 4.5 };
    const clean = { ...base };
    if (type === "clear-funding") { clean.fundingApr = 28 + r() * 15; clean.fundingPersistence = 0.9; clean.hedgeAvailable = true; clean.tailRisk = 0.1; }
    if (type === "clear-calendar") { clean.basisAnnApr = 18 + r() * 12; clean.tailRisk = 0.15; }
    if (type === "clear-vrp") { clean.ivMinusRv = 22 + r() * 14; clean.tailRisk = 0.1; }
    if (type === "clear-staking") { clean.stakeApy = 14 + r() * 8; clean.fundingApr = 8 + r() * 4; clean.tailRisk = 0.15; }
    if (type === "thin") { clean.fundingApr = 5 + r() * 2; clean.basisAnnApr = 2 + r() * 1.5; clean.ivMinusRv = 1 + r() * 2; clean.stakeApy = 2 + r() * 2; }
    if (type === "trap-nohedge") { clean.fundingApr = 30 + r() * 15; clean.hedgeAvailable = false; clean.basisAnnApr = 3 + r() * 2; }
    if (type === "trap-tail") { clean.ivMinusRv = 22 + r() * 12; clean.tailRisk = 0.85 + r() * 0.15; clean.basisAnnApr = 2 + r() * 2; }
    // observed = clean + noise on the continuous signals (hedgeAvailable is a hard known fact, not noised)
    const noise = (x: number, rel: number) => x * (1 + (r() - 0.5) * 2 * rel);
    const observed: MarketFeatures = { ...clean, fundingApr: noise(clean.fundingApr, 0.18), fundingPersistence: Math.min(1, Math.max(0.5, noise(clean.fundingPersistence, 0.08))), basisAnnApr: noise(clean.basisAnnApr, 0.18), ivMinusRv: noise(clean.ivMinusRv, 0.2), stakeApy: noise(clean.stakeApy, 0.12), tailRisk: Math.min(1, Math.max(0, noise(clean.tailRisk, 0.2))) };
    out.push({ clean, observed, truth: groundTruthBest(clean), netClean: strategyNetReturns(clean) });
  }
  return out;
}

// ---- the small-model call ----
const SYSTEM = `You are a quantitative capital allocator. Choose EXACTLY ONE strategy to deploy given the market regime.
Strategies and their economics:
- funding_carry: short the perp + long spot, collect funding. ONLY works if hedgeAvailable=true (else undeployable). Nets ~|fundingApr|−3% fee, ×persistence, hurt by tailRisk.
- calendar_basis: cash-and-carry, short dated future + long spot. Nets ~basisAnnApr−1.5% fee. Convergence locked, lighter tail.
- vol_risk_premium: sell vol, harvest ~60% of ivMinusRv. SEVERELY punished when tailRisk is high (sell-vol left tail).
- staking_hedged: stake + short perp. Nets ~stakeApy + a little funding − costs. Less tail-sensitive.
- sit_out: deploy nothing, earn riskFreeApr. NEVER deploy a strategy whose net is below the risk-free floor.
Judge by NET expected APR after fees/constraints, not the biggest raw number. Respect hedgeAvailable and tailRisk.`;
const SCHEMA = { type: "object", additionalProperties: false, properties: { strategy: { type: "string", enum: [...STRATEGIES] }, reasoning: { type: "string" } }, required: ["strategy", "reasoning"] };
let CALLS = 0;
async function ask(user: string, sys = SYSTEM): Promise<{ strategy: Strategy; reasoning: string }> {
  CALLS++;
  const c = await getOAuthClient();
  const resp = await c.messages.create({ model: MODEL, max_tokens: 512, system: [{ type: "text", text: sys }], messages: [{ role: "user", content: user }], output_config: { format: { type: "json_schema", schema: SCHEMA } as any } } as any);
  const text = (resp.content as Array<{ type: string; text?: string }>).find((b) => b.type === "text")?.text ?? "{}";
  const m = text.match(/\{[\s\S]*\}/); const o = m ? JSON.parse(m[0]) : {};
  const strategy = (STRATEGIES as readonly string[]).includes(o.strategy) ? o.strategy as Strategy : "sit_out";
  return { strategy, reasoning: o.reasoning ?? "" };
}
const feat = (f: MarketFeatures) => `Regime features (JSON):\n${JSON.stringify(f, null, 1)}\nPick the single best strategy to deploy.`;

// ---- loop designs ----
async function single(f: MarketFeatures): Promise<Strategy> { return (await ask(feat(f))).strategy; }
async function cot(f: MarketFeatures): Promise<Strategy> { return (await ask(`${feat(f)}\nThink step by step: ESTIMATE each strategy's net APR (apply fees, hedge availability, tail-risk haircut, and the risk-free floor), then choose the argmax. Put the estimates in your reasoning.`)).strategy; }
async function ensemble(f: MarketFeatures, k = 5): Promise<Strategy> { const picks = await Promise.all(Array.from({ length: k }, () => single(f))); return majorityVote(picks); }
async function debate(f: MarketFeatures): Promise<Strategy> {
  const [a, b] = await Promise.all([
    ask(`${feat(f)}\nYou are the AGGRESSIVE allocator: argue for the highest-yield deployable strategy.`),
    ask(`${feat(f)}\nYou are the RISK-OFF allocator: argue for the safest choice, defaulting to sit_out unless a strategy clearly beats risk-free after ALL frictions.`),
  ]);
  return (await ask(`${feat(f)}\nTwo analysts disagree.\nAGGRESSIVE picked ${a.strategy}: ${a.reasoning}\nRISK-OFF picked ${b.strategy}: ${b.reasoning}\nAs the JUDGE, decide the correct single strategy by net expected APR.`)).strategy;
}
async function reflexion(f: MarketFeatures): Promise<Strategy> {
  const p0 = await ask(feat(f));
  const crit = await ask(`${feat(f)}\nA proposed pick is ${p0.strategy} because: ${p0.reasoning}\nCRITIQUE it: is it deployable (hedge?), does it beat risk-free after fees, is tail-risk mishandled? List the flaws.`);
  return (await ask(`${feat(f)}\nInitial pick ${p0.strategy}. Critique: ${crit.reasoning}\nGiven the critique, output the FINAL corrected strategy.`)).strategy;
}

// ---- run ----
if (!authIsAvailable()) { console.log("\n[bench] No OAuth/API auth available — cannot run the LLM loops. (The deterministic controls still work.)\n"); }
const regimes = makeRegimes(N);
const truths = regimes.map((x) => x.truth), nets = regimes.map((x) => x.netClean);
const rnd = lcg(99);

type LoopDef = { name: string; llm: boolean; run: (f: MarketFeatures) => Promise<Strategy> | Strategy };
const loops: LoopDef[] = [
  { name: "random", llm: false, run: () => STRATEGIES[Math.floor(rnd() * STRATEGIES.length)] },
  { name: "naive", llm: false, run: (f) => naiveSelect(f) },
  { name: "deterministic", llm: false, run: (f) => deterministicSelect(f) },
  { name: "llm:single", llm: true, run: single },
  { name: "llm:cot", llm: true, run: cot },
  { name: "llm:ensemble@5", llm: true, run: ensemble },
  { name: "llm:debate", llm: true, run: debate },
  { name: "llm:reflexion", llm: true, run: reflexion },
];

console.log(`\nloop-design-bench — ${N} regimes · model ${MODEL} (OAuth) · ground-truth = argmax net APR\n`);
const results: Array<{ name: string; acc: number; regret: number; calls: number; llm: boolean }> = [];
for (const L of loops) {
  if (L.llm && !authIsAvailable()) continue;
  const before = CALLS;
  const picks: Strategy[] = [];
  for (const reg of regimes) picks.push(await L.run(reg.observed));   // sequential across regimes (rate-friendly)
  const s = scoreRun(picks, truths, nets);
  results.push({ name: L.name, acc: s.accuracy, regret: s.meanRegretApr, calls: CALLS - before, llm: L.llm });
  console.log(`  ${L.name.padEnd(16)} acc ${(s.accuracy * 100).toFixed(0).padStart(3)}%  regret ${s.meanRegretApr.toFixed(2).padStart(6)} APR  calls ${String(CALLS - before).padStart(3)}`);
}

// ---- verdict ----
const det = results.find((r) => r.name === "deterministic")!;
const llm = results.filter((r) => r.llm).sort((a, b) => b.acc - a.acc || a.regret - b.regret);
console.log(`\n  ── verdict ──`);
console.log(`  deterministic baseline: ${(det.acc * 100).toFixed(0)}% acc, ${det.regret.toFixed(2)} regret (the §7.6 bar to beat)`);
if (llm.length) {
  const best = llm[0];
  console.log(`  best LLM loop: ${best.name} — ${(best.acc * 100).toFixed(0)}% acc, ${best.regret.toFixed(2)} regret, ${best.calls} calls`);
  console.log(`  LLM-loop ranking (acc, then regret): ${llm.map((r) => `${r.name.replace("llm:", "")} ${(r.acc * 100).toFixed(0)}%`).join(" > ")}`);
  const beats = llm.filter((r) => r.acc > det.acc || (r.acc === det.acc && r.regret < det.regret));
  console.log(beats.length ? `  ✓ beats deterministic: ${beats.map((r) => r.name).join(", ")}` : `  ✗ NO LLM loop beats the deterministic baseline — with a small model on a well-specified task, the cheap rules win.`);
  console.log(`  cost note: ensemble/debate/reflexion cost ${Math.round((llm.find(r=>r.name==="llm:ensemble@5")?.calls ?? 5)/N)}–${Math.round((llm.find(r=>r.name==="llm:reflexion")?.calls ?? 3)/N)}× the calls of single for their accuracy delta.`);
}
console.log("");
