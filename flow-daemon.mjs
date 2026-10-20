#!/usr/bin/env node
// flow-daemon.mjs — polls LinkedIn Command Center's image_requests queue
// and fulfills each one by shelling out to flow-generate.mjs (the
// already-existing, already-approved toolkit script) as a subprocess.
// This script does NOT talk to Chrome/CDP directly itself — it only
// orchestrates calls to flow-generate.mjs, the same way a human running
// commands by hand would, just automatically and continuously.
//
// Meant to run persistently on this machine (install as a macOS
// LaunchAgent for auto-start — see flow-daemon.plist.example alongside
// this file). Requires Chrome already running via flow-launch-chrome.sh
// with Flow open and logged in, same prerequisite as flow-generate.mjs
// itself.
//
// Usage:
//   FLOW_APP_URL=https://your-app.vercel.app \
//   FLOW_DAEMON_SECRET=<the shared secret set in Vercel> \
//   node flow-daemon.mjs
//
// Env vars (required):
//   FLOW_APP_URL          Base URL of the deployed app
//   FLOW_DAEMON_SECRET     Must match FLOW_DAEMON_SECRET in the app's env
// Optional:
//   FLOW_POLL_INTERVAL_MS  Default 15000

import { writeFile, appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(new URL(import.meta.url).pathname);

const APP_URL = process.env.FLOW_APP_URL;
const SECRET = process.env.FLOW_DAEMON_SECRET;
const POLL_INTERVAL_MS = Number(process.env.FLOW_POLL_INTERVAL_MS || 15000);
const BUILD_LOG = path.join(homedir(), 'Flow', 'build-log.md');

if (!APP_URL || !SECRET) {
  console.error('Set FLOW_APP_URL and FLOW_DAEMON_SECRET before running.');
  process.exit(1);
}

let shuttingDown = false;
process.on('SIGINT', () => { shuttingDown = true; console.log('\nShutting down after the current request finishes...'); });
process.on('SIGTERM', () => { shuttingDown = true; });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function log(line) {
  console.log(line);
  try {
    await appendFile(BUILD_LOG, `\n[daemon] ${new Date().toISOString()} — ${line}`);
  } catch {}
}

async function fetchPending() {
  const res = await fetch(`${APP_URL}/api/flow-queue/pending`, {
    headers: { 'x-flow-daemon-secret': SECRET },
  });
  if (!res.ok) throw new Error(`pending fetch failed: HTTP ${res.status}`);
  const json = await res.json();
  return json.requests ?? [];
}

async function reportComplete(requestId, filePath, { qaUnverified = false } = {}) {
  const { readFile } = await import('node:fs/promises');
  const bytes = await readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';

  const form = new FormData();
  form.append('request_id', requestId);
  form.append('file', new Blob([bytes], { type: contentType }), path.basename(filePath));
  // Portal-side: surfaced as an extra "QA couldn't verify this one" flag
  // wherever the image is shown for review — it does not skip the
  // existing unconditional owner-approval gate before schedule/publish.
  if (qaUnverified) form.append('qa_unverified', 'true');

  const res = await fetch(`${APP_URL}/api/flow-queue/complete`, {
    method: 'POST',
    headers: { 'x-flow-daemon-secret': SECRET },
    body: form,
  });
  if (!res.ok) throw new Error(`complete report failed: HTTP ${res.status} — ${await res.text().catch(() => '')}`);
}

async function reportFailed(requestId, errorMessage) {
  await fetch(`${APP_URL}/api/flow-queue/fail`, {
    method: 'POST',
    headers: { 'x-flow-daemon-secret': SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: requestId, error: errorMessage }),
  }).catch(() => {});
}

