#!/bin/zsh -l
# cron-carry-paper — daily forward paper-trade snapshot of the carry book. Each run evaluates the
# prior day's expected-vs-realized and logs a fresh snapshot → data/paper/carry-log.jsonl. Run once
# a day (after Binance funding settles, ~00:30 UTC) to accumulate a real out-of-sample track.
#
# Install (launchd): cp ops/com.hft.carry-paper.plist ~/Library/LaunchAgents/ && \
#                    launchctl load ~/Library/LaunchAgents/com.hft.carry-paper.plist
# Check the track:   npm run carry:paper-snapshot -- --show
#
# Env: HFT_REPO (default: this script's repo — needs .env.local with the proxy creds).
set -e
SCRIPT_DIR="${0:A:h}"
REPO="${HFT_REPO:-${SCRIPT_DIR:h}}"
cd "$REPO" || { echo "cron-carry-paper: cannot cd to $REPO" >&2; exit 1; }
echo "[$(date -u +%FT%TZ)] cron-carry-paper · repo $REPO"
exec npx tsx scripts/carry-paper-snapshot.ts
