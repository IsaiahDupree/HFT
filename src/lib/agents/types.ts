/**
 * Shared evaluator/agent types. Used by:
 *   - scripts/research-loop.ts (per-pass evaluator dispatch)
 *   - src/lib/agents/oracle-llm.ts (LLM-driven Oracle Research)
 *   - any future agent that plugs into the loop
 *
 * The single shape EvaluatorVerdict covers everything an evaluator can decide
 * to do: nothing, propose a new strategy_version, emit a research note, or
 * submit an order through the router. The research-loop runner dispatches
 * each kind into the right downstream pipeline.
 */
import type { Signal } from "@/lib/polymarket/signals";
import type { UnifiedOrder } from "@/lib/venue/types";
import type { AgentContext } from "./context";

export type StrategyRow = {
  id: number;
  agent_id: number;
  slug: string;
  name: string;
  thesis: string;
  market_filter: string;
};

export type StrategyVersionRow = {
  id: number;
  strategy_id: number;
  version: number;
  spec_json: string;
  is_current: number;
  stage?: "sim" | "paper" | "live_eligible" | "live" | "restricted";
};

export type EvaluatorArgs = {
  strategy: StrategyRow;
  current: StrategyVersionRow;
  signals: Signal[];
  /** Safety + history snapshot — see src/lib/agents/context.ts */
  context: AgentContext;
};

export type EvaluatorVerdict =
  | null
  | {
      kind: "propose-version";
      rationale: string;
      specPatch: Record<string, unknown>;
      /** Initial payload — backtest-on-propose will merge .score / .scoredAt etc. in. */
      backtestSummary: Record<string, unknown>;
    }
  | {
      kind: "research-note";
      topic: string;
      body: string;
      tags?: string[];
      sourceUrls?: string[];
      confidence?: number;
    }
  | {
      kind: "submit-order";
      order: UnifiedOrder;
      /** Free-form context that lands in evolution_log.payload_json. */
      note?: string;
    };

/** Async-allowed so an LLM-backed evaluator can return a Promise. */
export type Evaluator = (args: EvaluatorArgs) => EvaluatorVerdict | Promise<EvaluatorVerdict>;
