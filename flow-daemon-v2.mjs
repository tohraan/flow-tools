#!/usr/bin/env node
// flow-daemon-v2.mjs — parallel replacement for flow-daemon.mjs.
//
// What changed from v1 (see LinkedIn Command Center docs/DECISIONS.md, 26 Oct 2026):
//  - up to FLOW_CONCURRENCY (default 4) images at once, each in its own Flow tab;
//  - every claimed request carries a lease the portal reclaims if this process dies;
//    a timer renews it every 30 s while the image generates;
//  - readiness check: if Chrome/Flow isn't reachable, it says so in its heartbeat,
//    tries to launch Chrome (at most every 5 min) and takes NO work — setup
//    problems never burn an image's attempts;
//  - brake: a throttle signal (429, "too many requests", ...) drops concurrency to 1
//    for 15 minutes;
//  - uploads go straight to Storage through a signed URL, then a small finalize call
//    (the old 30 s multipart route is gone from the happy path).
//
// FLOW_FAKE=1 swaps Flow for a fake generator (5-40 s, injected failures) so the
// whole queue can be exercised without spending Flow. FLOW_FAKE_FAIL=0.2 sets the
// share of injected failures.
//
// Env: FLOW_APP_URL, FLOW_DAEMON_SECRET (or .flow-daemon-env), optional
// FLOW_CONCURRENCY, FLOW_POLL_INTERVAL_MS, FLOW_FAKE, FLOW_FAKE_FAIL.

import { writeFile, appendFile, mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir, homedir, hostname } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { harvestLockHeld, hashFile, loadPortalEnv, openHelperTab, portal, sleep } from './flow-lib.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(new URL(import.meta.url).pathname);

const POLL_INTERVAL_MS = Number(process.env.FLOW_POLL_INTERVAL_MS || 15000);
const CONFIGURED = Math.max(1, Math.min(6, Number(process.env.FLOW_CONCURRENCY || 4)));
const FAKE = process.env.FLOW_FAKE === '1';
const FAKE_FAIL = Number(process.env.FLOW_FAKE_FAIL || 0.2);
const FAKE_MIN_MS = Number(process.env.FLOW_FAKE_MIN_MS || 5000);
const FAKE_MAX_MS = Number(process.env.FLOW_FAKE_MAX_MS || 40000);
const CDP = 'http://127.0.0.1:9222';
const WORKER = `${hostname()}-${process.pid}`;
const BUILD_LOG = path.join(homedir(), 'Flow', 'build-log.md');
const BRAKE_MS = 15 * 60_000;
const THROTTLE = /\b429\b|too many requests|rate.?limit|unusual traffic|try again later|quota/i;

let api;
let shuttingDown = false;
let brakeUntil = 0;
let lastLaunch = 0;
const active = new Map(); // requestId -> { tab }
const busyTabs = new Set();
process.on('SIGINT', () => { shuttingDown = true; });
process.on('SIGTERM', () => { shuttingDown = true; });

async function log(line) {
  console.log(line);
  if (FAKE) return; // fake runs stay out of the real build log
  try { await appendFile(BUILD_LOG, `\n[daemon-v2] ${new Date().toISOString()} — ${line}`); } catch {}
}

const concurrency = () => (Date.now() < brakeUntil ? 1 : CONFIGURED);

// ── Flow readiness and tabs ───────────────────────────────────────────────
async function flowTabs() {
  const res = await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(4000) });
  const targets = await res.json();
  return targets.filter((t) => t.type === 'page' && t.url.includes('flow.google.com'));
}

/** { ready, reason, tabs } — tabs are CDP target ids, topped up to the wanted count. */
async function checkFlow(want) {
  if (FAKE) return { ready: true, tabs: Array.from({ length: want }, (_, i) => `fake-${i}`) };
  let tabs;
  try {
    tabs = await flowTabs();
  } catch {
    await maybeLaunchChrome();
    return { ready: false, reason: 'Chrome with remote debugging is not running (port 9222)', tabs: [] };
  }
  if (tabs.length === 0) return { ready: false, reason: 'Chrome is running but has no Flow tab open', tabs: [] };
  // Open more tabs on the same project so parallel runs don't share one page.
  for (let i = tabs.length; i < want; i++) {
    try {
      let r = await fetch(`${CDP}/json/new?${encodeURIComponent(tabs[0].url)}`, { method: 'PUT' });
      if (!r.ok) r = await fetch(`${CDP}/json/new?${encodeURIComponent(tabs[0].url)}`);
      if (r.ok) await sleep(4000);
    } catch { break; }
  }
  tabs = await flowTabs().catch(() => tabs);
  return { ready: true, tabs: tabs.map((t) => t.id) };
}

