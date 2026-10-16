#!/bin/bash
# flow-launch-chrome.sh
# Opens a SEPARATE Chrome window using a dedicated automation profile with
# the remote-debugging port enabled. Modern Chrome silently refuses to open
# the debug port on your normal default profile (anti-hijacking hardening),
# so this uses its own profile dir instead. First run: you'll need to log
# into Google once in this window (Touch ID / saved-password autofill with
# your mouse works fine — no keyboard needed). After that it's remembered.
set -e
PROFILE_DIR="$HOME/flow-tools/chrome-profile"
mkdir -p "$PROFILE_DIR"
open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="$PROFILE_DIR" "https://labs.google/fx/tools/flow"
echo "Chrome launched (separate automation profile) with remote debugging on port 9222."
echo "First time: log into Google in that window (mouse/Touch ID, no typing needed)."
echo "Then click into the Flow prompt box, and run flow-type.mjs"
