#!/bin/bash
# Double-click this file in Finder to QA every image already in your Flow
# project and add the good ones to LinkedIn Command Center's image library
# (failed ones are kept too, with notes on why). Safe to run again later —
# it skips everything the library already has. The Flow daemon pauses while
# this runs, since both drive the same Chrome tab.
#
# Needs: Chrome started with flow-launch-chrome.sh and signed into Flow, and
# install-daemon.command run once (it saves the app URL + secret this uses).
# Optional: drag this file onto Terminal and add --limit 20 to try a few first.
set -euo pipefail
cd "$(dirname "$0")"

NODE_PATH="$(command -v node || true)"
if [ -z "$NODE_PATH" ]; then
  echo "Could not find 'node' on PATH. Install Node 22+ first."
  read -p "Press Enter to close this window..."
  exit 1
fi

if ! curl -s http://127.0.0.1:9222/json/version >/dev/null; then
  echo "Chrome isn't running with the automation port. Run ./flow-launch-chrome.sh, sign into Flow, then try again."
  read -p "Press Enter to close this window..."
  exit 1
fi

"$NODE_PATH" flow-harvest.mjs "$@" || true
echo ""
read -p "Press Enter to close this window..."
