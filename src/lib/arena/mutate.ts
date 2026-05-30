/**
 * Mutation operator — two modes:
 *   - 'programmatic' (default, cheap)   : Gaussian perturbation of numeric params,
 *                                          rare strategy_type switch.
 *   - 'llm' (uses Claude OAuth)         : ask the model for a structured mutation
 *                                          given the parent genome + peer perf JSON.
 *
 * Both modes return a genome that passes `GenomeSchema.parse` — out-of-bounds
 * perturbations are clamped and string enums are kept inside their list.
 */
import { z } from "zod";
import { GenomeSchema, getParamBounds, randomGenome, type Genome, type GenomeKind, type SubGenome, clamp, GENOME_KINDS, SUB_GENOME_KINDS } from "./genome";

const SIGMA_PCT = 0.20;            // 20% std-dev perturbation per numeric param
const KIND_SWITCH_PROB = 0.05;     // chance of jumping to a different strategy kind

function gaussian(rng: () => number, mu = 0, sigma = 1): number {
  // Box-Muller — using two uniform draws.
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function perturbNumeric(value: number, lo: number, hi: number, rng: () => number, isInt: boolean): number {
  const range = hi - lo;
  const sigma = Math.max(1e-6, range * SIGMA_PCT);
  const next = value + gaussian(rng, 0, sigma);
  const clamped = clamp(next, lo, hi);
  return isInt ? Math.round(clamped) : Number(clamped.toFixed(6));
}

const INT_KEYS = new Set([
  "lookback_h", "confirm_quiet_h", "time_stop_h",
  "lookback_min", "time_stop_min", "bs_vol_window_days",
]);

export function mutateProgrammatic(parent: Genome, rng: () => number, opts: { polyConditionIdPool?: string[] } = {}): Genome {
  // multi_strategy needs its own mutation handler — sub-genomes are recursive
  // and the generic bounds-based loop can't perturb them.
  if (parent.kind === "multi_strategy") {
    return mutateMultiStrategy(parent, rng, opts);
  }
  // Occasional jump to a different kind to keep exploration alive.
  if (rng() < KIND_SWITCH_PROB) {
    const others = GENOME_KINDS.filter((k) => k !== parent.kind);
    const newKind = others[Math.floor(rng() * others.length)] as GenomeKind;
    return randomFresh(newKind, rng, opts);
  }
  const bounds = getParamBounds(parent.kind);
  const params: Record<string, unknown> = { ...(parent.params as Record<string, unknown>) };
  for (const [k, b] of Object.entries(bounds)) {
    if (Array.isArray(b) && b.length === 2 && typeof b[0] === "number") {
      const [lo, hi] = b as [number, number];
      params[k] = perturbNumeric(Number(params[k] ?? (lo + hi) / 2), lo, hi, rng, INT_KEYS.has(k));
    } else if (Array.isArray(b) && typeof b[0] === "string" && b.length > 1) {
      // Categorical — 30% chance to flip to a different choice.
      if (rng() < 0.30) {
        const list = b as string[];
        const others = list.filter((s) => s !== params[k]);
        if (others.length > 0) params[k] = others[Math.floor(rng() * others.length)];
      }
    }
  }
  // poly_condition_id (string from a pool) — keep parent's unless empty.
  if (parent.kind === "cross_venue_arb" && opts.polyConditionIdPool && opts.polyConditionIdPool.length > 0 && rng() < 0.20) {
    params.poly_condition_id = opts.polyConditionIdPool[Math.floor(rng() * opts.polyConditionIdPool.length)];
  }
  return GenomeSchema.parse({ kind: parent.kind, params });
}

function randomFresh(kind: GenomeKind, rng: () => number, opts: { polyConditionIdPool?: string[] }): Genome {
  return randomGenome(rng, kind, opts);
}

/**
 * Mutation for multi_strategy composite — three strategies in priority order:
 *   - 70%: perturb one sub-genome's parameters (recursively call
 *          mutateProgrammatic on that sub)
 *   - 20%: replace one sub-genome with a fresh random of a different kind
 *   - 10%: reorder the subs array (matters for selection="priority")
 *
 * Always returns a valid multi_strategy genome — perturbation of subs that
 * fail validation falls back to the parent sub. PRD §6.2.L2 + Phase 5 spec.
 */
function mutateMultiStrategy(parent: Extract<Genome, { kind: "multi_strategy" }>, rng: () => number, opts: { polyConditionIdPool?: string[] }): Genome {
  const subs: SubGenome[] = [...parent.params.subs];
  const r = rng();
  if (r < 0.70) {
    // Perturb one sub.
    const idx = Math.floor(rng() * subs.length);
    const mutated = mutateProgrammatic(subs[idx], rng, opts);
    if (mutated.kind !== "multi_strategy") {
      subs[idx] = mutated as SubGenome;
    }
  } else if (r < 0.90) {
    // Replace one sub with a fresh random of a different kind.
    const idx = Math.floor(rng() * subs.length);
    const existingKinds = new Set(subs.map((s) => s.kind));
    const choices = SUB_GENOME_KINDS.filter((k) => !existingKinds.has(k));
    const newKind = choices.length > 0
      ? choices[Math.floor(rng() * choices.length)]
      : SUB_GENOME_KINDS[Math.floor(rng() * SUB_GENOME_KINDS.length)];
    const fresh = randomGenome(rng, newKind, opts);
    if (fresh.kind !== "multi_strategy") {
      subs[idx] = fresh as SubGenome;
    }
  } else {
    // Reorder subs (shuffle).
    for (let i = subs.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [subs[i], subs[j]] = [subs[j], subs[i]];
    }
  }
  return GenomeSchema.parse({
    kind: "multi_strategy",
    params: {
      subs,
      selection: parent.params.selection,
      entry_size_usd: parent.params.entry_size_usd,
    },
  });
}

/**
 * LLM-driven mutation. Returns a programmatic fallback if the OAuth client is
 * unavailable or the response can't be parsed. Adds an `_introduced_by: 'llm'`
 * hint via the caller (we don't bake it into the genome itself).
 */
export async function mutateLlm(
  parent: Genome,
  perfNotes: { fitness: number; pnl_pct: number; max_dd_pct: number; trades_count: number; peerSummary?: string },
  opts: { polyConditionIdPool?: string[] } = {},
  rng: () => number = Math.random,
): Promise<Genome> {
  try {
    const auth = await import("@/lib/anthropic/auth");
    if (!auth.authIsAvailable()) return mutateProgrammatic(parent, rng, opts);
    const client = await auth.getOAuthClient();
    const bounds = getParamBounds(parent.kind);
    const system = `You are an evolutionary search step for a small trading agent. ` +
      `Propose a SINGLE mutated parameter vector for a strategy of kind '${parent.kind}'. ` +
      `Stay inside the supplied numeric bounds. Prefer small adjustments unless the parent did very poorly. ` +
      `Respond with a single JSON object: { "params": { ... } }. No prose.`;
    const user = JSON.stringify({
      parent_genome: parent,
      param_bounds: bounds,
      parent_perf: perfNotes,
      poly_condition_id_pool: opts.polyConditionIdPool ?? [],
    });
    // claude-haiku-4-5-20251001 is the only model accessible via Claude Max
    // OAuth (sonnet/opus return 429). max_tokens bumped to 800 to fit haiku's
    // slightly more verbose JSON output.
    const resp = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = (resp.content[0] as { type: string; text?: string }).text ?? "{}";
    // Try to extract JSON even if model wrapped it.
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return mutateProgrammatic(parent, rng, opts);
    const parsed = JSON.parse(m[0]);
    const candidate = GenomeSchema.parse({ kind: parent.kind, params: parsed.params ?? parsed });
    return candidate;
  } catch {
    return mutateProgrammatic(parent, rng, opts);
  }
}

/** Pick mode based on env: ARENA_MUTATION_MODE = 'llm' | 'programmatic' (default). */
export async function mutate(parent: Genome, perfNotes: { fitness: number; pnl_pct: number; max_dd_pct: number; trades_count: number; peerSummary?: string }, opts: { polyConditionIdPool?: string[] } = {}, rng: () => number = Math.random): Promise<Genome> {
  const mode = (process.env.ARENA_MUTATION_MODE ?? "programmatic").toLowerCase();
  return mode === "llm" ? await mutateLlm(parent, perfNotes, opts, rng) : mutateProgrammatic(parent, rng, opts);
}
