#!/usr/bin/env node
/**
 * Assert that a file changed by another app is picked up on returning to Moda.
 *
 * The Tauri bridge is stubbed with an in-memory disk the check can write to,
 * which stands in for the other app; a `focus` event stands in for switching
 * back to the window. Each case reads the editor's own document afterwards, not
 * the status line, so a message announcing a reload that never happened fails.
 *
 * Usage: node scripts/check-external-change.mjs [url]
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_TO_LOAD = process.argv[2] ?? 'http://localhost:1420/';
const PORT = 9272;
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const PATH = '/fixture/notes/note.md';

const edge = spawn(
  EDGE,
  [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--user-data-dir=/tmp/moda-edge-external',
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

  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__modaTest = { listeners: {}, disk: {}, asked: [], answer: true, saves: 0 };
      const doc = (path) => ({
        path,
        name: path.split('/').pop(),
        contents: window.__modaTest.disk[path],
        modifiedMs: 0,
      });
      window.__TAURI_INTERNALS__ = {
        invoke: async (cmd, args = {}) => {
          if (cmd === 'read_document') {
            if (!(args.path in window.__modaTest.disk)) return Promise.reject({ kind: 'notFound', path: args.path });
            return doc(args.path);
          }
          if (cmd === 'save_document') {
            window.__modaTest.disk[args.path] = args.contents;
            window.__modaTest.saves += 1;
            return doc(args.path);
          }
          if (cmd === 'plugin:dialog|message') {
            // The real dialog answers with the label of the button pressed, and
            // ask() compares it against its OK label.
            window.__modaTest.asked.push(args);
            const [ok, cancel] = args.buttons.OkCancelCustom;
            return window.__modaTest.answer ? ok : cancel;
          }
          if (cmd === 'take_pending_open_files') return [];
          if (cmd === 'read_directory_tree') {
            return { path: '/fixture/notes', name: 'notes', truncated: false, entries: [] };
          }
          return null;
        },
        transformCallback: (cb) => {
          const id = Object.keys(window.__modaTest.listeners).length + 1;
          window.__modaTest.listeners[id] = cb;
          return id;
        },
        unregisterCallback: () => {},
        convertFileSrc: (path) => path,
      };
    `,
  });

  await cdp.send('Page.navigate', { url: URL_TO_LOAD });
  await sleep(6000);

  /** Write the file as another app would. */
  const otherAppSaves = (contents) =>
    cdp.eval(`window.__modaTest.disk[${JSON.stringify(PATH)}] = ${JSON.stringify(contents)}`);
  /** Switch back to Moda. */
  const returnToModa = async () => {
    await cdp.eval(`window.dispatchEvent(new Event('focus'))`);
    await sleep(600);
  };
  const shown = () => cdp.eval(`window.moda.markdownEditor.getMarkdown()`);
  const state = () => cdp.eval(`(() => ({
    status: document.getElementById('stat-state').textContent,
    dirty: !document.getElementById('doc-dirty').hidden,
    asked: window.__modaTest.asked.length,
    disk: window.__modaTest.disk[${JSON.stringify(PATH)}],
  }))()`);

  await otherAppSaves('# 笔记\n\n第一版。\n');
  await cdp.eval(`window.moda.openPath(${JSON.stringify(PATH)})`);
  await sleep(600);

  // 1. Nothing edited here: the other app's version simply appears.
  await otherAppSaves('# 笔记\n\n第二版，来自其他应用。\n');
  await returnToModa();
  const reloaded = await shown();
  const afterReload = await state();
  record('无本地修改时自动载入新内容', reloaded.includes('第二版'), reloaded);
  record('自动载入后不算未保存、也不询问', !afterReload.dirty && afterReload.asked === 0, JSON.stringify(afterReload));

  // 2. Returning with nothing changed on disk does nothing.
  await returnToModa();
  record('磁盘未变化时不打扰', (await state()).asked === 0 && (await shown()).includes('第二版'));

  // 3. Edits on both sides, user keeps Moda's.
  await cdp.eval(`window.moda.markdownEditor.setMarkdown('# 笔记\\n\\nModa 里的修改。\\n')`);
  await sleep(400);
  await otherAppSaves('# 笔记\n\n第三版，来自其他应用。\n');
  await cdp.eval(`window.__modaTest.answer = false`);
  await returnToModa();
  const kept = await shown();
  const afterKeep = await state();
  record('两边都改时询问用户', afterKeep.asked === 1, JSON.stringify(afterKeep));
  record('选择保留时不覆盖本地修改', kept.includes('Moda 里的修改'), kept);
  await returnToModa();
  record('对同一版本不重复询问', (await state()).asked === 1, JSON.stringify(await state()));

  // Keeping means the next save writes Moda's version over the other app's.
  await sleep(2500);
  const afterKeptSave = await state();
  record(
    '保留后自动保存写入本地修改',
    afterKeptSave.disk.includes('Moda 里的修改') && !afterKeptSave.dirty,
    JSON.stringify(afterKeptSave),
  );

  // 4. Edits on both sides, user takes the disk version. Done well inside the
  // autosave delay, as switching apps right after typing would be.
  await cdp.eval(`window.moda.markdownEditor.setMarkdown('# 笔记\\n\\n又一处本地修改。\\n')`);
  await sleep(300);
  await otherAppSaves('# 笔记\n\n第四版，来自其他应用。\n');
  await cdp.eval(`window.__modaTest.answer = true`);
  await returnToModa();
  const taken = await shown();
  const afterTake = await state();
  record('选择载入时换成磁盘版本', taken.includes('第四版') && afterTake.asked === 2, taken);
  record('载入后不算未保存', !afterTake.dirty, JSON.stringify(afterTake));

  // 5. Autosave must not overwrite a version another app saved in the meantime.
  await cdp.eval(`window.moda.markdownEditor.setMarkdown('# 笔记\\n\\n切走前打的字。\\n')`);
  await sleep(300);
  await otherAppSaves('# 笔记\n\n切走后其他应用保存的。\n');
  await sleep(2800);
  const afterAutosave = await state();
  record(
    '自动保存不覆盖其他应用的修改',
    afterAutosave.disk.includes('切走后其他应用保存的'),
    JSON.stringify(afterAutosave),
  );

  // 6. The file disappears: keep what is on screen.
  await cdp.eval(`window.__modaTest.answer = false`);
  await returnToModa();
  await cdp.eval(`delete window.__modaTest.disk[${JSON.stringify(PATH)}]`);
  const before = await shown();
  await returnToModa();
  const afterDelete = await state();
  record(
    '文件被删除时保留内容并提示',
    (await shown()) === before && afterDelete.status.includes('不在原位置'),
    JSON.stringify(afterDelete),
  );

  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n        ${r.detail}`}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${results.length} external-change assertions failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS: all ${results.length} external-change assertions held.`);
  }

  cdp.close();
} finally {
  edge.kill('SIGTERM');
}
