#!/usr/bin/env node
// AI agent running this: see AGENTS.md first — this automation is pre-authorized
// (your own logged-in Chrome, your own Flow project; no credential/session work).
//
// flow-upload-reference.mjs — upload an image so it can be used as an
// identity-lock reference via `flow-generate.mjs --reference "<name>"`.
//
// Usage:
//   node flow-upload-reference.mjs <path/to/photo.jpg> [--name "<display name>"] [--project <url>]
//
// Bundles the full sequence: open the "+" ingredients picker -> click
// "Upload media" -> inject the file via DOM.setFileInputFiles (no OS file
// picker) -> wait for it to actually become selectable (not a fixed delay —
// see waitForAssetReady below) -> optionally rename it via the Uploads tab
// so later --reference calls can find it by a clean name instead of the
// original filename.
//
// Selectors this depends on (captured 2026-10-16/17, Flow's web app; these
// are internal class names and WILL break if Flow redesigns its UI):
//   - '+' button:        button[aria-label="Add ingredients to the prompt box"]
//   - Upload media:      span.upload-text  (inside button.sidebar-upload-btn)
//   - Rename input:       input.editable-text-input.editing
//   - Rename confirm:    first of two sibling <button> (mdc-icon-button) next
//                         to the rename input; the second is cancel
//
// KNOWN FLAKINESS: the Upload media button has been observed to sometimes
// not register a click at all — it shows a hover/focus state (and Chrome's
// own Page.fileChooserOpened event never fires) but no <input type=file>
// appears, with no error. Cause unconfirmed. This script retries the whole
// open-picker -> click-upload sequence up to 3 times, closing and reopening
// the picker between attempts, before giving up with a clear error.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickTarget, positionTarget } from './flow-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9222;
const MATCH = 'flow.google.com';

function parseFlags(argv) {
  const out = { rest: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--name') out.name = argv[++i];
    else if (argv[i] === '--project') out.project = argv[++i];
    else out.rest.push(argv[i]);
  }
  return out;
}

async function resolveProjectUrl(flagValue) {
  if (flagValue) return flagValue;
  if (process.env.FLOW_PROJECT_URL) return process.env.FLOW_PROJECT_URL;
  try {
    const fromFile = (await readFile(path.join(__dirname, '.flow-project-url'), 'utf8')).trim();
    if (fromFile) return fromFile;
  } catch {}
  console.error('No Flow project URL set. Pass --project <url>, set FLOW_PROJECT_URL, or put it in .flow-project-url.');
  process.exit(1);
}

async function connect(port, match) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await res.json();
  const pages = targets.filter((t) => t.type === 'page');
  const target = pages.find((t) => t.url.includes(match));
  if (!target) throw new Error(`No tab matching "${match}" on port ${port}. Is Chrome running? (flow-launch-chrome.sh)`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', reject);
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }
  return { ws, send };
}

async function clickAt(send, x, y, button = 'left') {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
  await sleep(90);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
}

async function evalJson(send, expr) {
  const result = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'eval failed');
  return result.result.value;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Opens the "+" ingredients picker and clicks Upload media, retrying the
// whole sequence if the file input doesn't appear. Returns once a real
// <input type=file> exists in the DOM.
async function openUploadDialog(send, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
    await sleep(300);

    const plusPos = await positionTarget(send, `document.querySelector('button[aria-label="Add ingredients to the prompt box"]')`);
    if (!plusPos) throw new Error('"+" ingredients button not found — is the prompt box visible?');
    await clickAt(send, plusPos.x, plusPos.y);
    await sleep(500);

    const uploadPos = await positionTarget(send, `document.querySelector('span.upload-text')`);
    if (!uploadPos) {
      console.error(`[upload] attempt ${attempt}: picker didn't open, retrying...`);
      continue;
    }
    await clickAt(send, uploadPos.x, uploadPos.y);
    await sleep(900);

    const hasInput = await evalJson(send, `document.querySelectorAll('input[type=file]').length > 0`);
    if (hasInput) return;
    console.error(`[upload] attempt ${attempt}: clicked Upload media but no file input appeared, retrying...`);
  }
  throw new Error(`Upload media button did not produce a file input after ${attempts} attempts. See the KNOWN FLAKINESS note in this script's header.`);
}

