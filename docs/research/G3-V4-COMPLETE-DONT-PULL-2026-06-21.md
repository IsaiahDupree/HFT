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

## Bottom line
The merge-maker's edge (if any) is **not** recoverable by smarter inventory
completion. The profitable real-world wallets (coinman2 +$1.09M) earn the **maker
spread/rebate as the principal**; a back-of-queue retail replica pays adverse
selection on the unpaired leg that exceeds the merge margin. Keep the lane as
forward-paper infrastructure; do not size. (Reproduce: `--fr-complete` flags on
`scripts/pair-maker-backtest.ts`; this experiment lives on branch `smartmm-experiment`.)
