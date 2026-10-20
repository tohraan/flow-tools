#!/bin/bash
# Double-click this file in Finder to install and start the Flow daemon
# as a macOS LaunchAgent — runs persistently, survives reboots, no
# terminal typing needed. One click, that's the whole install.
set -euo pipefail
cd "$(dirname "$0")"

PLIST_DEST="$HOME/Library/LaunchAgents/com.tohraan.flow-daemon.plist"
FLOW_TOOLS_DIR="$HOME/flow-tools"
ENV_FILE="$FLOW_TOOLS_DIR/.flow-daemon-env"

NODE_PATH="$(command -v node || true)"
if [ -z "$NODE_PATH" ]; then
  echo "Could not find 'node' on PATH. Install Node 22+ first, or edit NODE_PATH in this script."
  read -p "Press Enter to close this window..."
  exit 1
fi

# FLOW_APP_URL / FLOW_DAEMON_SECRET are never hardcoded here or committed —
# they're your own deployed app's URL and its shared daemon secret, saved
# once to .flow-daemon-env (gitignored, same pattern as .flow-project-url).
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

if [ -z "${FLOW_APP_URL:-}" ]; then
  read -p "Flow app URL (e.g. https://your-app.vercel.app): " FLOW_APP_URL
fi
if [ -z "${FLOW_DAEMON_SECRET:-}" ]; then
  read -p "FLOW_DAEMON_SECRET (must match the app's env var): " FLOW_DAEMON_SECRET
fi

cat > "$ENV_FILE" <<EOF
FLOW_APP_URL=$FLOW_APP_URL
FLOW_DAEMON_SECRET=$FLOW_DAEMON_SECRET
EOF

mkdir -p "$HOME/Library/LaunchAgents"

sed \
  -e "s|/usr/local/bin/node|$NODE_PATH|" \
  -e "s|FLOW_TOOLS_DIR|$FLOW_TOOLS_DIR|" \
  -e "s|APP_URL_HERE|$FLOW_APP_URL|" \
  -e "s|SECRET_HERE|$FLOW_DAEMON_SECRET|" \
  "$FLOW_TOOLS_DIR/flow-daemon.plist.example" > "$PLIST_DEST"

launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"

echo ""
echo "Flow daemon installed and started."
echo "It will auto-start on every login from now on."
echo "Logs: /tmp/flow-daemon.log and /tmp/flow-daemon.error.log"
echo ""
echo "Make sure Chrome is running via flow-launch-chrome.sh with Flow logged in"
echo "before queuing any requests — the daemon needs that to actually generate."
echo ""
read -p "Press Enter to close this window..."
