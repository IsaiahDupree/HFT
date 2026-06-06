#!/bin/zsh -l
# cron-consensus-paper — FORWARD, survivorship-free test of the Polymarket consensus edge. Records live
# consensus signals on OPEN markets + grades prior ones on INDEPENDENT resolution → the only non-circular test.
# Install: cp ops/com.hft.consensus-paper.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.hft.consensus-paper.plist
# Check:   npm run consensus:paper -- --show
set -e
SCRIPT_DIR="${0:A:h}"; REPO="${HFT_REPO:-${SCRIPT_DIR:h}}"
cd "$REPO" || { echo "cron-consensus-paper: cannot cd to $REPO" >&2; exit 1; }
echo "[$(date -u +%FT%TZ)] cron-consensus-paper · repo $REPO"
exec npx tsx scripts/consensus-paper.ts
