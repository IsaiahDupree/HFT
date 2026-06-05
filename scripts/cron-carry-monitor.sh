#!/bin/zsh -l
# cron-carry-monitor — hourly poll of the live carry surface (HL / dYdX / Deribit). Each run logs a snapshot
# per candidate + an escalation alert (off→watch→armed) to a LOCAL SQLite DB on the My Passport drive, so you
# are told the moment a carry crosses its deploy trigger — no screen-watching, survives reboot (launchd).
#
# Install (launchd): cp ops/com.hft.carry-monitor.plist ~/Library/LaunchAgents/ && \
#                    launchctl load ~/Library/LaunchAgents/com.hft.carry-monitor.plist
# Check alerts:      npm run carry:monitor -- --show
#
# Env: HFT_REPO (runtime checkout, default this repo). CARRY_DB_PATH (default /Volumes/My Passport/hft-data/...).
set -e
SCRIPT_DIR="${0:A:h}"
REPO="${HFT_REPO:-${SCRIPT_DIR:h}}"
cd "$REPO" || { echo "cron-carry-monitor: cannot cd to $REPO" >&2; exit 1; }
echo "[$(date -u +%FT%TZ)] cron-carry-monitor · repo $REPO · db ${CARRY_DB_PATH:-auto}"
exec npx tsx scripts/carry-monitor.ts