async function maybeLaunchChrome() {
  if (Date.now() - lastLaunch < 5 * 60_000) return;
  lastLaunch = Date.now();
  await log('Chrome with Flow is not running — launching flow-launch-chrome.sh');
  spawn('/bin/bash', [path.join(__dirname, 'flow-launch-chrome.sh')], { detached: true, stdio: 'ignore' }).unref();
}

// ── Heartbeat and lease renewal ───────────────────────────────────────────
function heartbeatQuery({ claim, limit, flow, harvesting }) {
  const q = new URLSearchParams({ claim: String(claim), limit: String(limit), worker: WORKER, concurrency: String(concurrency()), flow_ready: flow.ready ? '1' : '0' });
  if (!flow.ready && flow.reason) q.set('flow_reason', flow.reason);
  if (harvesting) q.set('harvesting', '1');
  if (Date.now() < brakeUntil) q.set('brake_until', new Date(brakeUntil).toISOString());
  if (active.size) q.set('active', [...active.keys()].join(','));
  return `/api/flow-queue/pending?${q}`;
}

setInterval(async () => {
  if (!active.size || !api) return;
  try {
    const { lost } = await api.postJson('/api/flow-queue/lease', { worker: WORKER, request_ids: [...active.keys()] });
    for (const id of lost ?? []) await log(`[${id}] lease lost — the portal gave this request to someone else; result will be ignored`);
  } catch (err) {
    console.error(`lease renewal failed: ${err.message}`);
  }
}, Number(process.env.FLOW_LEASE_RENEW_MS || 30_000)).unref();

// ── One request ───────────────────────────────────────────────────────────
async function reportFailed(requestId, message) {
  for (let i = 0; i < 3; i++) {
    try { return await api.postJson('/api/flow-queue/fail', { request_id: requestId, error: message, worker: WORKER }); }
    catch { await sleep(2000 * (i + 1)); }
  }
}

