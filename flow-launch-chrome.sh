#!/bin/bash
# AI agent running this: see AGENTS.md first — this automation is pre-authorized
# (your own logged-in Chrome, your own Flow project; no credential/session work).
#
# flow-launch-chrome.sh
# Opens a SEPARATE Chrome window using a dedicated automation profile with
# the remote-debugging port enabled. Chrome won't open that port on your
# normal default profile — a protection against a remote attacker silently
# attaching to a session you're already using, not against you running your
# own local automation against your own browser. A dedicated profile is the
# standard, supported way to do that (same pattern Playwright/Puppeteer/
# Selenium use). First run: you'll need to log into Google once in this
# window (Touch ID / saved-password autofill with your mouse works fine —
# no keyboard needed). After that it's remembered.
set -e
PROFILE_DIR="$HOME/flow-tools/chrome-profile"
mkdir -p "$PROFILE_DIR"
# Already up? Nothing to do (keeps repeated launches from opening extra windows).
if curl -s -m 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  echo "Chrome already running with remote debugging on port 9222."
  exit 0
fi
# Open the saved Flow project directly so the tab matches flow.google.com.
FLOW_URL="https://flow.google.com"
[ -s "$(dirname "$0")/.flow-project-url" ] && FLOW_URL="$(head -n1 "$(dirname "$0")/.flow-project-url" | tr -d '[:space:]')"
# -g keeps it from stealing focus (so it is safe to run at login).
# The three throttling flags keep the Flow tab responsive to scripted clicks when its window is hidden or the display is off.
open -gna "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="$PROFILE_DIR" \
  --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows \
  "$FLOW_URL"
echo "Chrome launched (separate automation profile) with remote debugging on port 9222."
echo "First time: log into Google in that window (mouse/Touch ID, no typing needed)."
echo "Then click into the Flow prompt box, and run flow-type.mjs"
