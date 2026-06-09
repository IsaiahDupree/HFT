#!/bin/zsh -l
# cron-wallet-forward — daily forward accrual for the wallet-copy program. One run:
#   1. hl:netbook-paper   — grade yesterday's mirrored net book against today's prices, snapshot fresh book
#   2. hl:wallet-track    — refresh dossiers + longitudinal snapshot (drift study) for the top leaderboard
#   3. hl:move-watch      — one poll, logging moves since the last poll (the live-copy signal tape)
# Accrued daily this builds the out-of-sample record that `npm run hl:copy-sim -- --forward` replays — the
# ONLY predictive curve. Run once a day. Dry-run throughout; nothing here sends an order.
#
# Install (launchd): cp ops/com.hft.wallet-forward.plist ~/Library/LaunchAgents/ && \
#                    launchctl load ~/Library/LaunchAgents/com.hft.wallet-forward.plist
# Check the track:   npm run hl:netbook-paper -- --show   &&   npm run hl:copy-sim -- --forward
#
# Env: HFT_REPO (default: this script's repo). NOTE: cron/launchd needs Full Disk Access to reach
#      /Volumes/My Passport (System Settings → Privacy → Full Disk Access → add /bin/zsh or cron).
set -e
SCRIPT_DIR="${0:A:h}"
REPO="${HFT_REPO:-${SCRIPT_DIR:h}}"
cd "$REPO" || { echo "cron-wallet-forward: cannot cd to $REPO" >&2; exit 1; }
echo "[$(date -u +%FT%TZ)] cron-wallet-forward · repo $REPO"
npx tsx scripts/hl-netbook-paper.ts || echo "netbook-paper failed (continuing)"
npx tsx scripts/hl-wallet-track.ts --top 60 --days 30 || echo "wallet-track failed (continuing)"
npx tsx scripts/hl-move-watch.ts || echo "move-watch failed (continuing)"
echo "[$(date -u +%FT%TZ)] cron-wallet-forward done"
