#!/usr/bin/env node
// Explicit local controls; these do not open Flow or submit a generation.
import { pauseGeneration, readPause, resumeGeneration } from './flow-safety.mjs';

const command = process.argv[2] || 'status';
if (command === 'pause') {
  await pauseGeneration('Paused by the owner.', 'FLOW_MANUAL_PAUSE');
  console.log('Flow submissions paused. Queued requests remain queued.');
} else if (command === 'resume' && process.argv.includes('--manual-check-passed')) {
  await resumeGeneration();
  console.log('Local pause cleared. The worker will still stop if Flow displays a warning.');
} else if (command === 'resume') {
  console.error('First confirm one manual generation succeeds in Flow, then use: node flow-control.mjs resume --manual-check-passed');
  process.exitCode = 1;
} else if (command === 'status') {
  const state = await readPause();
  console.log(state ? `PAUSED: ${state.reason}\nSince: ${state.paused_at ?? 'unknown'}` : 'No local generation pause.');
} else {
  console.error('Usage: node flow-control.mjs status|pause|resume --manual-check-passed');
  process.exitCode = 1;
}
