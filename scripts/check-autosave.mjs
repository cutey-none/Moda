#!/usr/bin/env node
/**
 * Assert that an edited document saves itself once typing pauses.
 *
 * Saving is a Tauri command, so this installs a stub
 * `window.__TAURI_INTERNALS__.invoke` that records every call. It proves the
 * frontend's half of auto-save: no write while typing continues, exactly one
 * write with the current text once it pauses, the same in source mode, and no
 * write at all for a document that has never been given a path — saving that
 * one would need a dialog, and a dialog popping up mid-sentence is worse than
 * waiting for the user to save.
 *
 * Usage: node scripts/check-autosave.mjs [url]
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_TO_LOAD = process.argv[2] ?? 'http://localhost:1420/';
const PORT = 9262;
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

const edge = spawn(
  EDGE,
  [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--user-data-dir=/tmp/moda-edge-autosave',
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

const results = [];
const record = (name, ok, detail = '') => results.push({ name, ok, detail });

const DOCUMENT_PATH = '/fixture/note.md';
const INITIAL = '# 自动保存\n\n初始内容。\n';

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

  // Install the stub before any app script runs.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__modaTest = { saves: [] };
      window.__TAURI_INTERNALS__ = {
        invoke: async (cmd, args = {}) => {
          if (cmd === 'read_document') {
            return { path: args.path, name: 'note.md', contents: ${JSON.stringify(INITIAL)}, modifiedMs: 0 };
          }
          if (cmd === 'save_document') {
            if (typeof args.path !== 'string' || typeof args.contents !== 'string') {
              return Promise.reject('save_document: expected { path, contents }');
            }
            window.__modaTest.saves.push({ path: args.path, contents: args.contents });
            return { path: args.path, name: 'note.md', contents: args.contents, modifiedMs: 0 };
          }
          if (cmd === 'file_exists') return true;
          return null;
        },
        transformCallback: () => 1,
        unregisterCallback: () => {},
        convertFileSrc: (path) => path,
      };
    `,
  });

  await cdp.send('Page.navigate', { url: URL_TO_LOAD });
  await sleep(6000);

  const saves = () => cdp.eval(`window.__modaTest.saves`);
  const dirtyShown = () => cdp.eval(`!document.getElementById('doc-dirty').hidden`);
  const typeAtEnd = async (text) => {
    await cdp.eval(`(() => {
      const prose = document.querySelector('.milkdown .ProseMirror');
      prose.focus();
      const range = document.createRange();
      range.selectNodeContents(prose);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()`);
    await cdp.send('Input.insertText', { text });
  };

  await cdp.eval(`window.moda.openPath(${JSON.stringify(DOCUMENT_PATH)})`);
  await sleep(800);

  // Keep typing, a keystroke every 0.6s: the pause never reaches 2s.
  for (const ch of ['甲', '乙', '丙', '丁']) {
    await typeAtEnd(ch);
    await sleep(600);
  }
  const whileTyping = await saves();
  record('输入未停顿时不保存', whileTyping.length === 0, JSON.stringify(whileTyping));
  record('未保存时显示修改标记', (await dirtyShown()) === true);

  await sleep(2500);
  const afterPause = await saves();
  record(
    '停顿 2 秒后保存一次',
    afterPause.length === 1,
    JSON.stringify(afterPause),
  );
  record(
    '保存的是当前文件和当前内容',
    afterPause[0]?.path === DOCUMENT_PATH && afterPause[0]?.contents.includes('甲乙丙丁'),
    JSON.stringify(afterPause[0]),
  );
  record('保存后修改标记消失', (await dirtyShown()) === false);

  // Source mode edits the same document through a textarea.
  await cdp.eval(`window.moda.toggleMode()`);
  await sleep(500);
  await cdp.eval(`(() => {
    const area = document.getElementById('source');
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    return true;
  })()`);
  await cdp.send('Input.insertText', { text: '源码追加' });
  await sleep(2600);
  const afterSource = await saves();
  record(
    '源码模式同样自动保存',
    afterSource.length === 2 && afterSource[1].contents.includes('源码追加'),
    JSON.stringify(afterSource.slice(1)),
  );
  await cdp.eval(`window.moda.toggleMode()`);
  await sleep(500);

  // A document with no path cannot be saved without a dialog, so it waits.
  await cdp.eval(`window.moda.newDocument()`);
  await sleep(800);
  await typeAtEnd('未命名文档的内容');
  await sleep(2600);
  const afterUntitled = await saves();
  record('未命名文档不自动保存', afterUntitled.length === 2, JSON.stringify(afterUntitled.slice(2)));
  record('未命名文档保留修改标记', (await dirtyShown()) === true);

  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n        ${r.detail}`}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${results.length} autosave assertions failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS: all ${results.length} autosave assertions held.`);
  }

  cdp.close();
} finally {
  edge.kill('SIGTERM');
}
