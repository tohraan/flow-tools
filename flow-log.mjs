// flow-log.mjs — one structured log for the daemon and the watchdog.
//
// Every event is written three ways so the story is the same everywhere:
//   1. ~/Flow/logs/<source>-YYYY-MM-DD.jsonl   full local record (kept 14 days)
//   2. ~/Flow/build-log.md                     the human-readable line the old logs had
//   3. the portal's flow_events table          through ~/Flow/outbox.jsonl
// The outbox is the point: while the Mac is asleep or offline the portal can't be
// reached, so events queue on disk and are flushed, in order, when it is back. The
// portal ignores a re-sent event (unique on worker, run_id, seq), so a flush that
// dies half-way is safe to repeat.

import { appendFile, readFile, writeFile, mkdir, readdir, unlink, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const FLOW_DIR = path.join(homedir(), 'Flow');
const LOG_DIR = path.join(FLOW_DIR, 'logs');
const BUILD_LOG = path.join(FLOW_DIR, 'build-log.md');
const RETENTION_DAYS = 14;
const MAX_OUTBOX_BYTES = 5 * 1024 * 1024; // drop the oldest events rather than fill the disk during a very long outage
const BATCH = 100;

export function createLogger({ source = 'daemon', worker, getApi, outboxName = 'outbox.jsonl', quiet = false } = {}) {
  const runId = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const outbox = path.join(FLOW_DIR, outboxName);
  let seq = 0;
  let flushing = false;

  async function log(kind, message, { level = 'info', requestId, detail, human = true } = {}) {
    const at = new Date().toISOString();
    const event = { happened_at: at, level, kind, message: String(message).slice(0, 1000), seq: seq++ };
    if (requestId) event.request_id = requestId;
    if (detail) event.detail = detail;
    if (!quiet) (level === 'error' ? console.error : console.log)(`${at} [${kind}] ${requestId ? `[${requestId}] ` : ''}${message}`);
    try {
      await mkdir(LOG_DIR, { recursive: true });
      await appendFile(path.join(LOG_DIR, `${source}-${at.slice(0, 10)}.jsonl`), `${JSON.stringify({ ...event, source, worker, run_id: runId })}\n`);
      await appendFile(outbox, `${JSON.stringify({ source, worker, run_id: runId, event })}\n`);
      if (human) await appendFile(BUILD_LOG, `\n[${source}] ${at} — ${requestId ? `[${requestId}] ` : ''}${message}`);
    } catch {}
  }

  /** Sends everything in the outbox. Returns true when the outbox is empty afterwards. */
  async function flush() {
    const api = getApi?.();
    if (!api || flushing) return false;
    flushing = true;
    try {
      let raw;
      try { raw = await readFile(outbox, 'utf8'); } catch { return true; }
      const lines = raw.split('\n').filter(Boolean);
      if (!lines.length) return true;
      const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      let sent = 0;
      // One request per (source, worker, run_id) group, in order, BATCH at a time.
      const groups = new Map();
      for (const p of parsed) {
        const key = `${p.source}|${p.worker}|${p.run_id}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      }
      for (const items of groups.values()) {
        for (let i = 0; i < items.length; i += BATCH) {
          const slice = items.slice(i, i + BATCH);
          await api.postJson('/api/flow-queue/events', { source: slice[0].source, worker: slice[0].worker, run_id: slice[0].run_id, events: slice.map((s) => s.event) });
          sent += slice.length;
        }
      }
      // Keep anything logged while we were sending.
      const now = (await readFile(outbox, 'utf8').catch(() => '')).split('\n').filter(Boolean);
      await writeFile(outbox, now.slice(lines.length).join('\n') + (now.length > lines.length ? '\n' : ''));
      return sent === parsed.length;
    } catch {
      return false; // offline, asleep, or the portal is down: they stay queued
    } finally {
      flushing = false;
    }
  }

  return { log, flush, runId };
}

/** Deletes logs older than the retention window and trims a runaway outbox. Safe to call at start-up. */
export async function tidyLogs() {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    for (const f of await readdir(LOG_DIR).catch(() => [])) {
      const p = path.join(LOG_DIR, f);
      if ((await stat(p)).mtimeMs < cutoff) await unlink(p).catch(() => {});
    }
    for (const name of ['outbox.jsonl', 'outbox-watchdog.jsonl']) {
      const p = path.join(FLOW_DIR, name);
      const s = await stat(p).catch(() => null);
      if (s && s.size > MAX_OUTBOX_BYTES) {
        const lines = (await readFile(p, 'utf8')).split('\n').filter(Boolean);
        await writeFile(`${p}.tmp`, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
        await rename(`${p}.tmp`, p);
      }
    }
  } catch {}
}
