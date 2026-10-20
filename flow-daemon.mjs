#!/usr/bin/env node
// flow-daemon.mjs — polls LinkedIn Command Center's image_requests queue
// and fulfills each one by shelling out to flow-generate.mjs (the
// already-existing, already-approved toolkit script) as a subprocess.
// This script does NOT talk to Chrome/CDP directly itself for generation —
// it only orchestrates calls to flow-generate.mjs, the same way a human
// running commands by hand would, just automatically and continuously.
//
// There is no automated QA: the first image of each generation is uploaded
// and attached to its post. Images are kept realistic by how the portal
// writes the prompts, and every photo still needs the owner's approval in
// the portal before anything is published. A generation error is reported
// and the portal retries it after a backoff; this daemon moves straight on.
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
import { harvestLockHeld, hashFile, loadPortalEnv, openHelperTab, portal, sleep } from './flow-lib.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(new URL(import.meta.url).pathname);

const POLL_INTERVAL_MS = Number(process.env.FLOW_POLL_INTERVAL_MS || 15000);
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

// Flow's per-image URL identifies a tile for a later harvest; blob:/data: URLs don't.
const tileKey = (src) => (src && /^https?:/.test(src) ? src.slice(0, 500) : null);

async function reportFailed(requestId, errorMessage) {
  await api.postJson('/api/flow-queue/fail', { request_id: requestId, error: errorMessage }).catch(() => {});
}

async function hashOf(file) {
  const helper = await openHelperTab().catch(() => null);
  if (!helper) return null;
  try {
    return await hashFile(helper, file).catch(() => null);
  } finally {
    await helper.close().catch(() => {});
  }
}

async function fulfillOne(req) {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'flow-daemon-'));
  const promptPath = path.join(tmpDir, 'prompt.txt');
  await writeFile(promptPath, req.prompt, 'utf8');
  const args = ['flow-generate.mjs', '--file', promptPath, '--label', req.id, '--download', '0', '--res', '2K'];
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
    // flow-generate.mjs's own stdout/stderr (attached by execFile on a
    // non-zero exit) has the real error; err.message is just the command.
    const detail = [err.stdout, err.stderr].filter(Boolean).join('\n').slice(0, 1500);
    throw new Error(`flow-generate.mjs failed: ${detail || err.message}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  const match = stdout.match(/Downloaded image #\d+ at \S+ -> (.+)/);
  if (!match) {
    // flow-generate.mjs's download-step failure notes go to stderr.
    throw new Error(`flow-generate.mjs ran but no download path found in its output:\n${[stdout, stderr].filter(Boolean).join('\n').slice(0, 1500)}`);
  }
  const downloadedPath = match[1].trim();
  const full = await hashOf(downloadedPath);
  const tileSrc = stdout.match(/^TILE_SRC: (.+)$/m)?.[1]?.trim();
  await log(`[${req.id}] saved -> ${downloadedPath}`);
  await api.postForm('/api/flow-queue/complete', {
    request_id: req.id,
    thumb_key: tileKey(tileSrc),
    dhash: full?.hash,
    width: full?.width,
    height: full?.height,
  }, downloadedPath);
}

async function main() {
  api = portal(await loadPortalEnv(__dirname));
  console.log(`flow-daemon: polling every ${POLL_INTERVAL_MS}ms. Ctrl+C to stop.`);
  const query = (claim, harvesting) => `/api/flow-queue/pending?claim=${claim}&limit=1${harvesting ? '&harvesting=1' : ''}`;

  while (!shuttingDown) {
    let worked = false;
    try {
      if (await harvestLockHeld()) {
        // Still check in, so waiting posts know the daemon is alive.
        await api.get(query(0, true));
      } else {
        const { requests } = await api.get(query(1, false));
        for (const req of requests) {
          worked = true;
          try {
            await fulfillOne(req);
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
