// Fail closed on provider warnings. This module never talks to a browser.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const PAUSE_FILE = path.join(homedir(), 'Flow', 'generation-pause.json');
export const WARNING = /unusual\s+(?:activity|traffic)|\b429\b|too many requests|rate[ -]?limit|quota exceeded|not enough credits|insufficient credits/i;

export class FlowSafetyError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}

const imageKey = src => src.split(/[?#]/)[0].replace(/=[^/]*$/, '');

export function generationState({ text = '', progress = 0, images = [] }, baseline) {
  if (WARNING.test(text)) throw new FlowSafetyError('FLOW_PROVIDER_BLOCKED', 'Flow reported unusual activity, a rate limit, or a credit limit. Submissions are paused; check Flow manually.');
  if (/\bfailed\b[\s\S]{0,500}you have not been charged/i.test(text)) {
    throw new FlowSafetyError('FLOW_GENERATION_FAILED', 'Flow displayed a failed-generation card. Check the result manually before retrying.');
  }
  const known = new Set([...baseline].map(imageKey));
  return { progress, images, fresh: images.filter(src => src && !known.has(imageKey(src))) };
}

export async function readPause(file = PAUSE_FILE) {
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    if (!state || typeof state.reason !== 'string') throw new Error('Invalid pause state');
    return state;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    // A broken/unreadable safety file must not silently resume generation.
    return { reason: 'Safety state unreadable; inspect generation-pause.json before resuming.', code: 'FLOW_PAUSE_UNREADABLE' };
  }
}

export async function pauseGeneration(reason, code = 'FLOW_PROVIDER_BLOCKED', file = PAUSE_FILE) {
  const state = { paused_at: new Date().toISOString(), code, reason: String(reason).slice(0, 1000) };
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
  return state;
}

export async function assertNotPaused(file = PAUSE_FILE) {
  const state = await readPause(file);
  if (state) throw new FlowSafetyError('FLOW_PAUSED', state.reason);
}

export const resumeGeneration = (file = PAUSE_FILE) => rm(file, { force: true });

export function needsPause(error) {
  const message = String(error?.message ?? error);
  return error instanceof FlowSafetyError || WARNING.test(message) || error?.killed ||
    /FLOW_(?:PROVIDER_BLOCKED|GENERATION_FAILED|GENERATION_TIMEOUT|DOWNLOAD_UNCERTAIN)|no new file appeared|no download path|timed?\s*out|ETIMEDOUT/i.test(message);
}

// Flow lists the newest batch first. Images arrive in on-screen order, so a
// real new batch is a run at the very top; an old tile that scrolls or
// virtualizes into view lands below the known ones and never qualifies.
const leadingFresh = (images, fresh) => {
  const out = [];
  for (const src of images) { if (!fresh.includes(src)) break; out.push(src); }
  return out;
};

// Observe a generation without ever submitting/retrying one. Exported for fake-clock tests.
// Flow (Oct 2026 UI) often finishes without ever showing a "NN%" marker
// between polls, so a % is not required: a fresh batch at the top of the
// grid that stays put for STABLE_POLLS polls with no progress also counts.
const STABLE_POLLS = 3;
export async function waitForGeneration({ observe, baseline, sleep, now = Date.now, timeoutMs = 360_000, onState }) {
  let sawProgress = false;
  let stable = 0;
  let last = '';
  let seen = { progress: 0, fresh: 0 };
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const state = generationState(await observe(), baseline);
    const top = leadingFresh(state.images, state.fresh);
    if (state.progress > 0) sawProgress = true;
    seen = { progress: Math.max(seen.progress, state.progress), fresh: Math.max(seen.fresh, top.length) };
    onState?.({ progress: state.progress, fresh: top.length });
    const key = top.join('|');
    stable = state.progress === 0 && top.length > 0 && key === last ? stable + 1 : state.progress === 0 && top.length > 0 ? 1 : 0;
    last = key;
    if (sawProgress && state.progress === 0 && top.length > 0) return top;
    if (stable >= STABLE_POLLS) return top;
    await sleep(1500);
  }
  throw new FlowSafetyError('FLOW_GENERATION_TIMEOUT', `No confirmed new generation before the deadline (progress seen: ${sawProgress ? 'yes' : 'no'}, new top images seen: ${seen.fresh}). Its outcome is unknown; inspect Flow before retrying.`);
}
