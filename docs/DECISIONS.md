# Decisions

Newest first.

## 2026-10-27: A sleeping Mac is a wait, not a failure

- **Requirement:** images are made whether the laptop is open or closed, and the portal never shows an error because the Mac was away. Email should reach the owner when a human is needed.
- **Root cause found:** the installed LaunchAgent ran daemon v1, which didn't launch Chrome or check readiness. Nothing was listening on port 9222, so `flow-generate` threw `fetch failed`, each failure burned an attempt, and requests failed after 3-4 tries.
- **Decision (Mac side):** v2 daemon + three LaunchAgents (daemon, Chrome-at-login, watchdog); wake detection and timeouts instead of trusting sockets across sleep; setup problems are reported as "not ready" and claim nothing.
- **Decision (one story):** every source writes the same structured events (`kind`, `request_id`, `run_id`, `seq`). The Mac keeps a disk outbox and flushes it on reconnect; the portal's `flow_events` is idempotent on (worker, run_id, seq). Rejected: logging only on the Mac (portal can't show why), or only on the portal (loses everything that happens while offline).
- **Decision (lid closed):** two supported modes. *Queue and catch up* is the default and needs nothing. *Away mode* (`pmset disablesleep 1`, charger only) is opt-in because a closed running laptop gets hot and drains battery. Rejected: a cloud/always-on machine (no hardware, and a second Google login on a new device is a risk).
- **Decision (alerts):** the portal sends email (the Mac may be down). Gmail SMTP via an app password. Thresholds and dedupe are in the portal repo's `src/lib/alerts/flow-alerts.ts`.
- **Needs the portal change:** `flow-resilience` (leases, `/api/flow-queue/events`, waiting-not-failing). Keep v1 only for an un-upgraded portal.
