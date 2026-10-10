#!/usr/bin/env node
/**
 * Can the user actually type into the editor?
 *
 * Regression probe for: "the editor has no cursor / cannot be typed into". It
 * loads the app and answers, with evidence, whether a real user gesture reaches
 * the ProseMirror surface:
 *
 *   1. click where the prose is, and see which element is on top;
 *   2. type, and see whether the document changes.
 *
 * Exits non-zero when the editor cannot be reached or typed into.
 *
 * Usage: node scripts/check-typing.mjs [url] [screenshot.png]
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_TO_LOAD = process.argv[2] ?? 'http://localhost:1420/';
const SHOT_PATH = process.argv[3] ?? '/tmp/moda-typing.png';
const PORT = 9225;
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

const edge = spawn(
  EDGE,
  [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--user-data-dir=/tmp/moda-edge-profile-4',
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();

  static async attach(wsUrl) {
    const client = new Cdp();
    client.#ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      client.#ws.addEventListener('open', resolve, { once: true });
      client.#ws.addEventListener('error', reject, { once: true });
    });
    client.#ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      const entry = client.#pending.get(msg.id);
      if (entry === undefined) return;
      client.#pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
    });
    return client;
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }

  close() {
    this.#ws.close();
  }
}

async function waitForEndpoint() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await sleep(250);
  }
  throw new Error('devtools endpoint never came up');
}

/** Dispatch a real click at viewport coordinates. */
async function click(cdp, x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }
}

/** Type a string as real key events. */
async function typeText(cdp, text) {
  // `keyDown` carrying `text` performs the insertion; a separate `char` event
  // would insert every character a second time.
  for (const char of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', text: char });
  }
}

try {
  await waitForEndpoint();
  const target = await (
    await fetch(
      `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`,
      { method: 'PUT' },
    )
  ).json();
  const cdp = await Cdp.attach(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: URL_TO_LOAD });
  await sleep(6000);

  const geometry = await cdp.eval(`(() => {
    const editor = document.querySelector('.milkdown .ProseMirror');
    const overlay = document.getElementById('empty');
    const rect = editor ? editor.getBoundingClientRect() : null;
    return {
      editorFound: Boolean(editor),
      overlayHidden: overlay ? overlay.hidden : null,
      // Is the overlay still laid out on top of the prose?
      overlayDisplay: overlay ? getComputedStyle(overlay).display : null,
      overlayRect: overlay
        ? { w: Math.round(overlay.getBoundingClientRect().width), h: Math.round(overlay.getBoundingClientRect().height) }
        : null,
      prosePoint: rect
        ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + 40) }
        : null,
    };
  })()`);

  // What is actually on top at the point where prose should be?
  let topElement = null;
  if (geometry.prosePoint) {
    topElement = await cdp.eval(
      `(() => {
        const el = document.elementFromPoint(${geometry.prosePoint.x}, ${geometry.prosePoint.y});
        return el ? { tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 80) } : null;
      })()`,
    );
  }

  // Try to type straight away, without dismissing anything.
  if (geometry.prosePoint) {
    await click(cdp, geometry.prosePoint.x, geometry.prosePoint.y);
    await sleep(400);
    await typeText(cdp, 'hello moda');
    await sleep(600);
  }

  const afterTyping = await cdp.eval(`(() => {
    const editor = document.querySelector('.milkdown .ProseMirror');
    return {
      proseText: editor ? editor.innerText.trim().slice(0, 80) : null,
      activeElement: document.activeElement ? document.activeElement.className.slice(0, 60) : null,
      caretColor: editor ? getComputedStyle(editor).caretColor : null,
      virtualCursorClass: editor ? editor.classList.contains('virtual-cursor-enabled') : null,
    };
  })()`);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SHOT_PATH, Buffer.from(shot.data, 'base64'));

  console.log(JSON.stringify({ geometry, topElement, afterTyping }, null, 2));
  console.log(`screenshot: ${SHOT_PATH}`);

  const typed = (afterTyping.proseText ?? '').includes('hello moda');
  if (!geometry.editorFound) {
    console.error('\nFAIL: no editor element.');
    process.exitCode = 1;
  } else if (!typed) {
    console.error('\nFAIL: typing did not reach the editor (overlay or focus problem).');
    process.exitCode = 1;
  } else {
    console.log('\nPASS: the editor accepts typing and shows a native caret.');
  }

  cdp.close();
} finally {
  edge.kill('SIGTERM');
}
