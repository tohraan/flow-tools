<div align="center">

# 🌊 flow-tools

**Keyboard-free, zero-dependency automation for [Google Flow](https://labs.google/fx/tools/flow)**

Drive Flow's prompt box, model/ratio settings, generation, and 2K/4K downloads — all by talking directly to Chrome over the DevTools Protocol. No Playwright. No Puppeteer. No `npm install`. Just Node and a running Chrome.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-zero-success)](#how-it-works)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)](#prerequisites)

</div>

---

## Why this exists

Google Flow has no public API. This toolkit talks to it the same way its own developer tools would — over the Chrome DevTools Protocol (CDP) — so you can script prompts, resolutions, and downloads from the command line (or from another agent/program) instead of clicking through the UI by hand every time.

It was originally built to work entirely without a physical keyboard — every keystroke is synthesized and injected directly into the page — which turns out to make it just as useful for scripting, batch generation, and wiring Flow into other tools/agents.

## Features

- 🚀 **One command, prompt to image** — `flow-generate.mjs` opens your project, types the prompt, hits generate, waits for completion, and logs the run
- 🖱️ **Real input, not fake events** — clicks and keystrokes go through CDP's `Input` domain, so they register on apps that ignore plain JS `.click()` / synthetic events
- 📎 **Attach reference images without a file picker** — injects files straight into `<input type=file>` via `DOM.setFileInputFiles`
- ⬇️ **Scripted downloads at any resolution** (1K / 2K / 4K) — no manual right-click required
- 📝 **Automatic run history** — every generation is logged with its prompt, timing, and result
- 🪶 **Zero dependencies** — built entirely on Node 22's built-in `fetch` and `WebSocket`

## Prerequisites

- **Node 22+** (for built-in `WebSocket`/`fetch` — check with `node -e "console.log(typeof WebSocket)"` → should print `function`)
- **Google Chrome** installed
- **macOS** (the launch script uses `osascript`/`open`; porting to Linux/Windows is a small change — PRs welcome)

## Install

```bash
git clone https://github.com/tohraan/flow-tools.git
cd flow-tools
```

That's it — no package manager, no build step.

## Quickstart

```bash
# 1. Launch a dedicated automation Chrome profile with the debug port open
./flow-launch-chrome.sh
# First time only: log into Google in the window that opens.

# 2. Tell it which Flow project to drive (one-time setup)
echo "https://flow.google.com/project/<your-project-id>" > .flow-project-url
# (or export FLOW_PROJECT_URL=... / pass --project <url> per call)

# 3. Generate
echo "A neon-lit cyberpunk alley at night, rain-slicked street, cinematic" > prompt.txt
node flow-generate.mjs --file prompt.txt --label "cyberpunk-alley" --download 0
```

Output: the generated grid is screenshotted, image #0 is downloaded at 2K, and the run is appended to `~/Flow/build-log.md`.

## Why a dedicated Chrome profile?

As of late 2025, Chrome **silently refuses** to open the remote-debugging port against your normal default profile — an anti-session-hijacking protection, with no error shown. `flow-launch-chrome.sh` launches a separate automation-only profile instead (`./chrome-profile/`, gitignored — it holds real session cookies, never commit it). You log in once; it's remembered after that.

## Usage

### `flow-generate.mjs` — the main entry point

```bash
node flow-generate.mjs --file <prompt.txt> --label "<name>" [options]
```

| Flag | Description |
|---|---|
| `--file <path>` | Prompt text file (or omit and pass the prompt as a plain final argument) |
| `--label <name>` | Short name for this run, used in logs and screenshot filenames |
| `--download <N>` | Download the Nth generated image (0-indexed, left→right) |
| `--res <1K\|2K\|4K>` | Resolution for `--download` (default `2K`) |
| `--project <url>` | Flow project URL (else: `FLOW_PROJECT_URL` env var, else `.flow-project-url`) |

### `cdp.mjs` — low-level toolkit

For debugging, exploring a page, or scripting something `flow-generate.mjs` doesn't cover yet:

```bash
node cdp.mjs shot [out.png]                    # screenshot -> file
node cdp.mjs js "<expression>"                  # Runtime.evaluate, prints JSON
node cdp.mjs click-text "<text>" [--all]        # click smallest element whose visible text matches
node cdp.mjs click-xy <x> <y> [left|right]      # raw coordinate click via real CDP mouse event
node cdp.mjs type --file <path> | "<text>"      # insert text into whatever's focused
node cdp.mjs key <KeyName>                      # e.g. Enter, Escape, Tab
node cdp.mjs rightclick-text "<text>"           # opens context menus
node cdp.mjs set-file-input "<selector>" <path> # inject a file, bypassing the OS picker
node cdp.mjs set-download-dir <dir>             # browser-wide download redirect
```

All commands accept `--port 9222` and `--match <tab-url-substring>` (default: any tab with `flow.google.com`).

### `flow-type.mjs` — minimal standalone helper

The original, smaller script this grew out of: types text into whatever element is focused in a matching tab. Useful on its own for any site, not just Flow.

```bash
node flow-type.mjs --file prompt.txt [--submit] [--match <substring>]
```

## How it works

Chrome exposes a debugging API over WebSocket (the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)) when launched with `--remote-debugging-port`. Every script here:

1. Fetches `http://localhost:9222/json/list` to find the target tab's WebSocket URL
2. Opens a WebSocket connection and speaks the CDP JSON-RPC protocol directly
3. Uses `Runtime.evaluate` to read the DOM / find element coordinates
4. Uses `Input.dispatchMouseEvent` / `Input.insertText` to synthesize **real, trusted input** — important, because apps that only listen for genuine pointer events (common in React/Flutter-style apps) silently ignore a plain `element.click()`

No browser automation framework, no binary downloads, no bundler — just the protocol Chrome already speaks.

## Known gotchas

1. **`element.click()` does not register** on Flow's UI — always dispatch a real `Input.dispatchMouseEvent` at the element's actual coordinates.
2. **Right-click opens an in-page custom context menu**, not a native OS one — fully scriptable.
3. **Downloads need `Browser.setDownloadBehavior`** (browser-level) — the per-page variant doesn't reliably apply.
4. **Identity-lock prompts** ("use the attached reference image 'X'") only work if an actual image/Character named X is uploaded and attached — a name in plain text does nothing by itself. Use `set-file-input` to attach one.

## Contributing

Issues and PRs welcome — especially for Linux/Windows launch scripts, additional CDP helper commands, and support for Flow's video-generation flow.

## License

[MIT](LICENSE) © 2026 Tohraan Ahmad Khan
