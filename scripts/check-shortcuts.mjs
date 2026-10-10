#!/usr/bin/env node
/**
 * Assert that the Typora-aligned keyboard shortcuts actually format text.
 *
 * This drives real key events at the editor and asserts on the resulting
 * document, rather than merely checking that a binding exists: a keymap entry
 * pointing at a command that does not exist throws at press time, which a
 * source-level check would happily pass.
 *
 * Modifier note: prosemirror-keymap resolves the `Mod-` prefix from the
 * platform the editor runs on — Command on macOS, Control elsewhere. This probe
 * runs on macOS, so it must send Command (the Meta modifier); sending Control
 * would be testing a chord the keymap is not listening for.
 *
 * Usage: node scripts/check-shortcuts.mjs [url] [screenshot.png]
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_TO_LOAD = process.argv[2] ?? 'http://localhost:1420/';
const SHOT_PATH = process.argv[3] ?? '/tmp/moda-shortcuts.png';
const PORT = 9229;
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

/** Modifier bit for Command (Meta) in the DevTools protocol. */
const MOD = 4;

const edge = spawn(
  EDGE,
  [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--user-data-dir=/tmp/moda-edge-shortcuts',
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

/** Press a character with Command held. */
async function pressMod(cdp, key) {
  const upper = key.toUpperCase();
  const common = {
    modifiers: MOD,
    key: upper,
    code: /^[A-Z]$/.test(upper) ? `Key${upper}` : upper,
    windowsVirtualKeyCode: upper.charCodeAt(0),
    nativeVirtualKeyCode: upper.charCodeAt(0),
    // On macOS a Command chord is delivered as a keyDown carrying the metaKey.
    commands: [],
  };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  await sleep(200);
}

/** Select the whole document inside the editor. */
async function selectAll(cdp) {
  await cdp.eval(`(() => {
    const editor = document.querySelector('.milkdown .ProseMirror');
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  })()`);
  await sleep(120);
}

const results = [];

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

  /**
   * Reset the document to a known one-line state.
   *
   * Uses the app's own `setMarkdown`, which parses the markdown and swaps the
   * whole ProseMirror document. Replacing the text through a synthetic
   * select-all + insert would keep the previous case's marks: ProseMirror
   * applies its stored marks to inserted text, so formatting accumulated across
   * cases and made later assertions meaningless.
   */
  const reset = async (text) => {
    await cdp.eval(`(() => {
      window.moda.markdownEditor.setMarkdown(${JSON.stringify(text)});
      return true;
    })()`);
    await sleep(250);
  };

  const html = () =>
    cdp.eval(`document.querySelector('.milkdown .ProseMirror').innerHTML`);

  /** Run one case and record whether the assertion held. */
  const check = async (name, keys, prepare, assert) => {
    await reset('示例文本');
    const before = await html();
    // Record the selection too: a case whose modifier never reaches the editor
    // looks identical to one whose command is missing.
    const selection = await cdp.eval(`(() => {
      const s = window.getSelection();
      return { ranges: s.rangeCount, collapsed: s.isCollapsed, text: s.toString() };
    })()`);
    await prepare(cdp);
    const afterPrepare = await html();
    await keys(cdp);
    const actual = await html();
    const ok = assert(actual);
    results.push({
      name,
      ok,
      html: actual.slice(0, 120),
      before: before.slice(0, 80),
      afterPrepare: afterPrepare.slice(0, 80),
      selection,
    });
  };

  // Bold: ⌘B wraps the selection in <strong>.
  await check('Mod-b 加粗', (c) => pressMod(c, 'b'), selectAll, (h) =>
    /<strong|<b[\s>]/.test(h),
  );

  // Italic: ⌘I wraps in <em>.
  await check('Mod-i 斜体', (c) => pressMod(c, 'i'), selectAll, (h) =>
    /<em[\s>]/.test(h),
  );

  // Underline-as-italic: ⌘U.
  await check('Mod-u 斜体（代替下划线）', (c) => pressMod(c, 'u'), selectAll, (h) =>
    /<em[\s>]/.test(h),
  );

  // Inline code: ⌘` wraps in <code>.
  await check('Mod-` 行内代码', (c) => pressMod(c, '`'), selectAll, (h) =>
    /<code/.test(h),
  );

  // Headings: ⌘1..⌘6 set the level, ⌘0 returns to a paragraph.
  for (const level of [1, 2, 3]) {
    await check(`Mod-${level} 标题${level}`, (c) => pressMod(c, String(level)), async () => {}, (h) =>
      new RegExp(`<h${level}[\\s>]`).test(h),
    );
  }

  await check(
    'Mod-0 正文',
    async (c) => {
      await pressMod(c, '1');
      await pressMod(c, '0');
    },
    async () => {},
    (h) => /<p[\s>]/.test(h) && !/<h\d/.test(h),
  );

  // Link: ⌘K asks for a URL and then applies the mark. The prompt is stubbed so
  // the run is unattended; the assertion checks the href that landed in the DOM,
  // not merely that a dialog appeared.
  await check(
    'Mod-k 链接',
    (c) => pressMod(c, 'k'),
    async (c) => {
      await c.eval(`(() => {
        window.prompt = () => 'https://example.com/moda';
        const editor = document.querySelector('.milkdown .ProseMirror');
        const paragraph = editor.querySelector('p');
        const text = paragraph.firstChild;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, text.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      })()`);
      await sleep(150);
    },
    (h) => /<a[^>]+href="https:\/\/example\.com\/moda"/.test(h),
  );

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SHOT_PATH, Buffer.from(shot.data, 'base64'));

  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
    if (!r.ok) {
      console.log(`        before       : ${r.before}`);
      console.log(`        afterPrepare : ${r.afterPrepare}`);
      console.log(`        afterKeys    : ${r.html}`);
      console.log(`        selection    : ${JSON.stringify(r.selection)}`);
    }
  }
  console.log(`\nscreenshot: ${SHOT_PATH}`);

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${results.length} shortcuts did not apply.`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS: all ${results.length} shortcuts formatted the text.`);
  }

  cdp.close();
} finally {
  edge.kill('SIGTERM');
}
