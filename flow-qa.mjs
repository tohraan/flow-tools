#!/usr/bin/env node
// flow-qa.mjs — scores Flow images and picks the best.
//
// Three rubrics:
//   surface  — a single-post "format hijack" image with on-image text: the text
//              surface fully in frame, the founder looking at it, the text exact,
//              the surface physically installed, thumbnail legibility.
//   photo    — a text-free base photograph for a carousel overlay (generated
//              against a brief): realism, subject, no lettering, clear overlay
//              space, scene matches the brief.
//   library  — the same as photo but with no brief: used by flow-harvest.mjs to
//              QA images already sitting in the Flow project.
// Every rubric also returns a coarse `setting` (from SETTINGS, so images of one
// scene group together) and a short description, which the portal uses to
// build carousels from one consistent photo series.
//
// Scoring is done by a headless `claude -p` call that reads the image files, so
// no API key is needed — it runs on the operator's own Claude Code login. The
// call runs with the operator's own hooks, plugins, MCP servers and CLAUDE.md
// switched off (see isolationFlags), and when it fails the error says what
// the CLI actually reported (see QaUnavailableError).
//
// Used two ways:
//   1. By flow-generate.mjs --qa, flow-harvest.mjs and flow-daemon.mjs (imports).
//   2. Standalone, on images you already have:
//        node flow-qa.mjs --prompt prompt.txt [--rubric photo|surface|library] img0.png img1.png ...
//
// Env (optional):
//   FLOW_QA_CLAUDE   path to the claude binary (default ~/.local/bin/claude,
//                    then `claude` on PATH — LaunchAgents have no PATH)
//   FLOW_QA_MODEL    model alias passed to claude --model (default "sonnet")

import { readFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export const RUBRICS = {
  surface: { checks: ['surface_in_frame', 'founder_gaze', 'text_match', 'installed', 'thumbnail'], hard: ['surface_in_frame', 'founder_gaze', 'text_match', 'installed'], tiebreak: 'text_match' },
  photo: { checks: ['photo_realism', 'subject_match', 'text_free', 'overlay_space', 'scene_match'], hard: ['photo_realism', 'subject_match', 'text_free', 'overlay_space', 'scene_match'], tiebreak: 'scene_match' },
  library: { checks: ['photo_realism', 'subject_match', 'text_free', 'overlay_space', 'scene_ok'], hard: ['photo_realism', 'subject_match', 'text_free', 'overlay_space', 'scene_ok'], tiebreak: 'overlay_space' },
};
const PASS_TOTAL = 8;

// Coarse scene vocabulary. The portal groups library images on this value to
// build a carousel from one consistent series (src/lib/studio/library.ts), so
// it's a fixed list rather than free text.
export const SETTINGS = [
  'home desk at night', 'home desk by day', 'office interior', 'meeting room', 'cafe interior',
  'terrace or balcony with skyline', 'street or outdoor city', 'building exterior or plaza',
  'transit or airport', 'studio portrait', 'empty scene', 'other',
];

async function claudeBin() {
  if (process.env.FLOW_QA_CLAUDE) return process.env.FLOW_QA_CLAUDE;
  const local = path.join(homedir(), '.local', 'bin', 'claude');
  try { await access(local); return local; } catch { return 'claude'; }
}

// QA couldn't run (as opposed to an image failing QA). `kind` tells callers
// whether waiting helps: 'transient' (timeout, overload) and 'limit' (usage
// limit; retryAt when the CLI says when it resets) are worth retrying;
// 'auth' and 'setup' need the operator.
export class QaUnavailableError extends Error {
  constructor(reason, kind, retryAt = null) {
    super(reason);
    this.name = 'QaUnavailableError';
    this.kind = kind;
    this.retryAt = retryAt;
  }
}

// Printed whenever stdin is a pipe with nothing in it. Harmless, and it used
// to be the only thing in stderr, hiding the real failure.
const STDIN_NOTICE = /^Warning: no stdin data received.*$/gm;

// What a failed `claude -p --output-format json` call actually said. API
// errors (usage limit, auth, overload, bad model) come back as JSON on stdout
// with is_error set, not on stderr.
export function describeClaudeFailure(err, { timeoutMs = 0, bin = 'claude' } = {}) {
  if (err.code === 'ENOENT') return `Claude CLI not found at ${bin}. Set FLOW_QA_CLAUDE to its path.`;
  if (err.killed || err.signal) return `QA call timed out after ${Math.round(timeoutMs / 1000)}s`;
  let json = null;
  try { json = JSON.parse(String(err.stdout || '')); } catch {}
  const said = json && (json.result || json.terminal_reason || json.subtype);
  if (said) return `${String(said).trim()}${json.api_error_status ? ` (HTTP ${json.api_error_status})` : ''}`;
  const stderr = String(err.stderr || '').replace(STDIN_NOTICE, '').trim();
  return stderr || `claude exited with code ${err.code ?? 'unknown'} and no message`;
}

export function classifyQaFailure(reason) {
  if (/not found at|unknown option|unrecognized|not a valid model|issue with the selected model/i.test(reason)) return 'setup';
  if (/log ?in|logged out|signed out|not authenticated|api key|unauthori[sz]ed|oauth|credential|HTTP 40[13]/i.test(reason)) return 'auth';
  if (/usage limit|hit your limit|limit reached|quota|rate.?limit|HTTP 429/i.test(reason)) return 'limit';
  return 'transient';
}

function qaUnavailable(reason) {
  const kind = classifyQaFailure(reason);
  // Older CLIs report a usage limit as "Claude AI usage limit reached|<epoch seconds>".
  const epoch = kind === 'limit' ? reason.match(/\|(\d{10})\b/) : null;
  return new QaUnavailableError(reason.replace(/\|\d{10}\b/, '').slice(0, 400), kind, epoch ? new Date(Number(epoch[1]) * 1000) : null);
}

// Runs `claude` with stdin closed (so it doesn't wait 3s for piped input) and
// turns any failure into a QaUnavailableError carrying the CLI's own reason.
async function runClaude(args, { cwd, timeoutMs }) {
  const bin = await claudeBin();
  const call = execFileAsync(bin, args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  call.child.stdin?.end();
  let stdout;
  try {
    ({ stdout } = await call);
  } catch (err) {
    throw qaUnavailable(describeClaudeFailure(err, { timeoutMs, bin }));
  }
  let json = null;
  try { json = JSON.parse(stdout); } catch {}
  if (json?.is_error) throw qaUnavailable(describeClaudeFailure({ stdout }, { timeoutMs, bin }));
  // --output-format json wraps the reply as {"result": "..."}, plus
  // {"structured_output": {...}} when --json-schema was passed.
  return json?.structured_output ?? json?.result ?? stdout;
}

// Flags that keep the QA call independent of the operator's own Claude Code
// setup: a user-level hook (e.g. a Stop hook that insists on a log entry), a
// plugin, an MCP server or a global CLAUDE.md can make a headless call fail,
// hang or answer in prose. Only flags this CLI version lists in --help are
// passed, so an older install doesn't fail on an unknown option.
let cliHelp;
async function cliSupports(flag) {
  if (cliHelp === undefined) {
    cliHelp = '';
    try {
      const call = execFileAsync(await claudeBin(), ['--help'], { timeout: 15000 });
      call.child.stdin?.end();
      ({ stdout: cliHelp } = await call);
    } catch {}
  }
  return cliHelp.includes(flag);
}

async function isolationFlags() {
  return [
    ...((await cliSupports('--safe-mode')) ? ['--safe-mode'] : (await cliSupports('--setting-sources')) ? ['--setting-sources='] : []),
    ...((await cliSupports('--strict-mcp-config')) ? ['--strict-mcp-config'] : []),
    ...((await cliSupports('--no-session-persistence')) ? ['--no-session-persistence'] : []),
  ];
}

// The reply's shape, enforced by the CLI (--json-schema) where it supports
// it. Free-text JSON from the model drops a closing quote now and then,
// which used to surface as "QA unavailable".
function replySchema(rubric) {
  const score = { type: 'integer', minimum: 0, maximum: 2 };
  const checks = RUBRICS[rubric].checks;
  return {
    type: 'object',
    required: ['images'],
    properties: {
      images: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['index', ...checks, 'setting', 'description', 'person', 'note'],
          properties: {
            index: { type: 'integer', minimum: 0 },
            ...Object.fromEntries(checks.map((c) => [c, score])),
            setting: { type: 'string', enum: SETTINGS },
            description: { type: 'string' },
            person: { type: 'boolean' },
            note: { type: 'string' },
          },
        },
      },
    },
  };
}

