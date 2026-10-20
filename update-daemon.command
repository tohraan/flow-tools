#!/bin/bash
# Double-click this file in Finder to pull the latest flow-tools code and
# restart the already-installed Flow daemon LaunchAgent so it picks the
# update up. Run install-daemon.command first if the daemon isn't
# installed yet — this script only updates and restarts, it doesn't
# create the LaunchAgent.
set -euo pipefail
cd "$(dirname "$0")"

PLIST_DEST="$HOME/Library/LaunchAgents/com.tohraan.flow-daemon.plist"

if [ ! -f "$PLIST_DEST" ]; then
  echo "No installed daemon found at $PLIST_DEST — run install-daemon.command first."
  read -p "Press Enter to close this window..."
  exit 1
fi

echo "Pulling latest flow-tools..."
git pull --ff-only

echo "Restarting the Flow daemon..."
launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"

echo ""
echo "Updated and restarted. Logs: /tmp/flow-daemon.log and /tmp/flow-daemon.error.log"
echo ""
read -p "Press Enter to close this window..."