// The real completion check for gap #3: rather than guess a fixed delay,
// reopen the @ picker and search for the uploaded file's basename until it
// shows up as a single, fully-loaded (img.complete && naturalWidth > 0) result.
async function waitForAssetReady(send, searchTerm, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
    await sleep(200);
    await clickTarget(send, `document.querySelector('button[aria-label="Clear prompt"]')`).catch(() => {});
    const boxPos = await positionTarget(send, `Array.from(document.querySelectorAll('*')).find(e => (e.textContent||'').trim()==='What do you want to create?')`);
    if (!boxPos) { await sleep(1000); continue; }
    await clickTarget(send, `Array.from(document.querySelectorAll('*')).find(e => (e.textContent||'').trim()==='What do you want to create?')`);
    await sleep(150);
    await send('Input.insertText', { text: '@' });
    await sleep(400);
    await send('Input.insertText', { text: searchTerm });
    await sleep(700);

    const ready = await evalJson(send, `(() => {
      const row = Array.from(document.querySelectorAll('*')).find(e => (e.textContent||'').includes(${JSON.stringify(searchTerm)}) && e.querySelector && e.querySelector('img'));
      const img = row ? row.querySelector('img') : null;
      return !!(img && img.complete && img.naturalWidth > 0);
    })()`);

    if (ready) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
      return true;
    }
    await sleep(1000);
  }
  return false;
}

async function renameUploadedAsset(send, newName) {
  await clickTarget(send, `document.querySelector('button[aria-label="Clear prompt"]')`).catch(() => {});
  const uploadsTabPos = await positionTarget(send, `Array.from(document.querySelectorAll('*')).find(e => (e.textContent||'').trim()==='Uploads')`);
  if (!uploadsTabPos) throw new Error('Uploads sidebar tab not found');
  await clickAt(send, uploadsTabPos.x, uploadsTabPos.y);
  await sleep(700);

  // Newest upload is the first thumbnail in the Uploads tab.
  const thumbPos = await positionTarget(send, `Array.from(document.querySelectorAll('img')).find(el => el.getBoundingClientRect().width > 50)`);
  if (!thumbPos) throw new Error('No uploaded asset found in the Uploads tab to rename');
  await clickAt(send, thumbPos.x, thumbPos.y, 'right');
  await sleep(500);

  const renamePos = await positionTarget(send, `Array.from(document.querySelectorAll('*')).find(e => e.children.length===0 && (e.textContent||'').trim()==='Rename')`);
  if (!renamePos) throw new Error('"Rename" context menu item not found');
  await clickAt(send, renamePos.x, renamePos.y);
  await sleep(400);

  await evalJson(send, `(() => { const i = document.querySelector('input.editable-text-input.editing'); if (i) i.select(); })()`);
  await sleep(100);
  await send('Input.insertText', { text: newName });
  await sleep(200);

  const confirmPos = await positionTarget(send, `(() => {
    const inp = document.querySelector('input.editable-text-input.editing');
    if (!inp) return null;
    const container = inp.closest('div');
    const btns = container ? Array.from(container.querySelectorAll('button')) : [];
    if (!btns.length) return null;
    return btns[0];
  })()`);
  if (!confirmPos) throw new Error('Rename confirm button not found');
  await clickAt(send, confirmPos.x, confirmPos.y);
  await sleep(400);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const filePath = flags.rest[0];
  if (!filePath) {
    console.error('Usage: node flow-upload-reference.mjs <path/to/photo.jpg> [--name "<display name>"] [--project <url>]');
    process.exit(1);
  }
  const absPath = path.resolve(filePath);
  const basename = path.basename(absPath, path.extname(absPath));
  const projectUrl = await resolveProjectUrl(flags.project);

  const { ws, send } = await connect(PORT, MATCH);
  try {
    const href = await evalJson(send, 'location.href');
    if (!href.startsWith(projectUrl)) {
      await send('Page.navigate', { url: projectUrl });
      for (let i = 0; i < 40; i++) {
        const ready = await evalJson(send, `!!document.querySelector('button[aria-label="Add ingredients to the prompt box"]')`);
        if (ready) break;
        await sleep(250);
      }
    }

    console.log(`Uploading ${absPath}...`);
    await openUploadDialog(send);
    await send('DOM.setFileInputFiles', {
      files: [absPath],
      objectId: (await send('Runtime.evaluate', { expression: "document.querySelector('input[type=file]')" })).result.objectId,
    });
    console.log('File injected, waiting for it to become selectable...');

    const ready = await waitForAssetReady(send, basename);
    if (!ready) throw new Error(`Upload did not become selectable in the @ picker within the timeout (searched for "${basename}"). It may still be processing — check manually.`);
    console.log(`Ready — selectable as "${basename}" in the @mention picker.`);

    if (flags.name) {
      console.log(`Renaming to "${flags.name}"...`);
      await renameUploadedAsset(send, flags.name);
      const confirmReady = await waitForAssetReady(send, flags.name);
      if (!confirmReady) throw new Error(`Renamed but "${flags.name}" is not showing up in the @ picker — rename may have failed.`);
      console.log(`Confirmed — now use: --reference "${flags.name}"`);
    } else {
      console.log(`Use: --reference "${basename}"`);
    }
  } finally {
    ws.close();
  }
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