export async function assertQaAvailable() {
  let stdout;
  const bin = await claudeBin();
  try {
    const call = execFileAsync(bin, ['auth', 'status'], { timeout: 10000 });
    call.child.stdin?.end();
    ({ stdout } = await call);
  } catch (err) {
    const reason = describeClaudeFailure(err, { timeoutMs: 10000, bin });
    throw new QaUnavailableError(`Image QA is unavailable: ${reason}`, err.code === 'ENOENT' ? 'setup' : 'auth');
  }
  let status;
  try { status = JSON.parse(stdout); } catch { throw new QaUnavailableError('Image QA returned an unreadable auth status', 'setup'); }
  if (!status.loggedIn) throw new QaUnavailableError('Image QA is signed out. Run claude login before generating images.', 'auth');
}

// Pulls {TEXT} out of the MASTER's TEXT block, and the one /command line
// (the last paragraph starting with "/") that describes scene + founder.
export function parsePrompt(promptText) {
  const textMatch = promptText.match(/exact spelling and line breaks:\s*"([\s\S]*?)"\.\s*No other legible/);
  const paragraphs = promptText.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const line = [...paragraphs].reverse().find((p) => p.startsWith('/')) || paragraphs.at(-1) || '';
  const textFree = /\b(text[- ]free|no lettering|no legible text|no text|words and diagrams will be added by code)\b/i.test(promptText);
  const plate = /\b(no person or face|no people|without any person|empty scene)\b/i.test(promptText);
  return { text: textMatch ? textMatch[1] : null, line: line.replace(/\s*\n\s*/g, ' '), textFree, plate };
}

// 'auto' keeps the original behaviour: a prompt that asks for no lettering is a photo base.
export function resolveRubric(rubric, promptText) {
  if (rubric === 'surface' || rubric === 'photo' || rubric === 'library') return rubric;
  if (!promptText) return 'library';
  return parsePrompt(promptText).textFree ? 'photo' : 'surface';
}

const SHARED_FIELDS = [
  `- setting: exactly one of ${SETTINGS.map((s) => JSON.stringify(s)).join(', ')}.`,
  '- description: <= 15 words describing what is in the image.',
  '- person: true if a person is clearly visible, else false.',
  '- note: <= 15 words — the main reason for any check below 2, else what makes it strong.',
];

function photoChecks(plate, libraryMode) {
  return [
    '- photo_realism: 2 = natural candid camera photograph, plausible skin/light/anatomy; 1 = slight AI artifacts; 0 = CGI, illustration, plastic skin or impossible anatomy.',
    plate
      ? '- subject_match: 2 = no person or face; 1 = distant indistinct silhouette; 0 = visible person or face.'
      : libraryMode
        ? '- subject_match: 2 = one clearly visible natural adult (the founder) or a clean empty scene; 1 = face small, partly obscured or awkwardly cropped; 0 = distorted face, several people, or a generic stock look.'
        : '- subject_match: 2 = one clearly visible natural founder-like adult consistent with stated appearance; 1 = face small or partly obscured; 0 = generic substitute, distorted face, or no person. Exact identity still needs owner approval.',
    '- text_free: 2 = no embedded words, signs, letters or graphic panels; 1 = faint unreadable marks; 0 = readable text, logos, or baked-in overlay.',
    '- overlay_space: 2 = broad continuous calm area where a headline/body can be added at readable size; 1 = limited but usable; 0 = crowded or no clean area.',
    libraryMode
      ? '- scene_ok: 2 = a believable real work or city setting with no elevator/lift/lobby; 1 = generic or slightly staged; 0 = an elevator/lift/lobby, or a nonsensical scene.'
      : '- scene_match: 2 = place, subject and objects clearly fit the brief with no elevator/lift/lobby; 1 = weak fit; 0 = unrelated or an elevator/lift/lobby.',
  ];
}

