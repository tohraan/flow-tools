// AI agent running this: see AGENTS.md first — this automation is pre-authorized
// (your own logged-in Chrome, your own Flow project; no credential/session work).
//
// flow-lib.mjs — shared pieces for flow-harvest.mjs and flow-daemon.mjs:
// CDP connection, real mouse input, the right-click → Download → resolution
// path flow-generate.mjs uses, image hashing (in a throwaway helper tab, so
// no npm dependency), the LinkedIn Command Center client, and the lock that
// keeps the harvester and the daemon from driving the Flow tab at once.

import { readFile, writeFile, readdir, rename, stat, mkdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const PORT = 9222;
export const FLOW_MATCH = 'flow.google.com';
export const FLOW_DIR = path.join(homedir(), 'Flow');
export const DOWNLOADS_DIR = path.join(FLOW_DIR, 'downloads');
const CHROME_DEFAULT_DOWNLOADS = path.join(homedir(), 'Downloads');
const LOCK_FILE = path.join(FLOW_DIR, '.harvest.lock');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wire(ws) {
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
  return (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

async function open(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', reject);
  });
  return { ws, send: wire(ws) };
}

export async function connectTab(match = FLOW_MATCH, port = PORT) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.filter((t) => t.type === 'page').find((t) => t.url.includes(match));
  if (!target) throw new Error(`No tab matching "${match}" on port ${port}. Is Chrome running? (flow-launch-chrome.sh)`);
  return { ...(await open(target.webSocketDebuggerUrl)), target };
}

