/**
 * Robustness / invariant / edge-case tests for the capsule lifecycle module
 * (Phase 10 — capsule-portfolio-governance §4.6).
 *
 * Complements `capsule-lifecycle.test.ts` (which covers the basic precedence
 * rules + happy paths). This file targets:
 *
 *   - Promotion ladder invariants: a promotion only ever advances ONE stage,
 *     strictly forward, never skipping, never landing outside the ladder.
 *   - Determinism + idempotence: same input → same output; re-deciding on the
 *     same stage is stable (no oscillation).
 *   - Terminal / non-ladder stages never promote and never freeze.
 *   - Precedence ordering: freeze beats demote beats correlation-veto beats
 *     PnL-gate beats promote beats hold, verified by stacking triggers.
 *   - Edge inputs: NaN / Infinity / negative drawdown, exact-boundary
 *     thresholds (>= vs >), legacy synonym normalization, env parsing bounds.
 *
 * All inputs are pure synthetic objects constructed from the real exported
 * types. A small seeded LCG drives the fuzz cases so the file is fully
 * deterministic — no wall-clock, no Math.random.
 */
import { describe, expect, it } from "vitest";
import {
  decideLifecycleAction,
  DEFAULT_LIFECYCLE_THRESHOLDS,
  isActiveStage,
  normalizeStage,
  readLifecycleThresholdsFromEnv,
  type LifecycleAction,
  type LifecycleCapsule,
  type LifecycleStage,
} from "@/lib/portfolio/lifecycle";

const T = DEFAULT_LIFECYCLE_THRESHOLDS;

/** Order of the promotion ladder (mirrors STAGE_ORDER in the source). */
const LADDER: LifecycleStage[] = [
  "idea",
  "backtest",
  "paper",
  "micro_live",
  "probation_live",
  "full_live",
];

function cap(over: Partial<LifecycleCapsule>): LifecycleCapsule {
  return {
    id: "cap-A",
    stage: "paper",
    capital_allocated_usd: 10,
    current_pnl_usd: 0,
    trades_count: 0,
    loss_overlap: null,
    max_pair_corr: null,
    drawdown_pct: 0,
    ...over,
  };
}