function buildInstruction(rubric, parsed, imagePaths) {
  const checks = RUBRICS[rubric].checks;
  const example = `{"images":[{"index":0,${checks.map((c) => `"${c}":0`).join(',')},"setting":"...","description":"...","person":true,"note":"..."}, ...one object per image]}`;
  const list = ['', 'Images, in order (index 0 onward):', ...imagePaths.map((p, i) => `${i}: ${p}`)];
  if (rubric === 'photo' || rubric === 'library') return [
    'You are a strict photo editor doing QA on AI-generated base photographs for a social carousel.',
    'Read every image with the Read tool. Return scores only. Do not assume the founder is verified against a reference photo you cannot see.',
    ...(rubric === 'photo' ? ['', 'FULL GENERATION BRIEF:', parsed.line] : ['', 'There is no brief: judge each image as a stand-alone base photo for a text overlay.']),
    '', 'Score each image from 0 to 2 on every check:',
    ...photoChecks(parsed.plate, rubric === 'library'),
    '', 'Also give per image:', ...SHARED_FIELDS,
    ...list,
    '', 'Reply with ONLY JSON, no markdown:', example,
  ].join('\n');
  return [
    'You are a strict photo editor doing QA on 4 AI-generated candidates for one social post.',
    'Read each image file with the Read tool, then score them. Do not describe anything else.',
    '',
    'THE BRIEF the images were generated from:',
    parsed.line,
    parsed.text ? `REQUIRED ON-IMAGE TEXT (exact): "${parsed.text}"` : '',
    '',
    'First identify the MAIN SUBJECTS from the brief: (a) the surface carrying the text (e.g. the',
    'departures board, the eye chart, the billboard) and (b) the founder (the person).',
    '',
    'Score every image 0, 1 or 2 on each check:',
    '- surface_in_frame: 2 = the whole surface is inside the frame with margin, no letter or edge cut off; 1 = a non-text edge slightly touches the frame; 0 = any text or a large part of the surface is cropped.',
    '- founder_gaze: 2 = the person is clearly visible, face unobstructed, head and eyes turned toward the surface exactly as the brief says; 1 = visible but gaze or pose only roughly right; 0 = missing, awkwardly cropped, or looking away from the surface (or at the camera when the brief does not say so).',
    '- text_match: 2 = every word matches the required text exactly and there is no other legible text; 1 = one small error; 0 = missing or garbled words.',
    '- installed: 2 = the surface looks physically real in that place (true scale next to the person, mounted/held/hung properly, perspective and lighting match); 1 = slightly off; 0 = floating, pasted-on, or wrong scale.',
    '- thumbnail: 2 = the main line would still be readable at ~270px wide; 1 = only just; 0 = unreadable.',
    '',
    'Also give per image:', ...SHARED_FIELDS,
    ...list,
    '',
    'Reply with ONLY this JSON, no markdown fences, no commentary:',
    example,
  ].filter((l) => l !== '').join('\n');
}

// For CLIs without --json-schema. When the JSON is broken, the usual cause is
// one string missing its closing quote before a brace, so that repair is
// tried at each closing brace before giving up.
export function extractJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`QA reply had no JSON: ${raw.slice(0, 300)}`);
  const text = raw.slice(start, end + 1);
  try {
    return JSON.parse(text);
  } catch (err) {
    for (let i = text.lastIndexOf('}'), tries = 0; i > 0 && tries < 40; i = text.lastIndexOf('}', i - 1), tries++) {
      try { return JSON.parse(`${text.slice(0, i)}"${text.slice(i)}`); } catch {}
    }
    throw err;
  }
}

// Pass/best are computed here from the raw scores rather than trusted from
// the model, so the selection rule is deterministic and matches AGENTS.md §8.
// The second argument used to be a textFree boolean; it still is accepted.
export function decide(images, rubric = 'surface') {
  const r = RUBRICS[rubric === true ? 'photo' : rubric === false ? 'surface' : rubric] ?? RUBRICS.surface;
  const scored = images.map((img) => {
    const total = r.checks.reduce((sum, k) => sum + (Number(img[k]) || 0), 0);
    const pass = r.hard.every((k) => Number(img[k]) > 0) && total >= PASS_TOTAL;
    // Why it fell short: hard zeros first, then the checks that only scored 1.
    const zeros = r.checks.filter((k) => !(Number(img[k]) > 0));
    const ones = r.checks.filter((k) => Number(img[k]) === 1);
    return { ...img, total, pass, failing: pass ? [] : zeros.length ? zeros : ones };
  });
  // Best = passing images first, then highest total, then the rubric's tiebreak check.
  const ranked = [...scored].sort((a, b) =>
    (b.pass - a.pass) || (b.total - a.total) || ((b[r.tiebreak] || 0) - (a[r.tiebreak] || 0)) || (a.index - b.index));
  return { images: scored, best: ranked[0].index, pass: ranked[0].pass, score: ranked[0].total };
}

