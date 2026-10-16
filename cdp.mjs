#!/usr/bin/env node
// cdp.mjs — small zero-dependency CDP toolkit for driving a tab by hand
// when you can't use a physical keyboard. Talks directly to Chrome's
// DevTools protocol (no Playwright/Puppeteer needed).
//
// Commands:
//   node cdp.mjs shot [out.png]                     screenshot -> file
//   node cdp.mjs js "<expression>"                   Runtime.evaluate, prints JSON
//   node cdp.mjs click-text "<text>" [--all]         click smallest element whose text matches
//   node cdp.mjs click-xy <x> <y>                    raw coordinate click
//   node cdp.mjs type --file <path> | "<text>"       Input.insertText into focused element
//   node cdp.mjs key <KeyName>                       e.g. Enter, Escape, Tab
//   node cdp.mjs rightclick-text "<text>"            dispatch a right-click (contextmenu) on match
//   node cdp.mjs set-file-input "<selector>" <path>  inject a file into an <input type=file>, bypassing the OS picker
//   node cdp.mjs set-download-dir <dir>              CAUTION: unreliable — returns success but Chrome often
//                                                     keeps saving to its real default anyway. Verify via
//                                                     chrome://downloads before trusting it. flow-generate.mjs
//                                                     works around this by moving the file after the fact instead.
//
// All commands take optional --port 9222 --match <substring of tab title/url>

const DEFAULT_PORT = 9222;
const DEFAULT_MATCH = 'flow.google.com';

function parseFlags(argv) {
  const out = { port: DEFAULT_PORT, match: DEFAULT_MATCH, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = Number(argv[++i]);
    else if (argv[i] === '--match') out.match = argv[++i];
    else if (argv[i] === '--file') out.file = argv[++i];
    else if (argv[i] === '--all') out.all = true;
    else out.rest.push(argv[i]);
  }
  return out;
}

async function connect(port, match) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await res.json();
  const pages = targets.filter((t) => t.type === 'page');
  const target = pages.find((t) => t.url.includes(match) || (t.title || '').toLowerCase().includes(match.toLowerCase()));
  if (!target) {
    console.error(`No tab matching "${match}". Open tabs:`);
    for (const t of pages) console.error(`  - ${t.title || '(untitled)'} — ${t.url}`);
    process.exit(1);
  }

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

// Finds elements whose visible text matches `text` (exact trim or substring),
// returns bounding-box centers in viewport (CSS) coordinates, smallest-area first.
const FIND_JS = (text, needAll) => `
(() => {
  const target = ${JSON.stringify(text)};
  const all = Array.from(document.querySelectorAll('button, [role="button"], a, div, span, label, li'));
  const matches = [];
  for (const el of all) {
    const t = (el.innerText || el.textContent || '').trim();
    if (!t) continue;
    if (t === target || t.includes(target)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      matches.push({ x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, text: t.slice(0, 60) });
    }
  }
  matches.sort((a, b) => (a.w * a.h) - (b.w * b.h));
  return ${needAll} ? matches : matches.slice(0, 1);
})()
`;

async function clickAt(send, x, y, button = 'left') {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
}

async function connectBrowser(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  const info = await res.json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
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
  return { ws, send };
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const flags = parseFlags(argv);

  if (cmd === 'set-download-dir') {
    const dir = flags.rest[0];
    const { ws, send } = await connectBrowser(flags.port);
    await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
    console.log(`Browser-wide downloads now go to: ${dir}`);
    ws.close();
    return;
  }

  const { ws, send, target } = await connect(flags.port, flags.match);

  try {
    if (cmd === 'shot') {
      const out = flags.rest[0] || 'shot.png';
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      await (await import('node:fs/promises')).writeFile(out, Buffer.from(data, 'base64'));
      console.log(`Saved screenshot: ${out}`);
    } else if (cmd === 'js') {
      const expr = flags.rest.join(' ');
      const result = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      console.log(JSON.stringify(result.result?.value ?? result, null, 2));
    } else if (cmd === 'click-text') {
      const text = flags.rest.join(' ');
      const result = await send('Runtime.evaluate', { expression: FIND_JS(text, !!flags.all), returnByValue: true });
      const matches = result.result.value;
      if (!matches || matches.length === 0) {
        console.error(`No element found matching "${text}"`);
        process.exit(1);
      }
      if (flags.all) {
        console.log(JSON.stringify(matches, null, 2));
      } else {
        const m = matches[0];
        await clickAt(send, m.x, m.y);
        console.log(`Clicked "${m.text}" at (${Math.round(m.x)}, ${Math.round(m.y)})`);
      }
    } else if (cmd === 'rightclick-text') {
      const text = flags.rest.join(' ');
      const result = await send('Runtime.evaluate', { expression: FIND_JS(text, false), returnByValue: true });
      const matches = result.result.value;
      if (!matches || matches.length === 0) {
        console.error(`No element found matching "${text}"`);
        process.exit(1);
      }
      const m = matches[0];
      await clickAt(send, m.x, m.y, 'right');
      console.log(`Right-clicked "${m.text}" at (${Math.round(m.x)}, ${Math.round(m.y)})`);
    } else if (cmd === 'click-xy') {
      const [x, y, button] = flags.rest;
      await clickAt(send, Number(x), Number(y), button || 'left');
      console.log(`Clicked at (${x}, ${y})${button ? ' button=' + button : ''}`);
    } else if (cmd === 'type') {
      const text = flags.file ? (await (await import('node:fs/promises')).readFile(flags.file, 'utf8')) : flags.rest.join(' ');
      await send('Input.insertText', { text });
      console.log(`Typed ${text.length} characters.`);
    } else if (cmd === 'set-file-input') {
      const selector = flags.rest[0];
      const files = flags.rest.slice(1);
      const obj = await send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` });
      if (!obj.result?.objectId) {
        console.error(`No element matching "${selector}"`);
        process.exit(1);
      }
      await send('DOM.setFileInputFiles', { files, objectId: obj.result.objectId });
      console.log(`Set ${files.length} file(s) on ${selector}`);
    } else if (cmd === 'key') {
      const key = flags.rest[0];
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key });
      console.log(`Pressed ${key}`);
    } else {
      console.error('Unknown command. See header comment for usage.');
      process.exit(1);
    }
  } finally {
    ws.close();
  }
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
