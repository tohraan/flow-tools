# Decisions

Newest first.

## 2026-10-30: Completion without a % marker; owner resume goes through a Flow check

- Evidence: a read-only CDP observer during a live run saw tile labels 0%→100% within 25 s, then new images at `flow-content.google/image/…`, while three "40%" strings from prompt text stayed on the page forever. The earlier timeouts were false negatives; the 29 Oct batches are in the Flow library.
- A fresh batch at the top of the grid that is stable for 3 polls counts as complete even if no % was seen. Old tiles that scroll into view land below known ones, so they cannot qualify. Rejected: dropping the freshness check, or matching any large image.
- The portal's Resume Flow does not clear the pause by itself. The daemon looks at Flow first and refuses on a warning, sign-in page, failed card, wrong page or missing prompt box, and says why on the portal. Rejected: auto-resume on a timer (a provider warning must not be retried blindly).

## 2026-10-28: Provider blocks require explicit recovery

- Confirmed from installed LaunchAgent: production still uses daemon v1. Logs show repeated child timeouts and a completion message followed by failed download. The generator never inspected warning text and reported success after its deadline; this can select an older output. Dedicated profile Preferences has no registered extension entries. This does not prove Google's trigger.
- Google documents this exact warning at https://support.google.com/flow/answer/16353333?hl=en and recommends waiting a couple of minutes and disabling VPNs/proxies (checked 28 Oct 2026).
- Persist a local pause on unusual activity, limits, failed tiles, or an uncertain outcome. Both daemon versions check in without claiming new work. Resume only after an operator confirms a successful manual generation; no timed retry of a protection warning.
- Success requires observed progress ending with a loaded, fresh Flow output. Compare asset identities independent of thumbnail size/query. Fail closed if Flow changes its output URL scheme.
- Keep v1 installed; do not deploy the unrelated unmerged resilience branch or its migrations. Lower v2 default concurrency to one for the later upgrade.
- Rejected input camouflage, fingerprint/proxy rotation, blind retries, and promises that the provider warning can never recur. No browser profile reset, extension disabling, security setting change, or Google generation is performed by this repair.
- Remaining: manual recovery test in the affected Flow window. If it still fails, provider/account/network diagnosis is needed; the local worker cannot clear Google's block.

## 2026-10-27: A sleeping Mac is a wait, not a failure

- **Requirement:** images are made whether the laptop is open or closed, and the portal never shows an error because the Mac was away. Email should reach the owner when a human is needed.
- **Root cause found:** the installed LaunchAgent ran daemon v1, which didn't launch Chrome or check readiness. Nothing was listening on port 9222, so `flow-generate` threw `fetch failed`, each failure burned an attempt, and requests failed after 3-4 tries.
- **Decision (Mac side):** v2 daemon + three LaunchAgents (daemon, Chrome-at-login, watchdog); wake detection and timeouts instead of trusting sockets across sleep; setup problems are reported as "not ready" and claim nothing.
- **Decision (one story):** every source writes the same structured events (`kind`, `request_id`, `run_id`, `seq`). The Mac keeps a disk outbox and flushes it on reconnect; the portal's `flow_events` is idempotent on (worker, run_id, seq). Rejected: logging only on the Mac (portal can't show why), or only on the portal (loses everything that happens while offline).
- **Decision (lid closed):** two supported modes. *Queue and catch up* is the default and needs nothing. *Away mode* (`pmset disablesleep 1`, charger only) is opt-in because a closed running laptop gets hot and drains battery. Rejected: a cloud/always-on machine (no hardware, and a second Google login on a new device is a risk).
- **Decision (alerts):** the portal sends email (the Mac may be down). Gmail SMTP via an app password. Thresholds and dedupe are in the portal repo's `src/lib/alerts/flow-alerts.ts`.
- **Needs the portal change:** `flow-resilience` (leases, `/api/flow-queue/events`, waiting-not-failing). Keep v1 only for an un-upgraded portal.
