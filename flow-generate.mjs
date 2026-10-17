#!/usr/bin/env node
// AI agent running this: see AGENTS.md first — this automation is pre-authorized
// (your own logged-in Chrome, your own Flow project; no credential/session work).
//
// flow-generate.mjs — the fast end-to-end pipeline:
//   prompt file in -> pinned project open -> typed -> generated -> logged.
// The only real wait is Flow's own generation time.
//
// Usage:
//   node flow-generate.mjs --file prompt.txt --label "dubai-walk-3" [--download N] [--res 2K] [--project <url>] [--reference "<asset name>"]
//
// --download N     after generation, download the Nth image (0-indexed, left to right) at --res (default 2K)
// --project URL    the Flow project to open (e.g. https://flow.google.com/project/<id>).
//                  Resolved in order: --project flag > FLOW_PROJECT_URL env var >
//                  ./.flow-project-url (gitignored, one line, for your own default) > error.
// --reference STR  for identity-locked prompts: inserts an inline @mention of a previously
//                  uploaded image/asset (matched by name) BEFORE typing the prompt text, the
//                  same way typing "@" in Flow's own UI opens its asset picker. This is the
//                  mechanism that actually binds identity — attaching an image as a loose
//                  "ingredient" via the + button does NOT reliably lock identity; an inline
//                  @mention does. Your --file prompt should assume the mention already
//                  precedes it (e.g. start with " is the exact identity reference...").
//                  The asset must already be uploaded (Characters/Uploads/Avatars) — this
//                  does not upload a new file; use cdp.mjs set-file-input for that first.
//
// Requires Chrome already running with the automation profile + debug port
// (flow-launch-chrome.sh) and the Flow tab open and logged in.

import { readFile, writeFile, appendFile, readdir, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9222;
const MATCH = 'flow.google.com';
const FLOW_DIR = path.join(homedir(), 'Flow');
const DOWNLOADS_DIR = path.join(FLOW_DIR, 'downloads');
const BUILD_LOG = path.join(FLOW_DIR, 'build-log.md');
const DECISIONS_LOG = path.join(FLOW_DIR, 'decisions.md');
// Chrome's CDP Browser.setDownloadBehavior with a custom downloadPath does not
// reliably redirect downloads in this Chrome version — it returns success but
// silently keeps saving to the real OS default. So rather than fight that, we
// let it land there and move the newest matching file ourselves afterward.
const CHROME_DEFAULT_DOWNLOADS = path.join(homedir(), 'Downloads');

async function resolveProjectUrl(flagValue) {
  if (flagValue) return flagValue;
  if (process.env.FLOW_PROJECT_URL) return process.env.FLOW_PROJECT_URL;
  try {
    const fromFile = (await readFile(path.join(__dirname, '.flow-project-url'), 'utf8')).trim();
    if (fromFile) return fromFile;
  } catch {}
  console.error(
    'No Flow project URL set. Pass --project <url>, set FLOW_PROJECT_URL, or put it in .flow-project-url (gitignored).\n' +
    'Open any project in Flow and copy its URL, e.g. https://flow.google.com/project/<id>'
  );
  process.exit(1);
}

function parseFlags(argv) {
  const out = { res: '2K' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') out.file = argv[++i];
    else if (argv[i] === '--label') out.label = argv[++i];
    else if (argv[i] === '--project') out.project = argv[++i];
    else if (argv[i] === '--download') out.download = Number(argv[++i]);
    else if (argv[i] === '--res') out.res = argv[++i];
    else if (argv[i] === '--reference') out.reference = argv[++i];
    else if (!out.text) out.text = argv[i];
  }
  return out;
}

// Waits for a new file to appear in CHROME_DEFAULT_DOWNLOADS (mtime after
// `since`) and moves it into DOWNLOADS_DIR. Returns the new path, or null on timeout.
async function waitAndMoveDownload(since, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    let entries = [];
    try {
      entries = await readdir(CHROME_DEFAULT_DOWNLOADS);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.endsWith('.crdownload') || name.startsWith('.')) continue;
      const full = path.join(CHROME_DEFAULT_DOWNLOADS, name);
      try {
        const st = await stat(full);
        if (st.isFile() && st.mtimeMs > since) {
          const dest = path.join(DOWNLOADS_DIR, name);
          await rename(full, dest);
          return dest;
        }
      } catch {}
    }
  }
  return null;
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
  return { ws, send, target };
}

