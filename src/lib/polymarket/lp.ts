/**
 * Linear program-based arbitrage detection on top of glpk.js (OSS GLPK Emscripten port).
 *
 * Why an LP? An arbitrage portfolio is exactly the optimal solution of:
 *
 *   minimize     Σ price_o · x_o        (cost of buying x_o shares of outcome o)
 *   subject to   Σ_{o true in state s} x_o ≥ 1   for every realisable world-state s
 *                0 ≤ x_o ≤ depth_o
 *
 * If the optimum < 1, we have a guaranteed-$1 portfolio for less than $1 — that
 * spread is the arbitrage edge.
 *
 * For small universes (≤ 16 outcomes) we enumerate every world state directly.
 * For larger universes the column-generation path (`solveColumnGen`) grows the
 * constraint set one most-violating state at a time via an integer subproblem.
 * That's the trader-side analog of the Frank-Wolfe + IP scheme in arxiv:1606.02825.
 */
// @ts-ignore — glpk.js ships untyped
import GLPK from "glpk.js";

let cached: any = null;
async function glpk(): Promise<any> {
  if (cached) return cached;
  // The published index exports a factory function that returns a Promise of the GLPK instance.
  const factory = (GLPK as any).default ?? (GLPK as any);
  cached = await factory();
  return cached;
}

export type LpOutcome = {
  /** External id for the outcome — token id is the typical choice. */
  id: string;
  /** Ask price, expressed in dollars per share (0 < price < 1). */
  price: number;
  /** Max shares available at this price (top-of-book size). */
  depth: number;
  /** Optional human label for the report. */
  label?: string;
  /** Which market this outcome belongs to. Used to express mutual exclusion. */
  marketId: string;
};

export type LpConstraint = {
  /**
   * Logical implication "if outcomes in `if_true` all hold, then exactly one of
   * `then_true` must hold". Used to encode cross-market dependencies (e.g.
   * "Republicans win PA by 5+" → "Trump wins PA").
   */
  ifTrue: string[];
  thenTrue: string[];
};

export type ArbPortfolio = {
  /** Per-outcome share counts to buy. Includes zeros for completeness. */
  shares: Record<string, number>;
  /** Sum of price × shares. */
  costUsd: number;
  /** Guaranteed payoff (= 1 × max shares bought, by LP duality). */
  guaranteedPayoutUsd: number;
  /** Net edge = payoff - cost. */
  edgeUsd: number;
  /** How many shares of the basket we end up buying. */
  basketShares: number;
};

/**
 * Enumerate every consistent world-state across the supplied markets.
 * For mutually-exclusive markets each market contributes exactly one true outcome.
 * Cross-market constraints filter the cartesian product.
 *
 * Hard-capped at 2^16 = 65,536 states. Caller should switch to column gen above
 * that threshold.
 */
function enumerateStates(outcomes: LpOutcome[], constraints: LpConstraint[]): string[][] {
  const byMarket = new Map<string, LpOutcome[]>();
  for (const o of outcomes) {
    const arr = byMarket.get(o.marketId) ?? [];
    arr.push(o);
    byMarket.set(o.marketId, arr);
  }
  const markets = [...byMarket.values()];
  if (markets.length === 0) return [];

  // Cartesian product across markets — one true outcome per market.
  let states: string[][] = [[]];
  for (const market of markets) {
    const next: string[][] = [];
    for (const s of states) for (const o of market) next.push([...s, o.id]);
    states = next;
    if (states.length > 65_536) throw new Error(`enumerateStates exceeded 65,536 (got ${states.length})`);
  }

  // Filter by constraints: if every id in `ifTrue` is in s, then s must contain at least one id from `thenTrue`.
  return states.filter((s) => {
    const set = new Set(s);
    return constraints.every((c) => {
      if (!c.ifTrue.every((id) => set.has(id))) return true; // antecedent unmet → vacuously satisfied
      return c.thenTrue.some((id) => set.has(id));
    });
  });
}

/**
 * Direct LP for small universes. Returns null if no arbitrage exists
 * (i.e. optimal cost ≥ guaranteed payoff).
 */
export async function solveArbLp(outcomes: LpOutcome[], constraints: LpConstraint[] = []): Promise<ArbPortfolio | null> {
  if (outcomes.length === 0) return null;
  const states = enumerateStates(outcomes, constraints);
  if (states.length === 0) return null;
  return solveOnStates(outcomes, states);
}

