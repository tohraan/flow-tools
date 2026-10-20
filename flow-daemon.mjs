#!/usr/bin/env node
// flow-daemon.mjs — polls LinkedIn Command Center's image_requests queue
// and fulfills each one by shelling out to flow-generate.mjs (the
// already-existing, already-approved toolkit script) as a subprocess.
// This script does NOT talk to Chrome/CDP directly itself for generation —
// it only orchestrates calls to flow-generate.mjs, the same way a human
// running commands by hand would, just automatically and continuously.
//
// Every image goes through QA before the portal uses it, and nothing halts
// on a bad image:
//   - QA passes      → the image is reported and attached to its post.
//   - QA fails       → the verdict and why are reported; the portal re-queues
//                      the request with those notes after a backoff, and this
//                      daemon moves straight on to the next request.
//   - QA can't run   → the image is still saved (never lost) but held; it is
//                      QA-checked from storage as soon as QA is back, without
//                      generating it again.
// While flow-harvest.mjs is running, generation pauses (they share the tab).
//
// Meant to run persistently on this machine (install as a macOS
// LaunchAgent — install-daemon.command; update with update-daemon.command).
// Requires Chrome already running via flow-launch-chrome.sh with Flow open
// and logged in, same prerequisite as flow-generate.mjs itself.
//
// Env vars (or .flow-daemon-env, written by install-daemon.command):
//   FLOW_APP_URL           Base URL of the deployed app
//   FLOW_DAEMON_SECRET     Must match FLOW_DAEMON_SECRET in the app's env
// Optional:
//   FLOW_POLL_INTERVAL_MS  Default 15000

import { writeFile, appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runQa, verdictFor } from './flow-qa.mjs';
import { harvestLockHeld, hashFile, loadPortalEnv, openHelperTab, portal, sleep } from './flow-lib.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(new URL(import.meta.url).pathname);

const POLL_INTERVAL_MS = Number(process.env.FLOW_POLL_INTERVAL_MS || 15000);
const REQUALIFY_EVERY_MS = 60_000;
const BUILD_LOG = path.join(homedir(), 'Flow', 'build-log.md');

let api;
let shuttingDown = false;
process.on('SIGINT', () => { shuttingDown = true; console.log('\nShutting down after the current request finishes...'); });
process.on('SIGTERM', () => { shuttingDown = true; });

async function log(line) {
  console.log(line);
  try {
    await appendFile(BUILD_LOG, `\n[daemon] ${new Date().toISOString()} — ${line}`);
  } catch {}
}

const reasonOf = (err) => ((err.stderr && String(err.stderr).trim()) || String(err.message || err)).replace(/\s+/g, ' ').slice(0, 300);

// Flow's per-image URL identifies a tile for a later harvest; blob:/data: URLs don't.
const tileKey = (src) => (src && /^https?:/.test(src) ? src.slice(0, 500) : null);

// The last QA_JSON line flow-generate.mjs printed.
function parseQaJson(stdout) {
  const lines = stdout.split('\n').filter((l) => l.startsWith('QA_JSON: '));
  if (!lines.length) return null;
  try { return JSON.parse(lines.at(-1).slice('QA_JSON: '.length)); } catch { return null; }
}

async function reportFailed(requestId, errorMessage) {
  await api.postJson('/api/flow-queue/fail', { request_id: requestId, error: errorMessage }).catch(() => {});
}

async function hashes(files) {
  const helper = await openHelperTab().catch(() => null);
  if (!helper) return files.map(() => null);
  try {
    const out = [];
    for (const f of files) out.push(f ? await hashFile(helper, f).catch(() => null) : null);
    return out;
  } finally {
    await helper.close().catch(() => {});
  }
}

