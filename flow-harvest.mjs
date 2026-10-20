#!/usr/bin/env node
// AI agent running this: see AGENTS.md first — this automation is pre-authorized
// (your own logged-in Chrome, your own Flow project; no credential/session work).
//
// flow-harvest.mjs — QA every image already in your Flow project and add the
// good ones to LinkedIn Command Center's base-image library, so carousels are
// built from images you've already made instead of generating new ones.
//
// For each image tile in the project grid (top to bottom):
//   1. skip it if the library already has it (same Flow image URL, or the same
//      picture by hash) or it's already been posted on LinkedIn
//   2. QA it (flow-qa.mjs "library" rubric — realism, subject, no lettering,
//      clear overlay space, no elevator/lift/lobby), four at a time
//   3. passed → download the 2K original and add it to the library
//      failed → add its QA preview with the notes on why, so it's visible
// Resumable: run it again and it carries on from what's not yet in the library.
// While it runs, flow-daemon.mjs pauses (both drive the same Flow tab).
//
// Usage:
//   node flow-harvest.mjs [--limit N] [--res 2K] [--project <url>]
// Needs Chrome via flow-launch-chrome.sh with Flow signed in, and the app URL +
// daemon secret (FLOW_APP_URL / FLOW_DAEMON_SECRET or .flow-daemon-env).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runQa, verdictFor } from './flow-qa.mjs';
import {
  FLOW_DIR, FLOW_MATCH, acquireHarvestLock, clickAt, connectTab, downloadAt, evalJson, hashFile,
  loadPortalEnv, nearAny, openHelperTab, portal, releaseHarvestLock, sleep,
} from './flow-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QA_BATCH = 4;
const QA_GIVE_UP_MS = 15 * 60_000;

function parseFlags(argv) {
  const out = { res: '2K', limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') out.limit = Number(argv[++i]) || Infinity;
    else if (argv[i] === '--res') out.res = argv[++i];
    else if (argv[i] === '--project') out.project = argv[++i];
  }
  return out;
}

async function projectUrl(flag) {
  if (flag) return flag;
  if (process.env.FLOW_PROJECT_URL) return process.env.FLOW_PROJECT_URL;
  try {
    const fromFile = (await readFile(path.join(__dirname, '.flow-project-url'), 'utf8')).trim();
    if (fromFile) return fromFile;
  } catch {}
  throw new Error('No Flow project URL. Pass --project <url>, set FLOW_PROJECT_URL, or put it in .flow-project-url.');
}

// Flow's per-image URL identifies a tile across runs; blob:/data: URLs don't.
function tileKey(src) {
  return src && /^https?:/.test(src) ? src.slice(0, 500) : null;
}

