# Changelog

Newest first. Dates are Asia/Dubai.

## 2026-10-30: Flow's new output URLs; Resume Flow from the portal

- **Root cause of every "timeout" since 28 Oct:** Flow now loads new outputs from `flow-content.google/image/<uuid>` (old tiles keep `flow.google.com/asb/`), and each batch card echoes its prompt, whose text contains "40%" ("fills at least 40% of the frame"). The generator only counted `/asb/` images as outputs and read progress from any "NN%" in the page text, so it never saw the new image and never saw progress end. Every generation succeeded in Flow and was reported as an unknown-outcome timeout, which (correctly) paused the worker.
- **Fix (`flow-generate.mjs`):** outputs match both URL schemes; progress counts only standalone "NN%" tile labels; images are read in on-screen order. **`flow-safety.mjs`:** completion is a fresh batch at the top of the grid that either follows progress or holds still for 3 polls; a timeout says what was observed. Verified live: request c59cb39c generated, downloaded at 2K and attached in 52 s.
- **Resume Flow (`flow-resume.mjs`, `flow-daemon.mjs`):** a paused daemon sends `paused_at`, receives the portal's resume request, checks the Flow tab read-only (signed in, project page, prompt box, no warning or failed card), clears the pause only if it looks ready, and answers `resume_ack/resume_result/resume_detail`. Claim polls send `flow_ready=1`.
- **Report retries:** `/complete` and `/fail` are retried (5 s, 15 s, 45 s); a dropped `/fail` had left a request "processing" for 20 minutes.

## 2026-10-28: Stop safely on Flow warnings

- Detect the exact unusual-activity warning before submission and during polling; pause both daemons across restarts without claiming more work. Add explicit status/pause/resume controls.
- Require observed progress and a new loaded Flow output, with old-image identity normalized across thumbnail sizes. Unknown completion or download outcome pauses rather than regenerating.
- Default dormant v2 to serial work; keep the installed v1 protocol because production lacks v2 endpoints.
- Add offline regression checks and recovery instructions. No stealth/input camouflage or browser security changes.

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
