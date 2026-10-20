#!/usr/bin/env node
// flow-qa.mjs — picks the best of Flow's 4 outputs for a single-post prompt.
//
// Scores each image 0-2 on five checks derived from the prompt itself
// (the founder-content AGENTS.md §8): the text surface fully in frame,
// the founder present and looking at it, the text matching, the surface
// looking physically installed, and thumbnail legibility. Scoring is done
// by a headless `claude -p` call that reads the image files, so no API key
// is needed — it runs on the operator's own Claude Code login.
//
// Used two ways:
//   1. Automatically by flow-generate.mjs --qa (imports runQa).
//   2. Standalone, on images you already have:
//        node flow-qa.mjs --prompt prompt.txt img0.png img1.png img2.png img3.png
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
const CHECKS = ['surface_in_frame', 'founder_gaze', 'text_match', 'installed', 'thumbnail'];
const PHOTO_CHECKS = ['photo_realism', 'subject_match', 'text_free', 'overlay_space', 'scene_match'];
// Checks 1-4 are hard gates: a 0 on any of them fails the image outright.
const HARD = ['surface_in_frame', 'founder_gaze', 'text_match', 'installed'];
const PASS_TOTAL = 8;

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

function buildInstruction({ text, line, textFree, plate }, imagePaths) {
  if (textFree) return [
    'You are a strict photo editor doing QA on AI-generated base photographs for a social carousel.',
    'Read every image with the Read tool. Return scores only. Do not assume the founder is verified against a reference photo you cannot see.',
    '', 'FULL GENERATION BRIEF:', line,
    '', 'Score each image from 0 to 2 on every check:',
    '- photo_realism: 2 = natural candid camera photograph, plausible skin/light/anatomy; 1 = slight AI artifacts; 0 = CGI, illustration, plastic skin or impossible anatomy.',
    plate
      ? '- subject_match: 2 = no person or face; 1 = distant indistinct silhouette; 0 = visible person or face.'
      : '- subject_match: 2 = one clearly visible natural founder-like adult consistent with stated appearance; 1 = face small or partly obscured; 0 = generic substitute, distorted face, or no person. Exact identity still needs owner approval.',
    '- text_free: 2 = no embedded words, signs, letters or graphic panels; 1 = faint unreadable marks; 0 = readable text, logos, or baked-in overlay.',
    '- overlay_space: 2 = broad continuous calm area where a headline/body can be added at readable size; 1 = limited but usable; 0 = crowded or no clean area.',
    '- scene_match: 2 = place, subject and objects clearly fit the brief with no elevator/lift/lobby; 1 = weak fit; 0 = unrelated or an elevator/lift/lobby.',
    '', 'Images, in order (index 0 onward):',
    ...imagePaths.map((p, i) => `${i}: ${p}`),
    '', 'Reply with ONLY JSON, no markdown:',
    '{"images":[{"index":0,"photo_realism":0,"subject_match":0,"text_free":0,"overlay_space":0,"scene_match":0,"note":"<=12 words"}, ...one object per image]}',
  ].join('\n');
  return [
    'You are a strict photo editor doing QA on 4 AI-generated candidates for one social post.',
    'Read each image file with the Read tool, then score them. Do not describe anything else.',
    '',
    'THE BRIEF the images were generated from:',
    line,
    text ? `REQUIRED ON-IMAGE TEXT (exact): "${text}"` : '',
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
    'Images, in order (index 0 to 3):',
    ...imagePaths.map((p, i) => `${i}: ${p}`),
    '',
    'Reply with ONLY this JSON, no markdown fences, no commentary:',
    '{"images":[{"index":0,"surface_in_frame":0,"founder_gaze":0,"text_match":0,"installed":0,"thumbnail":0,"note":"<=12 words"}, ...one object per image]}',
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
export function decide(images, textFree = false) {
  const checks = textFree ? PHOTO_CHECKS : CHECKS;
  const hard = textFree ? PHOTO_CHECKS : HARD;
  const scored = images.map((img) => {
    const total = checks.reduce((sum, k) => sum + (Number(img[k]) || 0), 0);
    const pass = hard.every((k) => Number(img[k]) > 0) && total >= PASS_TOTAL;
    return { ...img, total, pass };
  });
  // Best = passing images first, then highest total, then strongest text/scene match.
  const ranked = [...scored].sort((a, b) =>
    (b.pass - a.pass) || (b.total - a.total) || ((b[textFree ? 'scene_match' : 'text_match'] || 0) - (a[textFree ? 'scene_match' : 'text_match'] || 0)) || (a.index - b.index));
  return { images: scored, best: ranked[0].index, pass: ranked[0].pass, score: ranked[0].total };
}

export async function runQa({ imagePaths, promptText, timeoutMs = 180000 }) {
  const parsed = parsePrompt(promptText);
  const dirs = [...new Set(imagePaths.map((p) => path.dirname(path.resolve(p))))];
  const args = [
    '-p', buildInstruction(parsed, imagePaths.map((p) => path.resolve(p))),
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
  return decide(images, parsed.textFree);
}

export function formatQaLine(result) {
  const notes = result.images.map((i) => `#${i.index} ${i.total}/10${i.pass ? '' : ' ✗'} ${i.note || ''}`.trim()).join(' | ');
  return `QA: ${result.pass ? 'PASS' : 'FAIL'} best=#${result.best} score=${result.score}/10 — ${notes}`;
}

// ---- standalone CLI ----
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const pi = argv.indexOf('--prompt');
  if (pi < 0 || argv.length < pi + 3) {
    console.error('Usage: node flow-qa.mjs --prompt prompt.txt img0 img1 [img2 img3]');
    process.exit(1);
  }
  const promptText = await readFile(argv[pi + 1], 'utf8');
  const imagePaths = argv.filter((_, i) => i !== pi && i !== pi + 1);
  try {
    const result = await runQa({ imagePaths, promptText });
    console.log(formatQaLine(result));
    process.exit(result.pass ? 0 : 3);
  } catch (err) {
    console.error('QA failed to run:', err.message);
    process.exit(1);
  }
}
