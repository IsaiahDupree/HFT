#!/bin/zsh -l
# Continuous arena loop — runs one arena-cron cycle every INTERVAL seconds so
# real fitness accrues over time. Intended to be launched with nohup:
#
#   nohup /bin/zsh -l scripts/arena-loop.sh 300 >> /tmp/hft-arena-loop.log 2>&1 &
#   echo $! > /tmp/hft-arena-loop.pid          # remember the PID to stop later
#   kill "$(cat /tmp/hft-arena-loop.pid)"      # stop the loop
#
# Prefer a real crontab entry (see scripts/arena-cron.sh) for durability across
# reboots; this loop is the quick "start accruing now" option.
set -u
INTERVAL="${1:-300}"
REPO="/Users/isaiahdupree/Documents/Software/HFT-work"
echo "$(date '+%F %T') arena-loop started — every ${INTERVAL}s"
while true; do
  /bin/zsh -l "$REPO/scripts/arena-cron.sh"
  sleep "$INTERVAL"
done