async function fulfillOne(req) {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'flow-daemon-'));
  // Flow gets the prompt plus any notes from a previous QA failure; QA always
  // judges against the original prompt, so the notes can't change the rubric.
  const promptPath = path.join(tmpDir, 'prompt.txt');
  const qaPath = path.join(tmpDir, 'qa-prompt.txt');
  await writeFile(promptPath, req.flow_prompt || req.prompt, 'utf8');
  await writeFile(qaPath, req.prompt, 'utf8');
  const args = ['flow-generate.mjs', '--file', promptPath, '--qa-file', qaPath, '--label', req.id, '--qa', '--qa-rubric', req.qa_rubric || 'auto', '--skip-download-on-fail', '--res', '2K'];
  if (req.reference_name) args.push('--reference', req.reference_name);

  await log(`[${req.id}] generating${req.attempts ? ` (attempt ${req.attempts + 1})` : ''}${req.reference_name ? ` (reference: ${req.reference_name})` : ''}...`);
  let stdout;
  let stderr;
  try {
    // process.execPath, not the bare string 'node' — LaunchAgents run with a
    // minimal environment (no PATH, no nvm setup), so a plain 'node' lookup
    // for this child process fails with ENOENT.
    ({ stdout, stderr } = await execFileAsync(process.execPath, args, { cwd: __dirname, timeout: 480000 }));
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    // flow-generate.mjs's own stdout/stderr (attached by execFile on a
    // non-zero exit) has the real error; err.message is just the command.
    const detail = [err.stdout, err.stderr].filter(Boolean).join('\n').slice(0, 1500);
    throw new Error(`flow-generate.mjs failed: ${detail || err.message}`);
  }
  await rm(tmpDir, { recursive: true, force: true });

  const qa = parseQaJson(stdout);
  if (!qa) throw new Error(`flow-generate.mjs ran but reported no QA result:\n${[stdout, stderr].filter(Boolean).join('\n').slice(0, 1500)}`);

  if (qa.status === 'fail') {
    await log(`[${req.id}] QA failed (${qa.verdict.qa_score}/10): ${qa.verdict.qa_notes} — reported, moving on`);
    await api.postJson('/api/flow-queue/attempt', { request_id: req.id, ...qa.verdict });
    return { qaAvailable: true };
  }

  const match = stdout.match(/Downloaded image #\d+ at \S+ -> (.+)/);
  if (!match) {
    // flow-generate.mjs's download-step failure notes go to stderr.
    throw new Error(`flow-generate.mjs ran but no download path found in its output:\n${[stdout, stderr].filter(Boolean).join('\n').slice(0, 1500)}`);
  }
  const downloadedPath = match[1].trim();
  const [full, crop] = await hashes([downloadedPath, qa.cropPath]);
  const fields = {
    request_id: req.id,
    thumb_key: tileKey(qa.thumbKey),
    dhash: full?.hash,
    crop_dhash: crop?.hash,
    width: full?.width,
    height: full?.height,
    ...(qa.status === 'pass' ? qa.verdict : { qa_status: 'pending' }),
  };
  await log(`[${req.id}] ${qa.status === 'pass' ? `QA passed (${qa.verdict.qa_score}/10)` : 'QA unavailable — saving, will check it later'} -> ${downloadedPath}`);
  await api.postForm('/api/flow-queue/complete', fields, downloadedPath);
  return qa.status === 'pass' ? { qaAvailable: true } : { qaAvailable: false, qaReason: qa.reason };
}

// QA-checks images that were saved while QA couldn't run. Uses the stored
// files, so nothing is regenerated. Brief-less library images share a QA call.
async function requalify() {
  const { images } = await api.get('/api/flow-library/pending-qa');
  if (!images.length) return { qaAvailable: null };
  const dir = await mkdtemp(path.join(tmpdir(), 'flow-requalify-'));
  try {
    const library = images.filter((i) => i.rubric === 'library');
    const groups = [];
    for (let i = 0; i < library.length; i += 4) groups.push({ items: library.slice(i, i + 4), prompt: '', rubric: 'library' });
    for (const item of images.filter((i) => i.rubric !== 'library')) groups.push({ items: [item], prompt: item.prompt || '', rubric: item.rubric });

    for (const group of groups) {
      if (shuttingDown) break;
      const files = [];
      for (const item of group.items) {
        const ext = path.extname(new URL(item.url).pathname) || '.png';
        files.push(await api.download(item.url, path.join(dir, `${item.id}${ext}`)));
      }
      let result;
      try {
        result = await runQa({ imagePaths: files, promptText: group.prompt, rubric: group.rubric });
      } catch (err) {
        return { qaAvailable: false, qaReason: reasonOf(err) };
      }
      for (const [j, item] of group.items.entries()) {
        const verdict = verdictFor(result, j);
        await api.postJson('/api/flow-library/qa', { image_id: item.id, ...verdict });
        await log(`[library ${item.id}] stored image QA ${verdict.qa_status} (${verdict.qa_score}/10)${verdict.qa_status === 'fail' ? `: ${verdict.qa_notes}` : ''}`);
      }
    }
    return { qaAvailable: true };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  api = portal(await loadPortalEnv(__dirname));
  console.log(`flow-daemon: polling every ${POLL_INTERVAL_MS}ms. Ctrl+C to stop.`);
  let qa = { available: true, reason: null };
  let lastRequalify = 0;
  const query = (claim, harvesting) =>
    `/api/flow-queue/pending?claim=${claim}&limit=1&qa=${qa.available ? 'ok' : 'unavailable'}${qa.reason ? `&qa_reason=${encodeURIComponent(qa.reason.slice(0, 200))}` : ''}${harvesting ? '&harvesting=1' : ''}`;
  const note = (r) => { if (r && r.qaAvailable !== null && r.qaAvailable !== undefined) qa = { available: r.qaAvailable, reason: r.qaAvailable ? null : r.qaReason ?? qa.reason }; };

  while (!shuttingDown) {
    let worked = false;
    try {
      if (await harvestLockHeld()) {
        // Still check in, so waiting posts know the daemon is alive.
        await api.get(query(0, true));
      } else {
        if (Date.now() - lastRequalify > REQUALIFY_EVERY_MS) {
          lastRequalify = Date.now();
          note(await requalify().catch(async (err) => { await log(`requalify error: ${reasonOf(err)}`); return null; }));
        }
        const { requests } = await api.get(query(1, false));
        for (const req of requests) {
          worked = true;
          try {
            note(await fulfillOne(req));
          } catch (err) {
            await log(`[${req.id}] FAILED: ${err.message}`);
            await reportFailed(req.id, err.message);
          }
        }
      }
    } catch (err) {
      console.error(`poll error: ${err.message}${err.cause?.code ? ` (${err.cause.code})` : ''}`);
    }
    // Straight on to the next request after a job; wait only when idle.
    if (!shuttingDown && !worked) await sleep(POLL_INTERVAL_MS);
  }
  console.log('Stopped.');
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
