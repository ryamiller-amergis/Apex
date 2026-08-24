#!/usr/bin/env bash
# Poor-man's log retention for ca-apex-repo-read-dev.
#
# The environment retains nothing and `logs show --follow` buffers when its
# output is redirected, so the container's dying words are lost by the time we
# know to look. Polling the non-follow form does flush, so this appends
# snapshots and tolerates the resulting duplicates: every line carries its own
# TimeStamp, so dedup happens at read time. Enabling real retention means
# setting log_analytics_workspace_id on the environment, which can force a
# replacement that would take both container apps with it.
set -uo pipefail
cd "$(dirname "$0")"
RG=rg-scrum-dev
APP=ca-apex-repo-read-dev

while true; do
  STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  {
    echo "===== poll $STAMP ====="
    az containerapp logs show -g "$RG" -n "$APP" --type console --tail 40 2>&1
  } >> console-poll.log
  {
    echo "===== poll $STAMP ====="
    az containerapp logs show -g "$RG" -n "$APP" --type system --tail 40 2>&1
  } >> system-poll.log
  {
    echo -n "$STAMP restarts="
    az containerapp replica list -g "$RG" -n "$APP" \
      --query "[].properties.containers[0].restartCount" -o tsv 2>&1 | tr -d '\r\n'
    echo -n " state="
    az containerapp replica list -g "$RG" -n "$APP" \
      --query "[].properties.containers[0].runningStateDetails" -o tsv 2>&1 | tr -d '\r\n'
    echo ""
  } >> restarts.log
  sleep 20
done
