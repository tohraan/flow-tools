#!/bin/bash
# flow-away-mode.command — keep the Mac awake with the lid CLOSED so Flow images keep being made.
#
#   ./flow-away-mode.command on       lid closed no longer sleeps the Mac (needs your password)
#   ./flow-away-mode.command off      back to normal sleep behaviour
#   ./flow-away-mode.command status   show whether it is on, plus power source and battery
#
# Double-click with no argument and it asks. Use it on the charger: a closed laptop in a bag gets hot,
# and on battery it will drain flat. The watchdog logs a warning to the portal if it is on and
# the battery falls under 20%. Turn it off when you travel.
set -e
cmd="${1:-}"
if [ -z "$cmd" ]; then
  read -p "Away mode: on, off or status? " cmd
fi
case "$cmd" in
  on)
    if ! pmset -g batt | grep -q "AC Power"; then
      echo "Warning: you are on battery. Away mode on battery drains it flat. Plug in first."
      read -p "Turn it on anyway? [y/N] " yn
      [ "$yn" = "y" ] || exit 0
    fi
    sudo pmset -a disablesleep 1
    echo "Away mode ON. Closing the lid will not sleep this Mac. Run '$0 off' when you leave."
    ;;
  off)
    sudo pmset -a disablesleep 0
    echo "Away mode OFF. Normal sleep restored."
    ;;
  status)
    if pmset -g | grep -Eq "SleepDisabled[[:space:]]+1"; then echo "Away mode: ON"; else echo "Away mode: off"; fi
    pmset -g batt | head -2
    ;;
  *) echo "Usage: $0 on|off|status"; exit 1 ;;
esac
[ -t 0 ] && [ -z "${1:-}" ] && read -p "Press Enter to close..."
exit 0