async function solveOnStates(outcomes: LpOutcome[], states: string[][]): Promise<ArbPortfolio | null> {
  const g = await glpk();
  const varName = (o: LpOutcome) => `x_${o.id}`;
  const lp = {
    name: "arb",
    objective: {
      direction: g.GLP_MIN,
      name: "cost",
      vars: outcomes.map((o) => ({ name: varName(o), coef: o.price })),
    },
    subjectTo: states.map((s, i) => {
      const setS = new Set(s);
      return {
        name: `cover_${i}`,
        vars: outcomes.filter((o) => setS.has(o.id)).map((o) => ({ name: varName(o), coef: 1 })),
        bnds: { type: g.GLP_LO, lb: 1, ub: 0 }, // ≥ 1
      };
    }),
    bounds: outcomes.map((o) => ({
      name: varName(o),
      type: g.GLP_DB, // double bounded
      lb: 0,
      ub: Math.max(0, o.depth),
    })),
  };

  const res = g.solve(lp, { msglev: g.GLP_MSG_OFF });
  if (!res?.result || res.result.status !== g.GLP_OPT) return null;

  const cost = res.result.z;
  // Payoff equals the smallest x_o across the binding constraints — for the basket-buy case
  // the payoff per "unit basket" is 1 by construction. We scale shares to integer-ish basket counts.
  const sharesByVar: Record<string, number> = res.result.vars ?? {};
  const minNonZero = Math.min(...Object.values(sharesByVar).filter((v) => v > 1e-6));
  if (!Number.isFinite(minNonZero) || minNonZero <= 0) return null;

  const basketShares = Math.max(1, Math.floor(minNonZero));
  const shares: Record<string, number> = {};
  for (const o of outcomes) shares[o.id] = Math.floor((sharesByVar[varName(o)] ?? 0));
  const realCost = outcomes.reduce((acc, o) => acc + o.price * (shares[o.id] ?? 0), 0);
  const guaranteed = basketShares; // by LP feasibility every state pays out at least basketShares
  const edge = guaranteed - realCost;
  if (edge <= 0) return null;

  return { shares, costUsd: realCost, guaranteedPayoutUsd: guaranteed, edgeUsd: edge, basketShares };
}

/**
 * Column generation for large universes — start from a tiny initial set of
 * world states (one per market: pick the cheapest outcome), solve the LP, then
 * find the most-violating state via an integer subproblem and add it.
 *
 * This is exactly the trader-side Frank-Wolfe analog: the polytope of valid
 * states is exponential, so we grow it lazily until either a) no violating
 * state exists (LP is feasible over the full polytope → solution is optimal),
 * or b) we hit the iteration cap.
 *
 * For now the IP subproblem uses GLPK's MIP solver — same backend. For higher
 * performance swap in a Gurobi sidecar without changing this interface.
 */
export async function solveColumnGen(
  outcomes: LpOutcome[],
  constraints: LpConstraint[] = [],
  opts: { maxIters?: number } = {},
): Promise<ArbPortfolio | null> {
  const maxIters = opts.maxIters ?? 150;
  // Seed: one world state per market with the cheapest outcome (closest to "natural" state).
  const byMarket = new Map<string, LpOutcome[]>();
  for (const o of outcomes) {
    const arr = byMarket.get(o.marketId) ?? [];
    arr.push(o);
    byMarket.set(o.marketId, arr);
  }
  let states: string[][] = [];
  states.push([...byMarket.values()].map((arr) => arr.reduce((a, b) => (a.price <= b.price ? a : b)).id));
  states.push([...byMarket.values()].map((arr) => arr.reduce((a, b) => (a.price >= b.price ? a : b)).id));

  for (let iter = 0; iter < maxIters; iter++) {
    const solution = await solveOnStates(outcomes, states);
    if (!solution) return null;
    const violator = await findMostViolatingState(outcomes, constraints, solution);
    if (!violator) return solution; // optimal over the full polytope
    states.push(violator);
  }
  return await solveOnStates(outcomes, states);
}

/**
 * Find a world state s that minimises Σ_{o true in s} x_o*. If the minimum is
 * < 1, that state is violated by the current LP solution and should be added.
 * Returns null if no violating state exists.
 */
async function findMostViolatingState(
  outcomes: LpOutcome[],
  constraints: LpConstraint[],
  solution: ArbPortfolio,
): Promise<string[] | null> {
  const g = await glpk();
  // Binary y_o ∈ {0,1} = whether outcome o is true in state s.
  // For each market, exactly one outcome is true: Σ_{o ∈ market} y_o = 1.
  // Constraints: ifTrue ⇒ thenTrue ⇒ Σ y_thenTrue ≥ (Σ y_ifTrue) - |ifTrue| + 1.
  const byMarket = new Map<string, LpOutcome[]>();
  for (const o of outcomes) {
    const arr = byMarket.get(o.marketId) ?? [];
    arr.push(o);
    byMarket.set(o.marketId, arr);
  }
  const ipName = (o: LpOutcome) => `y_${o.id}`;
  const lp = {
    name: "violation",
    objective: {
      direction: g.GLP_MIN,
      name: "coverage",
      vars: outcomes.map((o) => ({ name: ipName(o), coef: solution.shares[o.id] ?? 0 })),
    },
    subjectTo: [
      ...[...byMarket.entries()].map(([mid, os], i) => ({
        name: `one_per_${i}`,
        vars: os.map((o) => ({ name: ipName(o), coef: 1 })),
        bnds: { type: g.GLP_FX, lb: 1, ub: 1 },
      })),
      ...constraints.map((c, i) => ({
        name: `impl_${i}`,
        vars: [
          ...c.ifTrue.map((id) => ({ name: `y_${id}`, coef: -1 })),
          ...c.thenTrue.map((id) => ({ name: `y_${id}`, coef: 1 })),
        ],
        bnds: { type: g.GLP_LO, lb: 1 - c.ifTrue.length, ub: 0 },
      })),
    ],
    bounds: outcomes.map((o) => ({ name: ipName(o), type: g.GLP_DB, lb: 0, ub: 1 })),
    binaries: outcomes.map((o) => ipName(o)),
  };

  const res = g.solve(lp, { msglev: g.GLP_MSG_OFF, presol: true });
  if (!res?.result || res.result.status !== g.GLP_OPT) return null;
  if (res.result.z >= solution.basketShares - 1e-6) return null; // no violation
  const vars = res.result.vars ?? {};
  return outcomes.filter((o) => (vars[ipName(o)] ?? 0) > 0.5).map((o) => o.id);
}