async function fulfillOne(req) {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'flow-daemon-'));
  const promptPath = path.join(tmpDir, 'prompt.txt');
  await writeFile(promptPath, req.prompt, 'utf8');

  // --qa: flow-generate.mjs crops Flow's 4 outputs, scores them with
  // flow-qa.mjs and downloads the best. If none of the 4 pass, rerun (a
  // fresh grid of 4) up to MAX_QA_RUNS times.
  //
  // If QA itself can't run (Claude CLI down, rate-limited, etc.),
  // flow-generate.mjs now still downloads a candidate rather than losing
  // the generation — printing "QA: UNAVAILABLE" instead of PASS/FAIL.
  // Retrying won't fix an unavailable CLI the way it can fix a genuinely
  // bad batch of images, so this breaks immediately rather than burning
  // MAX_QA_RUNS more generations, and reports the result flagged as
  // unverified rather than treating it as equivalent to a pass.
  const MAX_QA_RUNS = 3;
  const args = ['flow-generate.mjs', '--file', promptPath, '--label', req.id, '--qa', '--res', '2K'];
  if (req.reference_name) args.push('--reference', req.reference_name);

  let stdout;
  let stderr;
  let qaUnverified = false;
  for (let run = 1; run <= MAX_QA_RUNS; run++) {
    await log(`[${req.id}] generating (run ${run}/${MAX_QA_RUNS})${req.reference_name ? ` (reference: ${req.reference_name})` : ''}...`);
    try {
      // process.execPath, not the bare string 'node' — LaunchAgents run
      // with a minimal environment (no PATH, no nvm setup), so a plain
      // 'node' lookup for this child process fails with ENOENT even
      // though the daemon itself was launched with the right binary.
      // execPath is always the absolute path of whatever node is actually
      // running this script, so it works regardless of PATH.
      const result = await execFileAsync(process.execPath, args, { cwd: __dirname, timeout: 480000 });
      stdout = result.stdout;
      // flow-generate.mjs's download-step failure notes ("Clicked {res}
      // but no new file appeared...", "Could not find Download menu
      // item", etc.) go to console.error, not console.log — on a
      // SUCCESSFUL (exit 0) run, execFileAsync still captures stderr
      // separately from stdout, but this was being discarded here. Found
      // live: a generation that QA-scored 9/10 still threw "no download
      // path found," and the thrown error dumped only stdout, which had
      // no clue in it — the actual reason was sitting in the discarded
      // stderr the whole time.
      stderr = result.stderr;
    } catch (err) {
      await rm(tmpDir, { recursive: true, force: true });
      // err.message alone (just "Command failed: <cmd>") hid the actual
      // reason on the first real failure — flow-generate.mjs's own
      // stdout/stderr (attached by execFile on a non-zero exit) has the
      // real error, truncated to keep the queue row readable.
      const detail = [err.stdout, err.stderr].filter(Boolean).join('\n').slice(0, 1500);
      throw new Error(`flow-generate.mjs failed: ${err.message}${detail ? `\n---\n${detail}` : ''}`);
    }
    const qaLine = (stdout.match(/QA: .+/) || [''])[0];
    if (qaLine) await log(`[${req.id}] ${qaLine}`);
    if (qaLine.startsWith('QA: PASS')) break;
    if (qaLine.startsWith('QA: UNAVAILABLE')) { qaUnverified = true; break; }
    if (!qaLine.startsWith('QA: FAIL')) throw new Error(`Image QA did not pass: ${qaLine || 'no QA result'}`);
    if (run === MAX_QA_RUNS) throw new Error(`Image QA failed after ${MAX_QA_RUNS} attempts: ${qaLine}`);
  }
  await rm(tmpDir, { recursive: true, force: true });

  const match = stdout.match(/Downloaded image #\d+ at \S+ -> (.+)/);
  if (!match) {
    const detail = [stdout, stderr].filter(Boolean).join('\n').slice(0, 1500);
    throw new Error(`flow-generate.mjs ran but no download path found in its output:\n${detail}`);
  }
  const downloadedPath = match[1].trim();

  await log(`[${req.id}] generated -> ${downloadedPath}${qaUnverified ? ' (QA unverified)' : ''}, reporting back...`);
  await reportComplete(req.id, downloadedPath, { qaUnverified });
  await log(`[${req.id}] done.`);
}

async function main() {
  console.log(`flow-daemon: polling ${APP_URL} every ${POLL_INTERVAL_MS}ms. Ctrl+C to stop.`);
  while (!shuttingDown) {
    try {
      const pending = await fetchPending();
      for (const req of pending) {
        if (shuttingDown) break;
        try {
          await fulfillOne(req);
        } catch (err) {
          await log(`[${req.id}] FAILED: ${err.message}`);
          await reportFailed(req.id, err.message);
        }
      }
    } catch (err) {
      console.error(`poll error: ${err.message}${err.cause?.code ? ` (${err.cause.code})` : ''}`);
    }
    if (!shuttingDown) await sleep(POLL_INTERVAL_MS);
  }
  console.log('Stopped.');
}

main();