export async function runQa({ imagePaths, promptText, rubric = 'auto', timeoutMs = 180000 }) {
  const resolved = resolveRubric(rubric, promptText);
  const parsed = parsePrompt(promptText || '');
  const dirs = [...new Set(imagePaths.map((p) => path.dirname(path.resolve(p))))];
  const args = [
    '-p', buildInstruction(resolved, parsed, imagePaths.map((p) => path.resolve(p))),
    '--output-format', 'json',
    '--model', process.env.FLOW_QA_MODEL || 'sonnet',
    '--allowedTools', 'Read',
    ...((await cliSupports('--json-schema')) ? ['--json-schema', JSON.stringify(replySchema(resolved))] : []),
    ...(await isolationFlags()),
    ...dirs.flatMap((d) => ['--add-dir', d]),
  ];
  const reply = await runClaude(args, { cwd: dirs[0], timeoutMs });
  let images;
  try { ({ images } = extractJson(reply)); } catch { images = null; }
  if (!Array.isArray(images) || images.length === 0) {
    const said = typeof reply === 'string' ? reply : JSON.stringify(reply);
    throw new QaUnavailableError(`QA answered without scores: ${said.replace(/\s+/g, ' ').slice(0, 200)}`, 'transient');
  }
  return { ...decide(images, resolved), rubric: resolved };
}

// The fields the portal records for one image (flow-queue/attempt, /complete,
// flow-library/ingest, flow-library/qa): its verdict, scores, and why.
export function verdictFor(result, index = result.best) {
  const img = result.images.find((i) => i.index === index) ?? result.images[0];
  const checks = Object.fromEntries((RUBRICS[result.rubric]?.checks ?? []).map((k) => [k, Number(img[k]) || 0]));
  const failing = img.failing ?? [];
  const note = String(img.note || '').trim();
  return {
    qa_status: img.pass ? 'pass' : 'fail',
    qa_score: img.total,
    qa_detail: { checks, rubric: result.rubric, candidates: result.images.map((i) => ({ index: i.index, total: i.total, pass: i.pass })) },
    qa_notes: img.pass ? note : [failing.length ? `Weak on ${failing.map((f) => f.replace(/_/g, ' ')).join(', ')}.` : '', note].filter(Boolean).join(' '),
    failing_checks: failing,
    setting: SETTINGS.includes(img.setting) ? img.setting : 'other',
    description: String(img.description || '').slice(0, 300),
    has_person: img.person === true,
  };
}

export function formatQaLine(result) {
  const notes = result.images.map((i) => `#${i.index} ${i.total}/10${i.pass ? '' : ' ✗'} ${i.note || ''}`.trim()).join(' | ');
  return `QA: ${result.pass ? 'PASS' : 'FAIL'} best=#${result.best} score=${result.score}/10 — ${notes}`;
}

// ---- standalone CLI ----
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const pi = argv.indexOf('--prompt');
  const ri = argv.indexOf('--rubric');
  const rubric = ri >= 0 ? argv[ri + 1] : 'auto';
  const promptText = pi >= 0 ? await readFile(argv[pi + 1], 'utf8') : '';
  const skip = new Set([pi, pi + 1, ri, ri + 1].filter((i) => i >= 0));
  const imagePaths = argv.filter((_, i) => !skip.has(i));
  if (!imagePaths.length) {
    console.error('Usage: node flow-qa.mjs [--prompt prompt.txt] [--rubric photo|surface|library] img0 img1 [img2 img3]');
    process.exit(1);
  }
  try {
    const result = await runQa({ imagePaths, promptText, rubric });
    console.log(formatQaLine(result));
    process.exit(result.pass ? 0 : 3);
  } catch (err) {
    console.error('QA failed to run:', err.message);
    process.exit(1);
  }
}
