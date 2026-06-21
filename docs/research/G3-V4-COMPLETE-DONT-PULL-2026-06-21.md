# G3-V4 — "complete-don't-pull": the natural smartening of the merge-maker is a WASH

**Date:** 2026-06-21
**Builds on:** `G3-V3-FILLRISK-2026-06-12.md` (cost-guard + fill_risk → ≈breakeven
on IS by trading far less; "salvageable, not proven"). v3 named the exact problem:
the **entire loss is the adversely-selected mild-unpaired (10–30 share) bucket**.
**Data:** real PMXT v2 L2. **IS** = 2026-06-10 T14–T20 (162 windows, the v3 window —
the *tuning* set). **OOS** = 2026-06-10 T05–T10 (140 **disjoint** windows, fetched
fresh for this test). Same back-of-queue queue-fill, real Gamma 0/1 settles, real
Binance 1m fair value. Lever flag: `--fr-complete [--fr-complete-max N] [--fr-complete-thresh N]`
in `scripts/pair-maker-backtest.ts`.

## The lever
When fill_risk would pull the leg we need to BUY to balance (the under-represented
side), **restore the planned (budget-safe) bid and complete the pair** — convert
would-be unpaired residual into locked merge margin — instead of pulling and riding
the unpaired leg to settle. Band-gated (`--fr-complete-max`) so it only completes
*mild* imbalance and lets fill_risk pull on *heavy* (strongly-directional) imbalance.

## VERDICT — NO-BETTER-than-v3 (do not ship)

A 16-config sweep (gate band, threshold, cap, tau-floor, cancel-mode), every config
adversarially OOS-validated. **No config is net-positive on IS or OOS. No lever
config beats the v3 baseline on BOTH windows.**

| config | IS $ | OOS $ | IS paired | IS mild | IS heavy | note |
|---|---|---|---|---|---|---|
| `v3best_cap10` (baseline) | **−59.95** | −124.80 | +48.8 | −126.8 | +18.1 | best IS = the v3 cap, NOT a lever |
| `band30_tau180` (best lever) | −60.54 | **−75.32** | +76.5 | −183.1 | +46.0 | loses IS to v3 by $0.59; best OOS but high-dispersion |
| `band25` | −62.66 | −151.49 | +70.2 | −168.1 | +35.2 | 2nd-best IS → **worst** OOS |
| `band20_cap15` | −63.13 | −129.11 | +46.4 | −130.3 | +20.8 | |
| `baseline_e` (v3) | −78.83 | −129.06 | +30.0 | −144.1 | +35.2 | |
| `complete_naive` (ungated) | −113.39 | — | +120.1 | −149.0 | **−84.5** | heavy bucket blows up |

## Why it's a wash — the mechanism is real but cancels

The lever does **exactly** what it was built to do: paired-bucket income rises
monotonically (30 → 70–86), pair-completion 47% → 55–68%. That part is reproducible,
not noise. **But the mild bucket gets MORE negative in every completing config**
(−144 → −168…−189): completing the pair forces fills on precisely the
**adversely-selected leg** (the side the market is fleeing), so the paired-income
gains are handed straight back through the mild bucket. Paired↑ and mild↓ cancel,
pinning every config in the −$60…−$63 IS band — no better than v3's own cap.

The single OOS "win" (`band30_tau180`, −$75) is one config inside a family whose OOS
spans −$75 → −$151; the ranking is **unstable across windows** (band25 is 2nd IS,
worst OOS). Not a stable, mechanism-attributable edge.

## The structural ceiling (the real result)

**Unpaired inventory is adversely selected by construction.** The leg that fails to
pair is unpaired *because* it's the side the order flow is leaving. So **any**
"complete-the-pair" lever is buying the loser by construction; raising completion
mechanically raises exposure to that selection. This is not a tuning problem — it is
the ceiling. v3's "salvageable, not proven" is hereby sharpened: the most natural
smartening of the lane does not move the bottom line.