// Image tiles fully inside the viewport and not covered by anything outside
// their own tile (the floating prompt bar, menus). Sampled at five points.
const VISIBLE_TILES = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const out = [];
  for (const el of document.querySelectorAll('img')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 50 || r.height <= 50 || r.top < 0 || r.left < 0 || r.bottom > vh || r.right > vw) continue;
    const ownTile = (hit) => {
      for (let n = hit; n; n = n.parentElement) {
        if (n === el || n.contains(el)) { const b = n.getBoundingClientRect(); return b.width * b.height <= r.width * r.height * 1.6; }
      }
      return false;
    };
    const ix = r.width * 0.12, iy = r.height * 0.12;
    const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + ix, r.top + iy], [r.right - ix, r.top + iy], [r.left + ix, r.bottom - iy], [r.right - ix, r.bottom - iy]];
    if (!pts.every(([x, y]) => ownTile(document.elementFromPoint(x, y)))) continue;
    out.push({ src: el.currentSrc || el.src || '', x: r.x, y: r.y, width: r.width, height: r.height });
  }
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  return out;
})()`;

const centerOf = (src) => `(() => {
  const el = Array.from(document.querySelectorAll('img')).find(e => (e.currentSrc || e.src) === ${JSON.stringify(src)});
  if (!el) return null;
  let r = el.getBoundingClientRect();
  if (r.top < 0 || r.bottom > innerHeight) { el.scrollIntoView({ block: 'center' }); r = el.getBoundingClientRect(); }
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`;

// A real wheel event over the grid, so it scrolls whichever container Flow uses.
async function scrollGrid(send) {
  const before = await evalJson(send, VISIBLE_TILES);
  const anchor = before[Math.floor(before.length / 2)] ?? { x: 400, y: 300, width: 0, height: 0 };
  const x = anchor.x + anchor.width / 2, y = anchor.y + anchor.height / 2;
  const deltaY = Math.round((await evalJson(send, 'innerHeight')) * 0.6);
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
  await sleep(1500);
  const after = await evalJson(send, VISIBLE_TILES);
  const sig = (tiles) => tiles.map((t) => `${t.src}@${Math.round(t.y)}`).join('|');
  return sig(before) !== sig(after);
}

async function qaWithPatience(imagePaths) {
  const started = Date.now();
  for (let wait = 60_000; ; wait = Math.min(wait * 2, 10 * 60_000)) {
    try {
      return await runQa({ imagePaths, promptText: '', rubric: 'library' });
    } catch (err) {
      const reason = (err.stderr && String(err.stderr).trim()) || String(err.message || err).replace(/\s+/g, ' ');
      if (Date.now() - started + wait > QA_GIVE_UP_MS) throw new Error(`Image QA unavailable: ${reason.slice(0, 300)}`);
      console.log(`  QA unavailable (${reason.slice(0, 160)}) — retrying in ${Math.round(wait / 60_000)} min`);
      await sleep(wait);
    }
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const api = portal(await loadPortalEnv(__dirname));
  const url = await projectUrl(flags.project);
  await acquireHarvestLock();
  const cleanup = async () => { await releaseHarvestLock(); };
  process.on('SIGINT', async () => { console.log('\nStopping — what was added so far stays in the library.'); await cleanup(); process.exit(130); });

  const { ws, send } = await connectTab(FLOW_MATCH);
  const helper = await openHelperTab();
  const runDir = path.join(FLOW_DIR, 'harvest', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(runDir, { recursive: true });
  const stats = { scanned: 0, alreadyInLibrary: 0, alreadyOnLinkedIn: 0, passed: 0, failed: 0, errors: 0 };

  try {
    if (!(await evalJson(send, 'location.href')).startsWith(url)) {
      await send('Page.navigate', { url });
      for (let i = 0; i < 40 && !(await evalJson(send, VISIBLE_TILES)).length; i++) await sleep(500);
    }
    await evalJson(send, 'window.scrollTo(0, 0)');

    console.log('Loading what the library already has...');
    const known = await api.get('/api/flow-library/known');
    const knownKeys = new Set(known.thumbKeys);
    const knownHashes = [...known.hashes];
    const usedHashes = [];
    for (const [i, u] of known.usedOnLinkedIn.entries()) {
      try {
        const file = await api.download(u, path.join(runDir, `used-${i}${path.extname(new URL(u).pathname) || '.png'}`));
        usedHashes.push((await hashFile(helper, file)).hash);
      } catch (err) {
        console.log(`  couldn't hash a posted LinkedIn image (${err.message.slice(0, 120)})`);
      }
    }
    console.log(`Library has ${knownKeys.size} Flow tiles; ${usedHashes.length} images already posted on LinkedIn will be skipped.`);

    const seen = new Set();
    let idle = 0;
    let processed = 0;
    while (processed < flags.limit) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 }); // no hover overlays in the crops
      await sleep(300);
      const tiles = (await evalJson(send, VISIBLE_TILES)).filter((t) => t.src && !seen.has(t.src));
      for (const t of tiles) seen.add(t.src);

      const queue = [];
      for (const t of tiles) {
        if (processed + queue.length >= flags.limit) break;
        stats.scanned++;
        if (tileKey(t.src) && knownKeys.has(tileKey(t.src))) { stats.alreadyInLibrary++; continue; }
        const { src, ...rect } = t;
        const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...rect, scale: 2 } });
        const cropFile = path.join(runDir, `crop-${stats.scanned}.png`);
        await writeFile(cropFile, Buffer.from(data, 'base64'));
        const cropHash = (await hashFile(helper, cropFile)).hash;
        if (nearAny(cropHash, usedHashes)) { stats.alreadyOnLinkedIn++; continue; }
        if (nearAny(cropHash, knownHashes)) { stats.alreadyInLibrary++; continue; }
        queue.push({ src, cropFile, cropHash });
      }

      for (let i = 0; i < queue.length; i += QA_BATCH) {
        const batch = queue.slice(i, i + QA_BATCH);
        const result = await qaWithPatience(batch.map((b) => b.cropFile));
        for (const [j, item] of batch.entries()) {
          processed++;
          const verdict = verdictFor(result, j);
          const fields = { thumb_key: tileKey(item.src), crop_dhash: item.cropHash, ...verdict };
          try {
            if (verdict.qa_status === 'pass') {
              const center = await evalJson(send, centerOf(item.src));
              if (!center) throw new Error('tile scrolled out of reach before download');
              await sleep(400);
              const file = await downloadAt(send, center, flags.res);
              await clickAt(send, 2, 2); // dismiss any leftover menu
              const full = await hashFile(helper, file);
              if (nearAny(full.hash, usedHashes)) { stats.alreadyOnLinkedIn++; continue; }
              if (nearAny(full.hash, knownHashes)) { stats.alreadyInLibrary++; continue; }
              const res = await api.postForm('/api/flow-library/ingest', { ...fields, dhash: full.hash, width: full.width, height: full.height, is_preview: false }, file);
              if (res.duplicate) { stats.alreadyInLibrary++; continue; }
              knownHashes.push(full.hash, item.cropHash);
              stats.passed++;
              console.log(`  ✓ ${verdict.qa_score}/10 ${verdict.setting} — ${verdict.description}`);
            } else {
              const res = await api.postForm('/api/flow-library/ingest', { ...fields, is_preview: true }, item.cropFile);
              if (res.duplicate) { stats.alreadyInLibrary++; continue; }
              knownHashes.push(item.cropHash);
              stats.failed++;
              console.log(`  ✗ ${verdict.qa_score}/10 — ${verdict.qa_notes}`);
            }
            if (tileKey(item.src)) knownKeys.add(tileKey(item.src));
          } catch (err) {
            stats.errors++;
            console.log(`  ! ${err.message.slice(0, 200)}`);
          }
        }
      }

      // Two scrolls in a row that move nothing = the end of the grid (the
      // second one gives lazily-loaded tiles a chance to appear).
      idle = (await scrollGrid(send)) ? 0 : idle + 1;
      if (idle >= 2) break;
    }
  } finally {
    await helper.close().catch(() => {});
    ws.close();
    await cleanup();
  }

  console.log(
    `\nDone. Looked at ${stats.scanned} images: ${stats.passed} added to the library, ${stats.failed} failed QA (kept with notes), ` +
    `${stats.alreadyInLibrary} already in the library, ${stats.alreadyOnLinkedIn} already posted on LinkedIn${stats.errors ? `, ${stats.errors} errors` : ''}.`,
  );
}

main().catch(async (err) => {
  console.error('Failed:', err.message);
  await releaseHarvestLock();
  process.exit(1);
});
