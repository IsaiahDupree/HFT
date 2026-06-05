#!/bin/zsh -l
# cron-record-dydx — continuous dYdX L2 recorder feeding the MM gauntlet (backtest:dydx:mm).
# Records in CHUNKS, appending to data/captures-dydx/<today>/<market>.ws.jsonl; launchd KeepAlive
# (or a watchdog loop) restarts it on exit, and at UTC day rollover a fresh dir is used. The more
# it accumulates, the more maker fills the gauntlet sees → REPAIR_FIRST becomes a real verdict.
#
# Install (launchd):  cp ops/com.hft.dydx-recorder.plist ~/Library/LaunchAgents/ && \
#                     launchctl load ~/Library/LaunchAgents/com.hft.dydx-recorder.plist
# Or ad-hoc:          nohup ./scripts/cron-record-dydx.sh >> /tmp/dydx-recorder.log 2>&1 &
#
# Env (optional): HFT_REPO (default: this script's repo), DYDX_MARKETS, DYDX_CHUNK_SEC.
set -e
SCRIPT_DIR="${0:A:h}"
REPO="${HFT_REPO:-${SCRIPT_DIR:h}}"
MARKETS="${DYDX_MARKETS:-BTC-USD,ETH-USD,SOL-USD}"
CHUNK="${DYDX_CHUNK_SEC:-1800}"   # 30 min per chunk
cd "$REPO" || { echo "cron-record-dydx: cannot cd to $REPO" >&2; exit 1; }
echo "[$(date -u +%FT%TZ)] cron-record-dydx: $MARKETS · ${CHUNK}s chunk · repo $REPO"
exec npx tsx scripts/record-l2-dydx.ts --markets "$MARKETS" --duration "$CHUNK"
