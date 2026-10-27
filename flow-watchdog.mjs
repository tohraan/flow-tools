#!/usr/bin/env node
// flow-watchdog.mjs — run every minute by the com.tohraan.flow-watchdog LaunchAgent.
//
// The daemon touches ~/Flow/heartbeat on every loop. If that goes stale while the Mac is
// awake, the daemon is hung (launchd KeepAlive only helps when it exits), so restart it.
// It also notes, as portal events, when "away mode" (lid-closed) is on and the battery is low.
// Events go through its own outbox, so they reach the portal even if it logs while offline.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from './flow-log.mjs';
import { loadPortalEnv, portal } from './flow-lib.mjs';

const run = promisify(execFile);
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const FLOW_DIR = path.join(homedir(), 'Flow');
const HEARTBEAT = path.join(FLOW_DIR, 'heartbeat');
const STATE = path.join(FLOW_DIR, '.watchdog-state.json');
const LABEL = 'com.tohraan.flow-daemon';
const STALE_MS = 180_000; // the daemon loops every 5–15 s
const SLEPT_GAP_MS = 150_000; // we run every 60 s; a bigger gap means the Mac slept
const LOW_BATTERY = 20;

let api = null;
try { api = portal(await loadPortalEnv(__dirname)); } catch {}
const logger = createLogger({ source: 'watchdog', worker: 'watchdog', getApi: () => api, outboxName: 'outbox-watchdog.jsonl' });

const now = Date.now();
await mkdir(FLOW_DIR, { recursive: true });
const state = JSON.parse(await readFile(STATE, 'utf8').catch(() => '{}'));
const next = { lastRun: now, lastAwayWarn: state.lastAwayWarn ?? 0, lastRestart: state.lastRestart ?? 0 };

const slept = state.lastRun && now - state.lastRun > SLEPT_GAP_MS;
if (slept) {
  // The daemon was frozen with us. Give it a couple of loops to notice the wake before judging it.
  await logger.log('mac_wake_seen', `Watchdog ran after a ~${Math.round((now - state.lastRun) / 60_000)} min gap (Mac slept); giving the daemon time to recover`, { level: 'info', human: false });
} else {
  const beat = Number(await readFile(HEARTBEAT, 'utf8').catch(() => 0));
  const age = beat ? now - beat : Infinity;
  if (age > STALE_MS && now - next.lastRestart > 300_000) {
    await logger.log('watchdog_restart', `Daemon heartbeat is ${beat ? Math.round(age / 1000) + ' s' : 'missing'} old: restarting it`, { level: 'warn' });
    try {
      await run('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${LABEL}`]);
      next.lastRestart = now;
    } catch (err) {
      await logger.log('watchdog_restart_failed', `launchctl kickstart failed: ${err.message}`.slice(0, 300), { level: 'error' });
    }
  }
}

// Away mode (pmset disablesleep) + low battery: say so once an hour, so the portal's email path can warn.
try {
  const { stdout: pm } = await run('/usr/bin/pmset', ['-g']);
  const awayOn = /SleepDisabled\s+1/.test(pm) || /disablesleep\s+1/.test(pm);
  if (awayOn) {
    const { stdout: batt } = await run('/usr/bin/pmset', ['-g', 'batt']);
    const pct = Number(batt.match(/(\d+)%/)?.[1] ?? 100);
    const onBattery = /discharging/.test(batt);
    if (onBattery && pct < LOW_BATTERY && now - next.lastAwayWarn > 3_600_000) {
      await logger.log('away_low_battery', `Away mode is on but the Mac is on battery at ${pct}%: it may shut down and stop making images. Plug it in.`, { level: 'warn' });
      next.lastAwayWarn = now;
    }
  }
} catch {}

await writeFile(STATE, JSON.stringify(next));
await logger.flush();