## Caveats (so we don't fool ourselves)
- **OOS is same-calendar-day** (disjoint windows, identical regime) — it tests
  window-selection, not regime generalization. The PMXT free archive now retains only
  2026-06-10, so a second, regime-distinct day was **not fetchable**. Single day of
  data total → no defense against one-day idiosyncrasy.
- The queue-fill model is an **assumed** back-of-queue heuristic, and this lever's
  whole thesis is *completing fills* → PnL is maximally sensitive to exactly the part
  of the model that is assumed, not measured.

## Cycle 2 — ex-ante window selection: ALSO a wash (the loss is post-entry)
If you can't fix the unpaired leg after the fact (cycle 1), the natural follow-up is:
**don't ENTER the windows that will adversely-select.** Added a no-lookahead ex-ante
gate (`--skip-open-drift <bps> [--open-window-sec <s>]`): once the opening window
elapses, freeze the open drift `|spot/strike−1|`; if it exceeds the threshold the
window is moving directionally → stop quoting it. Swept threshold × open-window IS,
OOS-validated, adversarially verified.

| config | IS $ | OOS $ | IS paired | IS mild | active |
|---|---|---|---|---|---|
| `ref_v3best` (--max-unpaired 10) | −59.95 | −124.80 | +48.8 | −126.8 | 75 |
| `sel8` (skip >8bps) | **−14.85** | **−109.77** | +30.4 | −63.3 | 61 |
| `sel12` | −22.27 | −129.68 | +46.8 | −87.2 | 68 |
| `sel_only_12` (no cap) | −45.54 | −133.94 | +28.1 | −104.3 | 68 |

`sel8` numerically beats v3 on **both** windows — but the adversarial forensics
**reject it as a noise-band artifact**: (1) the **heavy bucket is invariant (18.08)**
across every gated config — the gate cuts *zero* of the worst windows (the
`--max-unpaired` cap already did that); (2) it shrinks mild only by **surrendering
paired profit faster** (keeps 81% of windows but 62% of paired income → it cuts the
*profitable* pair-completing windows, because directional-open correlates with
both-sides-fill); (3) **non-monotone OOS** — tightening sel8→sel12 makes OOS *worse*,
the fingerprint of overfit, not signal; (4) `sel_only_12` (gate, no cap) is worst on
both buckets → the **cap does the work, not the gate.** The loss is a **post-open
phenomenon**: resting inventory is picked off *after* entry, so the opening seconds
carry ~no information. sel8 "wins" only by being the loosest gate that ≈ does nothing.

## Unified verdict (both cycles)
A **back-of-queue retail merge-maker is structurally unprofitable.** Its inventory is
adversely selected **by construction**, and the selection materializes **post-entry**:
- ❌ post-fill disposition (cycle 1, complete-don't-pull) — acts on already-poisoned
  inventory → wash.
- ❌ ex-ante entry gate (cycle 2, skip-open-drift) — can't fire because the poison
  isn't visible at the open → no-better-than-v3.
- The only lever that reduces loss is the crude `--max-unpaired` cap (a damage-limiter,
  not an edge). There is **no positive-PnL config anywhere in the grid** (best is
  −$14.85 IS / −$109.77 OOS, achieved by trading *less*, not better).

**Every disposition/timing lever is now empirically exhausted.** The edge can only come
from **queue position** (be at the *front* so you're not the last to fill) or a **maker
fee/rebate structure** that pays enough to cover the structural adverse selection —
neither available to a back-of-queue retail taker. This is exactly why the profitable
wallets (coinman2 +$1.09M) earn the spread/rebate **as principal** with queue priority:
**the spread is the edge, and you only collect it from the front of the queue.**

Do not allocate. Keep as forward-paper infrastructure only. (Reproduce: `--fr-complete`
and `--skip-open-drift` flags on `scripts/pair-maker-backtest.ts`, branch
`smartmm-experiment`.)