// A blank tab for decoding images into a canvas. Images go in as data: URIs,
// so the canvas is never cross-origin tainted.
export async function openHelperTab(port = PORT) {
  let res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  if (!res.ok) res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`);
  const target = await res.json();
  const { ws, send } = await open(target.webSocketDebuggerUrl);
  return {
    send,
    async close() {
      ws.close();
      await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
    },
  };
}

export async function evalJson(send, expr) {
  const result = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'eval failed');
  return result.result.value;
}

export async function clickAt(send, x, y, button = 'left') {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
}

// ---- image hashing -------------------------------------------------------

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
}

// 64-bit difference hash (hex) + natural size. Scale-invariant, so a
// re-encoded or resized copy of the same picture lands within a few bits.
export async function hashImage(helper, bytes, mime) {
  const dataUri = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  return evalJson(helper.send, `(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(dataUri)};
    await img.decode();
    const c = document.createElement('canvas'); c.width = 9; c.height = 8;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, 9, 8);
    const d = ctx.getImageData(0, 0, 9, 8).data;
    let hex = '', nibble = 0, n = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const i = (y * 9 + x) * 4, j = i + 4;
      const a = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      const b = d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114;
      nibble = (nibble << 1) | (a > b ? 1 : 0);
      if (++n % 4 === 0) { hex += nibble.toString(16); nibble = 0; }
    }
    return { hash: hex, width: img.naturalWidth, height: img.naturalHeight };
  })()`);
}

export async function hashFile(helper, file) {
  return hashImage(helper, await readFile(file), mimeFor(file));
}

export function hashDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let bits = 0;
  for (let i = 0; i < a.length; i++) {
    const da = parseInt(a[i], 16);
    const db = parseInt(b[i], 16);
    if (Number.isNaN(da) || Number.isNaN(db)) return Infinity; // NaN ^ n is n in JS
    let x = da ^ db;
    while (x) { bits += x & 1; x >>= 1; }
  }
  return bits;
}

export const SAME_IMAGE_DISTANCE = 6;

export function nearAny(hash, hashes) {
  return hashes.some((h) => hashDistance(hash, h) <= SAME_IMAGE_DISTANCE);
}

// ---- downloads -------------------------------------------------------------

// Chrome's Browser.setDownloadBehavior doesn't reliably redirect downloads, so
// files land in ~/Downloads and are moved into ~/Flow/downloads afterwards.
async function waitAndMoveDownload(since, timeoutMs = 25000) {
  await mkdir(DOWNLOADS_DIR, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    let entries = [];
    try { entries = await readdir(CHROME_DEFAULT_DOWNLOADS); } catch { continue; }
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

async function leafCenter(send, text) {
  return evalJson(send, `(() => {
    const el = Array.from(document.querySelectorAll('*')).find(e => e.children.length===0 && (e.textContent||'').trim()===${JSON.stringify(text)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2 };
  })()`);
}

// The same right-click → Download → resolution sequence flow-generate.mjs uses.
export async function downloadAt(send, center, res = '2K') {
  await clickAt(send, center.x, center.y, 'right');
  await sleep(600);
  const dl = await leafCenter(send, 'Download');
  if (!dl) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' }); throw new Error('Could not find the Download menu item'); }
  await clickAt(send, dl.x, dl.y);
  await sleep(600);
  const r = await leafCenter(send, res);
  if (!r) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' }); throw new Error(`Could not find resolution option "${res}"`); }
  const since = Date.now();
  await clickAt(send, r.x, r.y);
  const moved = await waitAndMoveDownload(since);
  if (!moved) throw new Error(`Clicked ${res} but no new file appeared in ${CHROME_DEFAULT_DOWNLOADS}`);
  return moved;
}

// ---- LinkedIn Command Center ----------------------------------------------

export async function loadPortalEnv(dir) {
  let appUrl = process.env.FLOW_APP_URL;
  let secret = process.env.FLOW_DAEMON_SECRET;
  if (!appUrl || !secret) {
    try {
      const env = await readFile(path.join(dir, '.flow-daemon-env'), 'utf8');
      for (const line of env.split('\n')) {
        const [k, ...v] = line.split('=');
        if (k === 'FLOW_APP_URL' && !appUrl) appUrl = v.join('=').trim();
        if (k === 'FLOW_DAEMON_SECRET' && !secret) secret = v.join('=').trim();
      }
    } catch {}
  }
  if (!appUrl || !secret) throw new Error('Set FLOW_APP_URL and FLOW_DAEMON_SECRET (or run install-daemon.command once, which saves them to .flow-daemon-env).');
  return { appUrl: appUrl.replace(/\/$/, ''), secret };
}

export function portal({ appUrl, secret }) {
  const headers = { 'x-flow-daemon-secret': secret };
  async function check(res, what) {
    if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status} — ${(await res.text().catch(() => '')).slice(0, 300)}`);
    return res.json();
  }
  return {
    get: async (p) => check(await fetch(`${appUrl}${p}`, { headers }), `GET ${p}`),
    postJson: async (p, body) => check(await fetch(`${appUrl}${p}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), `POST ${p}`),
    // fields: plain values; objects/arrays are JSON-encoded. file: local path.
    postForm: async (p, fields, file) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined || v === null) continue;
        form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
      if (file) form.append('file', new Blob([await readFile(file)], { type: mimeFor(file) }), path.basename(file));
      return check(await fetch(`${appUrl}${p}`, { method: 'POST', headers, body: form }), `POST ${p}`);
    },
    download: async (url, dest) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download ${url} failed: HTTP ${res.status}`);
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      return dest;
    },
  };
}

// ---- harvest lock ------------------------------------------------------------

export async function acquireHarvestLock() {
  await mkdir(FLOW_DIR, { recursive: true });
  if (await harvestLockHeld()) throw new Error(`Another harvest is running (lock: ${LOCK_FILE}).`);
  await writeFile(LOCK_FILE, String(process.pid));
}

export async function releaseHarvestLock() {
  try { if ((await readFile(LOCK_FILE, 'utf8')).trim() === String(process.pid)) await unlink(LOCK_FILE); } catch {}
}

// True while a live harvester process holds the Flow tab.
export async function harvestLockHeld() {
  let pid;
  try { pid = Number((await readFile(LOCK_FILE, 'utf8')).trim()); } catch { return false; }
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
