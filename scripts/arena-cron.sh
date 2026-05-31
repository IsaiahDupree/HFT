#!/bin/zsh -l
# One arena cycle: obtain fresh real market data, then tick the population once.
# Lock-guarded so overlapping invocations don't pile up. Safe to run from cron
# or the arena-loop.sh wrapper.
#
# PREFERRED scheduler on macOS: a launchd LaunchAgent (runs in the user session
# with full Documents/TCC access, every 5 min, reboot-durable) — see
# scripts/launchd/com.isaiahdupree.hft.arena.plist for install instructions.
# (cron was flaky here: the cron daemon failed to cd into ~/Documents for this
# job even though it can for others — launchd avoids the quirk entirely.)
#
# arena:tick auto-evolves every ARENA_EVOLVE_EVERY (default 50) ticks, so a 5-min
# cadence breeds a new generation roughly every ~4h and the allocator can then be
# run against an increasingly proven population.
set -u
# Operate on the checkout this script lives in (NOT a hardcoded path) — so the
# launchd runtime at ~/hft-live ticks ITS db, and a dev run from HFT-work ticks
# HFT-work's. ${0:A:h:h} = absolute repo root (parent of scripts/). zsh-only.
REPO="${0:A:h:h}"
LOCK="/tmp/hft-arena-cron.lock"
cd "$REPO" || exit 1

if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "$(date '+%F %T') skip — previous arena cycle still running"
  exit 0
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

echo "=== $(date '+%F %T') arena cycle ==="
npm run --silent worker:snapshot
npm run --silent arena:tick

# Build the real Polymarket L2 capture time series (handbook Data layer) so the
# AS market-maker's β_OFI/κ/σ_b can be calibrated on real microstructure over time.
npx tsx scripts/capture-l2.ts --markets 12 2>&1 | tail -1

# Auto-allocate every ALLOCATE_EVERY cycles (default 12 ≈ hourly at 5-min cadence)
# so the funded capsule set tracks the evolving leaderboard. Funds only proven
# positive-fitness agents; on early cycles that may be zero (correct discipline).
ALLOCATE_EVERY="${ALLOCATE_EVERY:-12}"
ALLOC_BUDGET="${ARENA_ALLOC_BUDGET:-10000}"
COUNTER_FILE="/tmp/hft-arena-cycle-count"
n=$(( $(cat "$COUNTER_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$COUNTER_FILE"
if [ "$ALLOCATE_EVERY" -gt 0 ] && [ $(( n % ALLOCATE_EVERY )) -eq 0 ]; then
  echo "--- cycle $n: auto-allocate (budget \$$ALLOC_BUDGET) ---"
  npx tsx scripts/arena-allocate.ts --commit --create-capsules \
    --budget "$ALLOC_BUDGET" --min-trades 1 --min-fitness 0.00001 2>&1 | grep -E 'funded [0-9]|CAPSULES|COMMITTED'
fi

# Re-target as markets change: every RESEARCH_EVERY cycles (default 24 ≈ 2h at
# 5-min cadence), re-derive regime/event/arb conditions and seed a bounded batch
# of matched agents. Population-capped; arena:evolve culls the weak.
RESEARCH_EVERY="${RESEARCH_EVERY:-24}"
if [ "$RESEARCH_EVERY" -gt 0 ] && [ $(( n % RESEARCH_EVERY )) -eq 0 ]; then
  echo "--- cycle $n: signal scan (refresh proven-winner pool + opportunity signals) ---"
  # scan-leaderboard refreshes tracked_wallets (Polymarket's sustained top traders);
  # the opportunity scanners emit strategy-opportunity signals into evolution_log
  # (what AgentContext / the oracle / research read). Each is single-pass + cheap.
  for sc in scan-leaderboard scan-near-resolution scan-cross-timeframe scan-orderbook-imbalance; do
    npx tsx "scripts/$sc.ts" 2>&1 | tail -1
  done
  echo "--- cycle $n: research-refresh (re-target on current market conditions) ---"
  npx tsx scripts/research-refresh.ts --limit 12 2>&1 | grep -E 'regime|seeded|skip'
  echo "--- cycle $n: calibration (grade gates vs realized PnL) ---"
  npx tsx scripts/calibration-report.ts --days 30 2>&1 | grep -E 'labeled|calibrated|PROBLEM|accruing'
fi
