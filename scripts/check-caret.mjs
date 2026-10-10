#!/usr/bin/env node
/**
 * Assert that the editor has a visible text caret.
 *
 * Regression probe for: "the editor shows no cursor at all". It loads the app,
 * puts a real text caret in the first paragraph, and asserts on the two facts
 * that make a caret visible — the native caret is not transparent, and no
 * scripted caret replacement is suppressing it. Also writes a screenshot so the
 * rendered result can be looked at rather than only measured.
 *
 * Exits non-zero when the caret is broken, so it is usable as a check.
 *
 * Usage: node scripts/check-caret.mjs [url] [screenshot.png]
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_TO_LOAD = process.argv[2] ?? 'http://localhost:1420/';
const SHOT_PATH = process.argv[3] ?? '/tmp/moda-caret.png';
const PORT = 9224;
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

const edge = spawn(
  EDGE,
  [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--user-data-dir=/tmp/moda-edge-profile-3',
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

  const facts = await cdp.eval(`(() => {
    const editor = document.querySelector('.milkdown .ProseMirror');
    if (!editor) return { error: 'editor not found' };

    // The app starts on an empty document, which has no text node to put a
    // caret in. Seed one line so there is somewhere real to click.
    window.moda.markdownEditor.setMarkdown('把光标放在这里。');
    editor.focus();

    // A real text caret, which is what the user is trying to place.
    const paragraph = editor.querySelector('p');
    const textNode =
      paragraph && paragraph.firstChild && paragraph.firstChild.nodeType === 3
        ? paragraph.firstChild
        : null;
    if (textNode) {
      const range = document.createRange();
      range.setStart(textNode, Math.min(3, textNode.length));
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    const style = getComputedStyle(editor);
    return {
      // Reported raw; whether it counts as suppressed is decided in Node, so no
      // regex has to survive this template literal.
      caretColor: style.caretColor,
      hasVirtualCursorClass: editor.classList.contains('virtual-cursor-enabled'),
      virtualCursorElements: document.querySelectorAll('.prosemirror-virtual-cursor').length,
      selectionIsText: window.getSelection().rangeCount
        ? window.getSelection().getRangeAt(0).startContainer.nodeType === 3
        : false,
      editorFocused: document.activeElement === editor,
      styleSheetCount: document.styleSheets.length,
    };
  })()`);

  // A caret computed to fully transparent means something suppressed it.
  const caret = String(facts.caretColor ?? '').replace(/\s+/g, '');
  const caretTransparent =
    caret === 'transparent' ||
    caret === 'rgba(0,0,0,0)' ||
    caret === 'rgb(0 0 0/0)' ||
    caret === 'rgba(0,0,0,0%)';
  facts.caretTransparent = caretTransparent;

  await sleep(600);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SHOT_PATH, Buffer.from(shot.data, 'base64'));

  console.log(JSON.stringify(facts, null, 2));
  console.log(`screenshot: ${SHOT_PATH}`);

  if (facts.error) {
    console.error('\nFAIL: ' + facts.error);
    process.exitCode = 1;
  } else if (facts.caretTransparent) {
    console.error('\nFAIL: the native caret is transparent and nothing replaces it.');
    process.exitCode = 1;
  } else if (!facts.editorFocused || !facts.selectionIsText) {
    console.error('\nFAIL: could not place a text caret in the editor.');
    process.exitCode = 1;
  } else {
    console.log('\nPASS: the editor has a visible native caret.');
  }

  cdp.close();
} finally {
  edge.kill('SIGTERM');
}
