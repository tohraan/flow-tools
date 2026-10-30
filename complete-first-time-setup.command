#!/bin/bash
# One-time setup, one double-click: uploads the 5 reference-expression
# photos as named Characters, then installs + starts the Flow daemon as
# a persistent macOS LaunchAgent. Run this once; everything after is
# automatic.
#
# Prerequisite: Chrome must already be running with Flow open and
# logged in — run flow-launch-chrome.sh first if it isn't.
set -euo pipefail
cd "$(dirname "$0")"

if ! curl -s http://127.0.0.1:9222/json/version > /dev/null 2>&1; then
  echo "Chrome debug port not up."
  echo "Run flow-launch-chrome.sh first (double-click it or: bash flow-launch-chrome.sh),"
  echo "make sure Flow is open and you're logged in, then run this again."
  read -p "Press Enter to close this window..."
  exit 1
fi

PHOTOS="$HOME/Downloads/download (1) 2"

echo "=== Step 1/2: uploading 5 reference photos as Characters ==="
node flow-upload-reference.mjs "$PHOTOS/Man_wearing_glasses_frowning_20261016191347.jpg" --name "tohraan-frowning"
node flow-upload-reference.mjs "$PHOTOS/Man_thinking_portrait_20261016191347.jpg" --name "tohraan-thinking"
node flow-upload-reference.mjs "$PHOTOS/Man_smiling_in_studio_portrait_20261016191347.jpg" --name "tohraan-smiling"
node flow-upload-reference.mjs "$PHOTOS/Man_wearing_glasses_portrait_20261016191347.jpg" --name "tohraan-neutral"
node flow-upload-reference.mjs "$PHOTOS/Man_talking_in_portrait_20261016191347.jpg" --name "tohraan-talking"

echo ""
echo "=== Step 2/2: installing the Flow daemon (auto-starts on login from now on) ==="
bash "$(dirname "$0")/install-daemon.command"

echo ""
echo "Setup complete. Characters uploaded: tohraan-frowning, tohraan-thinking,"
echo "tohraan-smiling, tohraan-neutral, tohraan-talking."
echo "Daemon is running. Queue an image from Studio's Flow prompt panel whenever you want one."
echo ""
read -p "Press Enter to close this window..."