/** Deterministic LCG (Numerical Recipes constants) → [0, 1). */
function makeLcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("decideLifecycleAction — output shape invariants", () => {
  it("always echoes the (normalized) current stage and capsule id", () => {
    const d = decideLifecycleAction(cap({ id: "cap-Z", stage: "live", trades_count: 100 }));
    expect(d.capsule_id).toBe("cap-Z");
    // legacy 'live' normalizes to full_live before any decision is made.
    expect(d.current_stage).toBe("full_live");
  });

  it("action is always one of the four declared variants", () => {
    const valid: LifecycleAction[] = ["promote", "demote", "freeze", "hold"];
    const stages: LifecycleStage[] = [
      "idea", "backtest", "paper", "micro_live", "probation_live",
      "full_live", "degraded", "frozen", "retired", "reserve",
      "draft", "live", "paused", "stopped", "closed",
    ];
    for (const stage of stages) {
      const d = decideLifecycleAction(cap({ stage, trades_count: 75, current_pnl_usd: 5 }));
      expect(valid).toContain(d.action);
    }
  });

  it("a 'hold' decision never carries a next_stage", () => {
    const d = decideLifecycleAction(cap({ stage: "paper", trades_count: 0 }));
    expect(d.action).toBe("hold");
    expect(d.next_stage).toBeNull();
  });

  it("reason is always a non-empty string", () => {
    for (const stage of LADDER) {
      const d = decideLifecycleAction(cap({ stage, trades_count: 7, current_pnl_usd: 1, max_pair_corr: 0.1 }));
      expect(typeof d.reason).toBe("string");
      expect(d.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("decideLifecycleAction — promotion advances exactly one ladder rung", () => {
  // For each promotable stage, supply trades well above its threshold so the
  // promotion path is taken, and assert next_stage is the *immediate* successor.
  const cases: Array<{ from: LifecycleStage; to: LifecycleStage; trades: number }> = [
    { from: "paper", to: "micro_live", trades: 1000 },
    { from: "micro_live", to: "probation_live", trades: 1000 },
    { from: "probation_live", to: "full_live", trades: 1000 },
  ];

  for (const c of cases) {
    it(`${c.from} → ${c.to} (single forward step, in-ladder)`, () => {
      const d = decideLifecycleAction(cap({
        stage: c.from,
        trades_count: c.trades,
        max_pair_corr: 0.1,
        current_pnl_usd: 100,
        drawdown_pct: 0,
      }));
      expect(d.action).toBe("promote");
      expect(d.next_stage).toBe(c.to);

      const fromIdx = LADDER.indexOf(c.from);
      const toIdx = LADDER.indexOf(d.next_stage as LifecycleStage);
      // strictly forward and exactly one rung — never skips, never goes back.
      expect(toIdx - fromIdx).toBe(1);
    });
  }
});

describe("decideLifecycleAction — pre-live ladder stages never auto-promote", () => {
  // 'idea' and 'backtest' are in STAGE_ORDER but have no minTradesForPromotion
  // entry → threshold is +Infinity → can never satisfy trades_count >= min.
  for (const stage of ["idea", "backtest"] as const) {
    it(`${stage} holds regardless of trades / corr / pnl`, () => {
      const d = decideLifecycleAction(cap({
        stage,
        trades_count: 1_000_000,
        max_pair_corr: 0.0,
        current_pnl_usd: 1_000_000,
      }));
      expect(d.action).toBe("hold");
      expect(d.next_stage).toBeNull();
    });
  }
});

describe("decideLifecycleAction — terminal & non-ladder stages", () => {
  // Stages not in STAGE_ORDER: nextStage() returns null → no promotion path.
  const nonLadder: LifecycleStage[] = [
    "degraded", "frozen", "retired", "reserve", "paused", "stopped", "closed",
  ];

  for (const stage of nonLadder) {
    it(`${stage} never promotes even with abundant trades`, () => {
      const d = decideLifecycleAction(cap({
        stage,
        trades_count: 9999,
        max_pair_corr: 0.0,
        current_pnl_usd: 9999,
      }));
      expect(d.action).not.toBe("promote");
      expect(d.next_stage).not.toBe("full_live");
    });
  }

  it("frozen at high drawdown does NOT re-freeze (already inactive)", () => {
    const d = decideLifecycleAction(cap({
      stage: "frozen",
      drawdown_pct: 0.99,
      trades_count: 100,
    }));
    // isActiveStage('frozen') === false → freeze guard skipped.
    expect(d.action).toBe("hold");
  });

  it("retired with everything maxed out stays held (terminal)", () => {
    const d = decideLifecycleAction(cap({
      stage: "retired",
      drawdown_pct: 0.95,
      loss_overlap: 0.99,
      max_pair_corr: 0.99,
      trades_count: 9999,
      current_pnl_usd: 9999,
    }));
    expect(d.action).toBe("hold");
    expect(d.next_stage).toBeNull();
  });
});

describe("decideLifecycleAction — determinism & idempotence", () => {
  it("is a pure function: identical inputs → deeply-equal outputs", () => {
    const input = cap({
      stage: "micro_live",
      trades_count: 42,
      max_pair_corr: 0.33,
      current_pnl_usd: 7.5,
      loss_overlap: 0.2,
      drawdown_pct: 0.05,
    });
    const a = decideLifecycleAction(input);
    const b = decideLifecycleAction({ ...input });
    expect(a).toEqual(b);
  });

  it("does not mutate the input capsule", () => {
    const input = cap({ stage: "paper", trades_count: 10, max_pair_corr: 0.2, current_pnl_usd: 5 });
    const snapshot = JSON.parse(JSON.stringify(input));
    decideLifecycleAction(input);
    expect(input).toEqual(snapshot);
  });

  it("does not mutate the thresholds argument", () => {
    const t = { ...DEFAULT_LIFECYCLE_THRESHOLDS };
    const snapshot = { ...t };
    decideLifecycleAction(cap({ stage: "paper", trades_count: 10 }), t);
    expect(t).toEqual(snapshot);
  });

  it("re-deciding from a freshly-promoted stage is stable (no oscillation back)", () => {
    // Promote paper → micro_live, then feed micro_live back in with the SAME
    // (now sub-threshold) trade count. It should hold, never demote/un-promote.
    const first = decideLifecycleAction(cap({
      stage: "paper", trades_count: 5, max_pair_corr: 0.1, current_pnl_usd: 1,
    }));
    expect(first.action).toBe("promote");
    expect(first.next_stage).toBe("micro_live");

    const second = decideLifecycleAction(cap({
      stage: "micro_live", trades_count: 5, max_pair_corr: 0.1, current_pnl_usd: 1,
    }));
    // 5 < minTradesProbation (20) → holds, does not advance further.
    expect(second.action).toBe("hold");
    expect(second.next_stage).toBeNull();
  });
});

describe("decideLifecycleAction — precedence ordering (most severe wins)", () => {
  it("freeze outranks demote (drawdown breach + loss_overlap breach together)", () => {
    const d = decideLifecycleAction(cap({
      stage: "full_live",
      drawdown_pct: 0.90,        // triggers freeze
      loss_overlap: 0.95,        // would trigger demote
      trades_count: 100,
      current_pnl_usd: -50,
    }));
    expect(d.action).toBe("freeze");
    expect(d.next_stage).toBe("frozen");
  });

  it("demote outranks promotion-eligibility logic at full_live", () => {
    // full_live is top of ladder anyway, but demote must clearly win over hold.
    const d = decideLifecycleAction(cap({
      stage: "full_live",
      drawdown_pct: 0.10,        // below freeze cap
      loss_overlap: 0.95,        // triggers demote
      trades_count: 9999,
      current_pnl_usd: 100,
    }));
    expect(d.action).toBe("demote");
    expect(d.next_stage).toBe("degraded");
  });

  it("correlation veto outranks PnL gate (both would block, corr reason wins)", () => {
    const d = decideLifecycleAction(cap({
      stage: "micro_live",
      trades_count: 100,
      max_pair_corr: 0.99,       // correlation veto fires first
      current_pnl_usd: -100,     // PnL gate would also block
    }));
    expect(d.action).toBe("hold");
    expect(d.reason).toMatch(/too similar/);
    expect(d.reason).not.toMatch(/positive expectancy/);
  });

  it("freeze guard only applies to active stages — backtest with high drawdown still holds", () => {
    const d = decideLifecycleAction(cap({
      stage: "backtest",
      drawdown_pct: 0.99,
      trades_count: 0,
    }));
    expect(d.action).toBe("hold");
    expect(d.action).not.toBe("freeze");
  });
});

describe("decideLifecycleAction — threshold boundary behavior", () => {
  it("drawdown freeze uses >= (exact cap value freezes)", () => {
    const d = decideLifecycleAction(cap({
      stage: "full_live",
      drawdown_pct: T.maxDrawdownPct, // exactly at cap → freeze (>=)
      trades_count: 100,
    }));
    expect(d.action).toBe("freeze");
  });

  it("drawdown just under cap does NOT freeze", () => {
    const d = decideLifecycleAction(cap({
      stage: "full_live",
      drawdown_pct: T.maxDrawdownPct - 1e-9,
      loss_overlap: 0.1,
      trades_count: 100,
      current_pnl_usd: 5,
    }));
    expect(d.action).not.toBe("freeze");
  });

  it("loss_overlap demote uses strict > (exact threshold does NOT demote)", () => {
    const d = decideLifecycleAction(cap({
      stage: "full_live",
      loss_overlap: T.lossOverlapDemote, // exactly at threshold → no demote (>)
      trades_count: 100,
      current_pnl_usd: 5,
      drawdown_pct: 0.1,
    }));
    expect(d.action).not.toBe("demote");
  });

  it("trades_count exactly at the per-stage minimum is enough to promote", () => {
    const exact = decideLifecycleAction(cap({
      stage: "paper",
      trades_count: T.minTradesMicro, // exactly 5 → eligible (>=)
      max_pair_corr: 0.1,
      current_pnl_usd: 1,
    }));
    expect(exact.action).toBe("promote");

    const oneShort = decideLifecycleAction(cap({
      stage: "paper",
      trades_count: T.minTradesMicro - 1,
      max_pair_corr: 0.1,
    }));
    expect(oneShort.action).toBe("hold");
  });

  it("correlation veto uses strict > (exact maxCorrPromote still promotes)", () => {
    const d = decideLifecycleAction(cap({
      stage: "paper",
      trades_count: 10,
      max_pair_corr: T.maxCorrPromote, // exactly at ceiling → not vetoed (>)
      current_pnl_usd: 1,
    }));
    expect(d.action).toBe("promote");
  });

  it("PnL gate at micro_live uses < 0 (exactly zero promotes)", () => {
    const zero = decideLifecycleAction(cap({
      stage: "micro_live",
      trades_count: 20,
      max_pair_corr: 0.1,
      current_pnl_usd: 0,
    }));
    expect(zero.action).toBe("promote");

    const tinyNeg = decideLifecycleAction(cap({
      stage: "micro_live",
      trades_count: 20,
      max_pair_corr: 0.1,
      current_pnl_usd: -0.0001,
    }));
    expect(tinyNeg.action).toBe("hold");
    expect(tinyNeg.reason).toMatch(/PnL/);
  });
});

describe("decideLifecycleAction — non-finite & odd numeric inputs", () => {
  it("NaN drawdown does not freeze (Number.isFinite guard)", () => {
    const d = decideLifecycleAction(cap({
      stage: "full_live",
      drawdown_pct: Number.NaN,
      loss_overlap: 0.1,
      trades_count: 100,
      current_pnl_usd: 5,
    }));
    expect(d.action).not.toBe("freeze");
  });

  it("Infinity drawdown does not freeze (Number.isFinite guard)", () => {
    const d = decideLifecycleAction(cap({
      stage: "full_live",
      drawdown_pct: Number.POSITIVE_INFINITY,
      loss_overlap: 0.1,
      trades_count: 100,
      current_pnl_usd: 5,
    }));
    expect(d.action).not.toBe("freeze");
  });

  it("negative drawdown (unrealized gain) never freezes", () => {
    const d = decideLifecycleAction(cap({
      stage: "full_live",
      drawdown_pct: -0.25,
      loss_overlap: 0.1,
      trades_count: 100,
      current_pnl_usd: 5,
    }));
    expect(d.action).not.toBe("freeze");
  });

  it("undefined drawdown_pct is treated as 'no breach'", () => {
    const d = decideLifecycleAction(cap({
      stage: "full_live",
      drawdown_pct: undefined,
      loss_overlap: 0.1,
      trades_count: 100,
      current_pnl_usd: 5,
    }));
    expect(d.action).not.toBe("freeze");
  });

  it("zero trades on paper holds with the trade-shortfall reason", () => {
    const d = decideLifecycleAction(cap({ stage: "paper", trades_count: 0 }));
    expect(d.action).toBe("hold");
    expect(d.reason).toMatch(/0 trades < 5/);
  });
});

describe("normalizeStage — robustness", () => {
  it("empty string falls back to idea", () => {
    expect(normalizeStage("")).toBe("idea");
  });

  it("is idempotent on its own outputs", () => {
    for (const raw of ["live", "draft", "paper", "micro_live", null, undefined, ""]) {
      const once = normalizeStage(raw);
      expect(normalizeStage(once)).toBe(once);
    }
  });

  it("unknown strings pass through unchanged (lenient by design)", () => {
    expect(normalizeStage("some_future_stage")).toBe("some_future_stage" as LifecycleStage);
  });
});

describe("isActiveStage — partition invariant", () => {
  it("active and inactive stages are disjoint and cover the union", () => {
    const all: LifecycleStage[] = [
      "idea", "backtest", "paper", "micro_live", "probation_live",
      "full_live", "degraded", "frozen", "retired", "reserve",
      "draft", "live", "paused", "stopped", "closed",
    ];
    const active = all.filter(isActiveStage);
    const inactive = all.filter((s) => !isActiveStage(s));
    expect(active.length + inactive.length).toBe(all.length);
    // No overlap.
    expect(active.filter((s) => inactive.includes(s))).toEqual([]);
    // Exactly the five active stages.
    expect(new Set(active)).toEqual(
      new Set(["paper", "micro_live", "probation_live", "full_live", "degraded"]),
    );
  });
});

describe("readLifecycleThresholdsFromEnv — bounds & parsing", () => {
  it("rejects negative env values, falling back to defaults", () => {
    const t = readLifecycleThresholdsFromEnv({
      LIFECYCLE_MIN_TRADES_MICRO: "-5",
      LIFECYCLE_MAX_DRAWDOWN_PCT: "-0.3",
    });
    expect(t.minTradesMicro).toBe(T.minTradesMicro);
    expect(t.maxDrawdownPct).toBe(T.maxDrawdownPct);
  });

  it("accepts zero (>= 0 is valid per numFromEnv)", () => {
    const t = readLifecycleThresholdsFromEnv({ LIFECYCLE_MAX_CORR_PROMOTE: "0" });
    expect(t.maxCorrPromote).toBe(0);
  });

  it("strips surrounding quotes", () => {
    const t = readLifecycleThresholdsFromEnv({ LIFECYCLE_MIN_TRADES_FULL_LIVE: '"75"' });
    expect(t.minTradesFullLive).toBe(75);
  });

  it("produces a usable threshold set that decideLifecycleAction can consume", () => {
    const t = readLifecycleThresholdsFromEnv({ LIFECYCLE_MIN_TRADES_MICRO: "3" });
    const d = decideLifecycleAction(
      cap({ stage: "paper", trades_count: 3, max_pair_corr: 0.1, current_pnl_usd: 1 }),
      t,
    );
    expect(d.action).toBe("promote");
    expect(d.next_stage).toBe("micro_live");
  });
});

describe("decideLifecycleAction — seeded fuzz invariants", () => {
  it("never emits an out-of-ladder promotion across many random capsules", () => {
    const rnd = makeLcg(0xC0FFEE);
    const stages = LADDER.concat(["degraded", "frozen", "retired", "reserve", "paused"]);
    for (let i = 0; i < 400; i++) {
      const stage = stages[Math.floor(rnd() * stages.length)] as LifecycleStage;
      const d = decideLifecycleAction(cap({
        id: `fz-${i}`,
        stage,
        trades_count: Math.floor(rnd() * 200),
        max_pair_corr: rnd(),
        loss_overlap: rnd(),
        current_pnl_usd: (rnd() - 0.5) * 200,
        drawdown_pct: rnd(), // 0..1
      }));

      if (d.action === "promote") {
        // A promotion must land on a real ladder stage exactly one rung above
        // the (normalized) current ladder stage.
        const fromIdx = LADDER.indexOf(normalizeStage(stage));
        const toIdx = LADDER.indexOf(d.next_stage as LifecycleStage);
        expect(fromIdx).toBeGreaterThanOrEqual(0);
        expect(toIdx).toBe(fromIdx + 1);
      }
      if (d.action === "freeze") {
        // Freeze only fires from an active stage.
        expect(isActiveStage(normalizeStage(stage))).toBe(true);
        expect(d.next_stage).toBe("frozen");
      }
      if (d.action === "demote") {
        // Demote only ever happens at full_live → degraded in this module.
        expect(normalizeStage(stage)).toBe("full_live");
        expect(d.next_stage).toBe("degraded");
      }
    }
  });

  it("is reproducible: same seed → identical decision sequence", () => {
    const run = (seed: number) => {
      const rnd = makeLcg(seed);
      const out: LifecycleAction[] = [];
      for (let i = 0; i < 50; i++) {
        const d = decideLifecycleAction(cap({
          stage: "paper",
          trades_count: Math.floor(rnd() * 20),
          max_pair_corr: rnd(),
          current_pnl_usd: (rnd() - 0.5) * 10,
        }));
        out.push(d.action);
      }
      return out;
    };
    expect(run(12345)).toEqual(run(12345));
  });
});
