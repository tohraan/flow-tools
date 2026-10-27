# Changelog

Newest first. Dates are Asia/Dubai.

## 2026-10-27: Unattended running (sleep, wake, logs, alerts)

- **Chrome self-start (`flow-lib.mjs` `ensureFlow`, `flow-launch-chrome.sh`, `com.tohraan.flow-chrome`):** scripts and login start the automation Chrome and open the saved Flow project; launch is idempotent, backgrounded, and uses the project URL (`flow.google.com`) instead of the old `labs.google` URL that the scripts' tab match never saw.
- **Daemon v2 hardening (`flow-daemon-v2.mjs`):** wake detection (60 s gap), 8 s network settle, readiness transitions logged, signed-out detection, `~/Flow/heartbeat`, portal-reachability logging.
- **Timeouts (`flow-lib.mjs` `portal()`, storage PUT):** every portal call has an AbortSignal timeout.
- **Structured log + outbox (`flow-log.mjs`):** JSONL per day, human build-log line, and ordered, idempotent delivery to the portal's `flow_events` after offline stretches.
- **Watchdog (`flow-watchdog.mjs`, `flow-watchdog.plist.example`):** restarts a hung daemon; reports away-mode low battery.
- **Away mode (`flow-away-mode.command`):** `pmset disablesleep` toggle for lid-closed running on the charger.
- **Chrome flags:** background-throttling disabled so a hidden Flow tab still takes scripted clicks.
- **Installers/templates:** `flow-daemon.plist.example` is now v2 + `caffeinate -i`; `install-daemon.command` / `update-daemon.command` manage all three agents.
- **Docs:** README "Running unattended", AGENTS.md section, this file and `docs/DECISIONS.md`.
