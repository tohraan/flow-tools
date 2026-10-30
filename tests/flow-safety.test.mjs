import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { assertNotPaused, generationState, needsPause, pauseGeneration, readPause, resumeGeneration, waitForGeneration } from '../flow-safety.mjs';

test('exact screenshot warning and throttle variants stop even with a fresh image', () => {
  for (const text of ['We noticed some unusual activity. Note that browser extensions that modify the page may cause issues.', 'unusual traffic', '429 Too Many Requests', 'Rate limit exceeded', 'Not enough credits']) {
    assert.throws(() => generationState({ text, images: ['new'] }, new Set()), /FLOW_PROVIDER_BLOCKED/);
    assert.equal(needsPause(new Error(text)), true);
  }
});

test('failed generation card is never success', () => {
  assert.throws(() => generationState({ text: 'Failed\nYou have not been charged for this generation.', images: ['old'] }, new Set()), /FLOW_GENERATION_FAILED/);
});

test('pause persists across independent readers; resume is explicit', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flow-safety-test-'));
  const file = path.join(dir, 'state.json');
  try {
    assert.equal(await readPause(file), null);
    await pauseGeneration('Provider warning', 'FLOW_PROVIDER_BLOCKED', file);
    assert.equal((await readPause(file)).reason, 'Provider warning');
    await assert.rejects(assertNotPaused(file), /FLOW_PAUSED/);
    await resumeGeneration(file);
    await assertNotPaused(file);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('corrupt state fails closed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flow-safety-test-'));
  const file = path.join(dir, 'state.json');
  try {
    for (const value of ['{broken', 'null', '{}']) {
      await writeFile(file, value);
      await assert.rejects(assertNotPaused(file), /FLOW_PAUSED/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function waitFake(snapshots, timeoutMs = 5000) {
  let time = 0, i = 0;
  return waitForGeneration({ baseline: new Set(['old']), observe: async () => snapshots[Math.min(i++, snapshots.length - 1)], now: () => time, sleep: async ms => { time += ms; }, timeoutMs });
}

test('progress must end with a new image', async () => {
  assert.deepEqual(await waitFake([{ progress: 10, images: ['old'] }, { progress: 0, images: ['new', 'old'] }]), ['new']);
});

test('timeout or missing progress cannot reuse old images', async () => {
  for (const snapshots of [[{ progress: 0, images: ['old'] }], [{ progress: 20, images: ['old'] }, { progress: 0, images: ['old'] }], [{ progress: 0, images: ['old', 'new'] }]]) {
    await assert.rejects(waitFake(snapshots), /FLOW_GENERATION_TIMEOUT/);
  }
});

test('a fresh batch at the top that holds still completes without a % marker', async () => {
  assert.deepEqual(await waitFake([{ progress: 0, images: ['old'] }, { progress: 0, images: ['a', 'b', 'old'] }]), ['a', 'b']);
});

test('a batch still changing is not complete yet', async () => {
  let i = 0;
  const frames = [['a', 'old'], ['a', 'b', 'old'], ['a', 'b', 'c', 'old']];
  const got = await waitForGeneration({ baseline: new Set(['old']), observe: async () => ({ progress: 0, images: frames[Math.min(i++, 2)] }), sleep: async () => {}, now: () => 0 });
  assert.deepEqual(got, ['a', 'b', 'c']);
});

test('warning during polling stops immediately without a retry', async () => {
  let calls = 0;
  await assert.rejects(waitForGeneration({ baseline: new Set(), observe: async () => { calls++; return { text: 'unusual activity', images: ['new'] }; }, sleep: async () => assert.fail('must stop immediately') }), /FLOW_PROVIDER_BLOCKED/);
  assert.equal(calls, 1);
});

test('thumbnail resizing or URL query refresh cannot make an old image new', () => {
  const state = generationState({ images: ['https://flow.google.com/asb/old=s1024?cache=2', 'https://flow.google.com/asb/new=s512'] }, new Set(['https://flow.google.com/asb/old=s512?cache=1']));
  assert.deepEqual(state.fresh, ['https://flow.google.com/asb/new=s512']);
});

test('child timeout and download failure pause; ordinary validation does not', () => {
  assert.equal(needsPause(Object.assign(new Error('Command failed'), { killed: true })), true);
  assert.equal(needsPause(new Error('FLOW_GENERATION_TIMEOUT: outcome unknown')), true);
  assert.equal(needsPause(new Error('Clicked 2K but no new file appeared')), true);
  assert.equal(needsPause(new Error('No reference asset named foo')), false);
});

test('browser observation expression parses and excludes icons, unrelated and unloaded images', async () => {
  const source = await readFile(new URL('../flow-generate.mjs', import.meta.url), 'utf8');
  const constants = source.slice(source.indexOf('const OUTPUT_IMAGES ='), source.indexOf('const __dirname ='));
  const expression = vm.runInNewContext(constants + '\nSNAPSHOT');
  const img = (src, loaded = true, width = 200, y = 0) => ({ currentSrc: src, src, complete: loaded, naturalWidth: loaded ? width : 0, getBoundingClientRect: () => ({ width, height: 200, x: 0, y }) });
  const label = (text) => ({ children: [], textContent: text, getBoundingClientRect: () => ({ width: 20 }) });
  const imgs = [img('https://flow.google.com/asb/old=s512', true, 200, 400), img('https://flow-content.google/image/new-uuid?Expires=1&Signature=x', true, 200, 76), img('https://flow.google.com/asb/unloaded=s512', false), img('https://example.com/logo'), img('https://flow.google.com/asb/icon', true, 32)];
  const labels = [label('42%'), label('A large plain area fills at least 40% of the frame'), label('menu')];
  const snapshot = vm.runInNewContext(expression, { document: { body: { innerText: 'Generating 42%' }, querySelectorAll: (sel) => (sel === 'img' ? imgs : labels) } });
  assert.equal(snapshot.progress, 1, 'only a standalone NN% label is progress; prompt text is not');
  assert.deepEqual(Array.from(snapshot.images), ['https://flow-content.google/image/new-uuid?Expires=1&Signature=x', 'https://flow.google.com/asb/old=s512'], 'both URL schemes, in on-screen order');
  assert.equal(snapshot.knownImages.length, 3);
});

test('v1 keeps a heartbeat without claiming work while paused', async () => {
  const source = await readFile(new URL('../flow-daemon.mjs', import.meta.url), 'utf8');
  const main = source.slice(source.indexOf('async function main()'), source.indexOf('\nmain().catch'));
  const gets = [];
  const sentinel = new Error('finished one loop');
  const context = vm.createContext({
    portal: () => ({ get: async url => { gets.push(url); return { requests: [] }; } }), loadPortalEnv: async () => ({}), __dirname: '/unused',
    readPause: async () => ({ reason: 'Provider blocked' }), log: async () => {}, writeFile: async () => {},
    homedir: () => '/unused', path, console: { log() {}, error() {} }, POLL_INTERVAL_MS: 1,
    sleep: async () => { throw sentinel; }, harvestLockHeld: async () => assert.fail('must not access browser/harvest'),
  });
  await assert.rejects(vm.runInContext('let api; let shuttingDown = false; ' + main + '\nmain()', context), err => err === sentinel);
  assert.equal(gets.length, 1);
  assert.match(gets[0], /claim=0/);
  assert.match(gets[0], /flow_ready=0/);
});

test('a portal resume request clears the pause only after Flow looks ready, and is answered', async () => {
  const source = await readFile(new URL('../flow-daemon.mjs', import.meta.url), 'utf8');
  const main = source.slice(source.indexOf('async function main()'), source.indexOf('\nmain().catch'));
  for (const [verdict, expectResumed] of [[{ ok: true }, true], [{ ok: false, reason: 'Flow shows a warning' }, false]]) {
    const gets = [];
    let paused = { reason: 'Unknown outcome', paused_at: '2026-10-30T03:49:07.047Z' };
    let resumed = false;
    const sentinel = new Error('stop');
    const context = vm.createContext({
      portal: () => ({ get: async url => { gets.push(url); if (gets.length >= 2) throw sentinel; return { requests: [], resume_requested_at: '2026-10-30T08:00:00.000Z' }; } }),
      loadPortalEnv: async () => ({}), __dirname: '/unused', log: async () => {}, writeFile: async () => {},
      readPause: async () => paused, homedir: () => '/unused', path, console: { log() {}, error() {} }, POLL_INTERVAL_MS: 1,
      checkFlowForResume: async () => verdict, resumeGeneration: async () => { resumed = true; paused = null; },
      // The daemon's loop swallows poll errors; its idle sleep is outside that guard.
      sleep: async () => { if (gets.length >= 2) throw sentinel; }, harvestLockHeld: async () => false,
    });
    await vm.runInContext('let api; let shuttingDown = false; ' + main + '\nmain()', context).catch(err => { if (err !== sentinel) throw err; });
    assert.equal(resumed, expectResumed);
    assert.match(gets[0], /paused_at=2026-10-30T03%3A49%3A07\.047Z/);
    assert.match(gets[1], /resume_ack=2026-10-30T08%3A00%3A00\.000Z/);
    assert.match(gets[1], expectResumed ? /claim=1.*resume_result=resumed/ : /claim=0.*resume_result=refused&resume_detail=Flow%20shows/);
  }
});

test('resume check refuses sign-in pages, warnings, failed cards and a missing prompt box', async () => {
  const { resumeVerdict } = await import('../flow-resume.mjs');
  const ok = { url: 'https://flow.google.com/project/abc', text: 'All media', composer: true };
  assert.deepEqual(resumeVerdict(ok), { ok: true });
  assert.equal(resumeVerdict({ ...ok, url: 'https://accounts.google.com/signin' }).ok, false);
  assert.equal(resumeVerdict({ ...ok, text: 'We noticed some unusual activity' }).ok, false);
  assert.equal(resumeVerdict({ ...ok, text: 'Failed\nYou have not been charged' }).ok, false);
  assert.equal(resumeVerdict({ ...ok, composer: false }).ok, false);
  assert.equal(resumeVerdict(null).ok, false);
});