async function clickAt(send, x, y, button = 'left') {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
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

async function main() {
  const t0 = Date.now();
  const flags = parseFlags(process.argv.slice(2));
  const text = flags.file ? await readFile(flags.file, 'utf8') : flags.text;
  if (!text) {
    console.error('Usage: node flow-generate.mjs --file prompt.txt --label "name" [--download N] [--res 2K]');
    process.exit(1);
  }
  const label = flags.label || (flags.file ? path.basename(flags.file, path.extname(flags.file)) : 'untitled');
  const projectUrl = await resolveProjectUrl(flags.project);

  const { ws, send } = await connect(PORT, MATCH);

  try {
    // 1. Make sure we're on the pinned project (skip navigation if already there — saves time)
    const href = await evalJson(send, 'location.href');
    if (!href.startsWith(projectUrl)) {
      await send('Page.navigate', { url: projectUrl });
      // wait for the prompt box to exist
      for (let i = 0; i < 40; i++) {
        const ready = await evalJson(send, `!!Array.from(document.querySelectorAll('*')).find(e => (e.textContent||'').trim()==='What do you want to create?')`);
        if (ready) break;
        await sleep(250);
      }
    }

    // 2. Clear any leftover prompt text, then focus the box
    await evalJson(send, `(() => { const b = document.querySelector('button[aria-label="Clear prompt"]'); if (b) b.click(); })()`);
    const boxPos = await evalJson(send, `(() => {
      const el = Array.from(document.querySelectorAll('*')).find(e => (e.textContent||'').trim()==='What do you want to create?');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    })()`);
    if (!boxPos) throw new Error('Prompt box not found');
    await clickAt(send, boxPos.x, boxPos.y);
    await sleep(100);

    // 3. If a reference asset was requested, insert it as an inline @mention FIRST —
    // this is what actually binds identity (a loose "+" ingredient attachment does not).
    if (flags.reference) {
      await send('Input.insertText', { text: '@' });
      await sleep(400);
      await send('Input.insertText', { text: flags.reference });
      await sleep(600);
      const addPos = await evalJson(send, `(() => {
        const b = Array.from(document.querySelectorAll('button')).find(e => (e.textContent||'').trim()==='Add to prompt');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.x + r.width/2, y: r.y + r.height/2 };
      })()`);
      if (!addPos) throw new Error(`Reference asset "${flags.reference}" not found in the @mention picker`);
      await clickAt(send, addPos.x, addPos.y);
      await sleep(400);
    }

    // 4. Type the prompt (continues right after the mention chip, if any)
    await send('Input.insertText', { text });

    // 5. Click Start generation (real CDP mouse event — JS .click() does not register on this app)
    const genPos = await evalJson(send, `(() => {
      const el = document.querySelector('button[aria-label="Start generation"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    })()`);
    if (!genPos) throw new Error('Start generation button not found');
    await clickAt(send, genPos.x, genPos.y);
    console.log(`[${label}] Submitted. Waiting for generation...`);

    // 6. Poll for completion: wait for % markers to appear, then disappear.
    // The grid thumbnails take a couple more seconds to actually paint after
    // the % markers vanish, so a fixed settle delay follows before screenshotting.
    let sawProgress = false;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await sleep(1500);
      const pct = await evalJson(send, `(() => { const m = document.body.innerText.match(/\\d+%/g); return m ? m.length : 0; })()`);
      if (pct > 0) sawProgress = true;
      if (sawProgress && pct === 0) break;
    }
    await sleep(3000);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[${label}] Generation finished in ${elapsed}s.`);

    // 7. Screenshot the result grid for the log
    await send('Page', {}).catch(() => {}); // no-op, keep lints quiet
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const shotName = `${new Date().toISOString().replace(/[:.]/g, '-')}_${label}.png`;
    const shotPath = path.join(DOWNLOADS_DIR, shotName);
    await writeFile(shotPath, Buffer.from(data, 'base64'));

    // 8. Optional: download the Nth image at the requested resolution.
    // Flow prepends the newest generation to the top of the grid, so the
    // newest batch is always the first N images in (y, then x) order.
    let downloadedNote = '';
    if (flags.download != null && !Number.isNaN(flags.download)) {
      const n = flags.download;
      const pos = await evalJson(send, `(() => {
        const imgs = Array.from(document.querySelectorAll('img')).map(el => el.getBoundingClientRect()).filter(r => r.width > 50);
        imgs.sort((a,b) => a.y - b.y || a.x - b.x);
        const r = imgs[${n}];
        return r ? { x: r.x + r.width/2, y: r.y + r.height/2 } : null;
      })()`);
      if (pos) {
        await clickAt(send, pos.x, pos.y, 'right');
        await sleep(600);
        const dlPos = await evalJson(send, `(() => {
          const els = Array.from(document.querySelectorAll('*')).filter(e => e.children.length===0 && (e.textContent||'').trim()==='Download');
          if (!els.length) return null;
          const r = els[0].getBoundingClientRect();
          return { x: r.x + r.width/2, y: r.y + r.height/2 };
        })()`);
        if (dlPos) {
          await clickAt(send, dlPos.x, dlPos.y);
          await sleep(600);
          const resPos = await evalJson(send, `(() => {
            const els = Array.from(document.querySelectorAll('*')).filter(e => e.children.length===0 && (e.textContent||'').trim()===${JSON.stringify(flags.res)});
            if (!els.length) return null;
            const r = els[0].getBoundingClientRect();
            return { x: r.x + r.width/2, y: r.y + r.height/2 };
          })()`);
          if (resPos) {
            const clickTime = Date.now();
            await clickAt(send, resPos.x, resPos.y);
            const movedTo = await waitAndMoveDownload(clickTime);
            downloadedNote = movedTo
              ? `Downloaded image #${n} at ${flags.res} -> ${movedTo}`
              : `Clicked ${flags.res} but no new file appeared in ${CHROME_DEFAULT_DOWNLOADS} within 20s`;
            (movedTo ? console.log : console.error)(`[${label}] ${downloadedNote}`);
          } else {
            downloadedNote = `Could not find resolution option "${flags.res}"`;
            console.error(`[${label}] ${downloadedNote}`);
          }
        } else {
          downloadedNote = 'Could not find Download menu item';
          console.error(`[${label}] ${downloadedNote}`);
        }
      } else {
        downloadedNote = `No image at index ${n}`;
        console.error(`[${label}] ${downloadedNote}`);
      }
    }

    // 9. Append to build log + decisions log
    const now = new Date().toISOString();
    const excerpt = text.trim().split('\n').slice(0, 3).join(' ').slice(0, 200);
    await appendFile(BUILD_LOG, `\n## ${now} — ${label}\n- Elapsed: ${elapsed}s\n- Screenshot: downloads/${shotName}\n- Prompt file: ${flags.file || '(inline)'}\n- Excerpt: ${excerpt}...\n${downloadedNote ? `- ${downloadedNote}\n` : ''}`);
    await appendFile(DECISIONS_LOG, `\n## ${label} (${now.slice(0, 10)})\n- **Essence:** ${excerpt}...\n- **Result:** (fill in after review) — 4 images generated, screenshot at downloads/${shotName}\n- **Keep for next time:** (note what worked / what to change)\n`);

    console.log(`[${label}] Logged. Screenshot: ${shotPath}`);
  } finally {
    ws.close();
  }
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
