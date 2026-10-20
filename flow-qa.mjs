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
// no API key is needed — it runs on the operator's own Claude Code login.
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

export async function assertQaAvailable() {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(await claudeBin(), ['auth', 'status'], { timeout: 10000 }));
  } catch {
    throw new Error('Image QA is unavailable: Claude CLI is signed out or cannot report its auth status');
  }
  let status;
  try { status = JSON.parse(stdout); } catch { throw new Error('Image QA returned an unreadable auth status'); }
  if (!status.loggedIn) throw new Error('Image QA is signed out. Run claude login before generating images.');
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

function extractJson(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`QA reply had no JSON: ${raw.slice(0, 300)}`);
  return JSON.parse(raw.slice(start, end + 1));
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
    ...dirs.flatMap((d) => ['--add-dir', d]),
  ];
  const { stdout } = await execFileAsync(await claudeBin(), args, {
    cwd: dirs[0], timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024,
  });
  // --output-format json wraps the reply as {"result": "..."}.
  let reply = stdout;
  try { reply = JSON.parse(stdout).result ?? stdout; } catch {}
  const { images } = extractJson(reply);
  if (!Array.isArray(images) || images.length === 0) throw new Error('QA reply had no images array');
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
