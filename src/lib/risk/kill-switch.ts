import { insertEvolutionEvent } from "@/lib/db/queries";
import { getDefaultRiskEngine, type RiskEngine } from "./engine";

/**
 * Coordinator for emergency trading halts across every registered venue.
 *
 * Ported from TradingBot/src/risk/kill_switch.py. Adapters register a
 * `cancelOpenOrders` and `flattenPositions` callable so the kill switch stays
 * decoupled from venue specifics.
 *
 * Typical flow:
 *   1. Set RiskEngine.halted=true so subsequent risk.check() rejects everything
 *   2. Call cancelOpenOrders() on every registered adapter (in parallel)
 *   3. Optionally call flattenPositions() if mode === "liquidate"
 *   4. Write a 'kill-switch' event to evolution_log for the audit trail
 */

export type HaltMode = "pause_new_only" | "close_and_pause" | "liquidate";

export type BrokerHandle = {
  name: string;
  cancelOpenOrders: () => Promise<unknown>;
  flattenPositions?: () => Promise<unknown>;
};

export type HaltState = {
  halted: boolean;
  reason: string;
  haltedAt: string | null;
  brokersHalted: string[];
};

export class KillSwitch {
  readonly riskEngine: RiskEngine;
  private brokers = new Map<string, BrokerHandle>();
  private state: HaltState = {
    halted: false,
    reason: "",
    haltedAt: null,
    brokersHalted: [],
  };

  constructor(riskEngine?: RiskEngine) {
    this.riskEngine = riskEngine ?? getDefaultRiskEngine();
  }

  registerBroker(handle: BrokerHandle): void {
    this.brokers.set(handle.name, handle);
  }

  unregisterBroker(name: string): void {
    this.brokers.delete(name);
  }

  getRegisteredBrokers(): string[] {
    return Array.from(this.brokers.keys());
  }

  getState(): HaltState {
    return { ...this.state, brokersHalted: [...this.state.brokersHalted] };
  }

  async haltAll(reason = "manual", mode: HaltMode = "liquidate"): Promise<{
    ok: boolean;
    mode: HaltMode;
    brokers: string[];
    cancelResults: Record<string, unknown>;
    flattenResults: Record<string, unknown>;
    errors: Record<string, string>;
    elapsedMs: number;
  }> {
    const start = Date.now();
    // Set halt flag FIRST so no new orders slip through during cancel/flatten.
    this.state.halted = true;
    this.state.reason = reason;
    this.state.haltedAt = new Date().toISOString();
    this.riskEngine.setHalted(true, reason);

    const cancelResults: Record<string, unknown> = {};
    const flattenResults: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    const brokers = Array.from(this.brokers.values());

    const doCancel = mode === "liquidate" || mode === "close_and_pause";
    const doFlatten = mode === "liquidate" || mode === "close_and_pause";

    if (doCancel) {
      await Promise.all(
        brokers.map(async (b) => {
          try {
            cancelResults[b.name] = await b.cancelOpenOrders();
          } catch (err) {
            errors[b.name] = `cancel: ${(err as Error).message}`;
          }
        }),
      );
    }
    if (doFlatten) {
      await Promise.all(
        brokers.map(async (b) => {
          if (!b.flattenPositions) return;
          try {
            flattenResults[b.name] = await b.flattenPositions();
          } catch (err) {
            errors[b.name] = `${errors[b.name] ?? ""} flatten: ${(err as Error).message}`.trim();
          }
        }),
      );
    }

    this.state.brokersHalted = brokers.map((b) => b.name);
    const elapsedMs = Date.now() - start;

    try {
      insertEvolutionEvent({
        event_type: "kill-switch-halt",
        summary: `HALT (${mode}): ${reason}`,
        payload_json: JSON.stringify({
          mode,
          reason,
          brokers: this.state.brokersHalted,
          cancelResults,
          flattenResults,
          errors,
          elapsedMs,
        }),
      });
    } catch {
      // never let the audit write block the kill switch
    }

    return {
      ok: Object.keys(errors).length === 0,
      mode,
      brokers: this.state.brokersHalted,
      cancelResults,
      flattenResults,
      errors,
      elapsedMs,
    };
  }

  resume(): { ok: true } {
    this.state.halted = false;
    this.state.reason = "";
    this.state.brokersHalted = [];
    this.riskEngine.setHalted(false);
    this.riskEngine.forceRollDay();
    try {
      insertEvolutionEvent({
        event_type: "kill-switch-resume",
        summary: "Trading resumed",
        payload_json: "{}",
      });
    } catch {
      // ignore
    }
    return { ok: true };
  }
}

// ------------------------------------------------------------------- singleton

let defaultKillSwitch: KillSwitch | null = null;

export function getDefaultKillSwitch(): KillSwitch {
  if (!defaultKillSwitch) defaultKillSwitch = new KillSwitch();
  return defaultKillSwitch;
}

export function resetDefaultKillSwitchForTests(): void {
  defaultKillSwitch = null;
}