// 1x1-ish valid PNG so fake runs exercise a real upload.
const FAKE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function generate(req, tab) {
  if (FAKE) {
    const wait = FAKE_MIN_MS + Math.random() * (FAKE_MAX_MS - FAKE_MIN_MS);
    await sleep(wait);
    const roll = Math.random();
    if (roll < FAKE_FAIL * 0.5) throw new Error('flow-generate.mjs failed: Flow did not produce an image in time');
    if (roll < FAKE_FAIL * 0.75) throw new Error('flow-generate.mjs failed: Flow policy: this prompt violates the usage policy');
    if (roll < FAKE_FAIL) throw new Error('flow-generate.mjs failed: 429 Too Many Requests');
    const dir = await mkdtemp(path.join(tmpdir(), 'flow-fake-'));
    const file = path.join(dir, `${req.id}.png`);
    await writeFile(file, FAKE_PNG);
    return { file, cleanup: () => rm(dir, { recursive: true, force: true }), width: 1, height: 1, dhash: null };
  }
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'flow-daemon-'));
  const promptPath = path.join(tmpDir, 'prompt.txt');
  await writeFile(promptPath, req.prompt, 'utf8');
  const args = ['flow-generate.mjs', '--file', promptPath, '--label', req.id, '--download', '0', '--res', '2K', '--tab', tab];
  if (req.reference_name) args.push('--reference', req.reference_name);
  let stdout, stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(process.execPath, args, { cwd: __dirname, timeout: 480000 }));
  } catch (err) {
    const detail = [err.stdout, err.stderr].filter(Boolean).join('\n').slice(0, 1500);
    throw new Error(`flow-generate.mjs failed: ${detail || err.message}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
  const match = stdout.match(/Downloaded image #\d+ at \S+ -> (.+)/);
  if (!match) throw new Error(`flow-generate.mjs ran but no download path found in its output:\n${[stdout, stderr].filter(Boolean).join('\n').slice(0, 1500)}`);
  const file = match[1].trim();
  const helper = await openHelperTab().catch(() => null);
  let full = null;
  if (helper) { full = await hashFile(helper, file).catch(() => null); await helper.close().catch(() => {}); }
  const tileSrc = stdout.match(/^TILE_SRC: (.+)$/m)?.[1]?.trim();
  return { file, cleanup: async () => {}, width: full?.width, height: full?.height, dhash: full?.hash, thumb_key: tileSrc && /^https?:/.test(tileSrc) ? tileSrc.slice(0, 500) : null };
}

async function withRetries(what, fn, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (err) { last = err; await sleep(1500 * 2 ** i); }
  }
  throw new Error(`${what}: ${last.message}`);
}

async function upload(req, result) {
  const bytes = await readFile(result.file);
  const type = result.file.endsWith('.png') ? 'image/png' : result.file.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  const { path: storagePath, signed_url, alreadyCompleted } = await withRetries('upload-url', () => api.postJson('/api/flow-queue/upload-url', { request_id: req.id, content_type: type }));
  if (alreadyCompleted) return;
  await withRetries('storage upload', async () => {
    const form = new FormData();
    form.append('cacheControl', '3600');
    form.append('', new Blob([bytes], { type }));
    const res = await fetch(signed_url, { method: 'PUT', headers: { 'x-upsert': 'false' }, body: form });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  });
  await withRetries('finalize', () => api.postJson('/api/flow-queue/finalize', {
    request_id: req.id, path: storagePath, width: result.width ?? null, height: result.height ?? null,
    thumb_key: result.thumb_key ?? null, dhash: result.dhash ?? null,
  }), 5);
}

async function fulfill(req, tab) {
  active.set(req.id, { tab });
  busyTabs.add(tab);
  try {
    await log(`[${req.id}] generating in tab ${String(tab).slice(0, 6)}${req.attempts ? ` (attempt ${req.attempts + 1})` : ''}...`);
    const result = await generate(req, tab);
    try {
      await upload(req, result);
      await log(`[${req.id}] saved and attached`);
    } finally {
      await result.cleanup().catch(() => {});
    }
  } catch (err) {
    await log(`[${req.id}] FAILED: ${err.message}`);
    if (THROTTLE.test(err.message) && Date.now() >= brakeUntil) {
      brakeUntil = Date.now() + BRAKE_MS;
      await log(`Throttle signal from Flow — dropping to 1 at a time until ${new Date(brakeUntil).toISOString()}`);
    }
    await reportFailed(req.id, err.message);
  } finally {
    active.delete(req.id);
    busyTabs.delete(tab);
  }
}

async function main() {
  api = portal(await loadPortalEnv(__dirname));
  await log(`started: worker ${WORKER}, concurrency ${CONFIGURED}${FAKE ? ', FAKE mode' : ''}`);
  while (!shuttingDown) {
    try {
      const harvesting = await harvestLockHeld();
      const flow = await checkFlow(concurrency());
      const free = flow.tabs.filter((t) => !busyTabs.has(t));
      const room = Math.max(0, Math.min(concurrency() - active.size, free.length));
      if (harvesting || !flow.ready || room === 0) {
        await api.get(heartbeatQuery({ claim: 0, limit: 1, flow, harvesting }));
      } else {
        const { requests } = await api.get(heartbeatQuery({ claim: 1, limit: room, flow, harvesting }));
        requests.forEach((req, i) => { fulfill(req, free[i]); });
        if (requests.length > 0) { await sleep(1500); continue; }
      }
    } catch (err) {
      console.error(`poll error: ${err.message}${err.cause?.code ? ` (${err.cause.code})` : ''}`);
    }
    if (!shuttingDown) await sleep(active.size ? 5000 : POLL_INTERVAL_MS);
  }
  while (active.size) await sleep(1000);
  console.log('Stopped.');
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
