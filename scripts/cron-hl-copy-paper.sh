#!/bin/zsh -l
# cron-hl-copy-paper — daily survivorship-free forward test of the HL smart-money consensus. Grades the prior
# snapshot vs realized price, records a fresh one → accumulates a genuine OOS track record in SQLite on My Passport.
# Install: cp ops/com.hft.hl-copy-paper.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.hft.hl-copy-paper.plist
# Check:   npm run hl:copy-paper -- --show
set -e
SCRIPT_DIR="${0:A:h}"
REPO="${HFT_REPO:-${SCRIPT_DIR:h}}"
cd "$REPO" || { echo "cron-hl-copy-paper: cannot cd to $REPO" >&2; exit 1; }
echo "[$(date -u +%FT%TZ)] cron-hl-copy-paper · repo $REPO · db ${COPY_DB_PATH:-auto}"
exec npx tsx scripts/hl-copy-paper.ts
