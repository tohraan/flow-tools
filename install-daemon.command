#!/bin/bash
# Double-click this file in Finder to install and start the Flow daemon
# as a macOS LaunchAgent — runs persistently, survives reboots, no
# terminal typing needed. One click, that's the whole install.
set -euo pipefail
cd "$(dirname "$0")"

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

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Flow/logs"

# Three LaunchAgents: the daemon (generates images), Chrome-at-login, and the watchdog.
for pair in "flow-daemon:flow-daemon.plist.example" "flow-chrome:flow-chrome.plist.example" "flow-watchdog:flow-watchdog.plist.example"; do
  name="${pair%%:*}"; example="${pair##*:}"
  dest="$HOME/Library/LaunchAgents/com.tohraan.$name.plist"
  sed \
    -e "s|/usr/local/bin/node|$NODE_PATH|" \
    -e "s|FLOW_TOOLS_DIR|$FLOW_TOOLS_DIR|" \
    -e "s|APP_URL_HERE|$FLOW_APP_URL|" \
    -e "s|SECRET_HERE|$FLOW_DAEMON_SECRET|" \
    "$FLOW_TOOLS_DIR/$example" > "$dest"
  launchctl unload "$dest" 2>/dev/null || true
  launchctl load "$dest"
done

echo ""
echo "Flow daemon installed and started."
echo "It will auto-start on every login from now on."
echo "Logs: ~/Flow/logs/*.jsonl (structured), /tmp/flow-daemon.log, /tmp/flow-watchdog.log"
echo "Also installed: Chrome-at-login and a watchdog that restarts a hung daemon."
echo "Lid closed? Run ./flow-away-mode.command on (on the charger)."
echo ""
echo "Make sure Chrome is running via flow-launch-chrome.sh with Flow logged in"
echo "before queuing any requests — the daemon needs that to actually generate."
echo ""
read -p "Press Enter to close this window..."
