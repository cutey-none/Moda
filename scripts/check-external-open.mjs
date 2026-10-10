#!/usr/bin/env node
/**
 * Assert that a document arriving from outside the app is opened and rendered.
 *
 * This targets the start-up race specifically. Stubbing the IPC bridge to report
 * a pending file *before* the app finishes starting is exactly the cold-launch
 * case that a Finder double-click produces, and the case an earlier
 * timer-based implementation got wrong: the path arrived, the window title
 * changed, and the editor stayed empty.
 *
 * So the assertions go past "did it notice the file" to "is the text on screen":
 * the editor must contain the document's text and the character count must be
 * non-zero.
 *
 * Usage: node scripts/check-external-open.mjs [url] [screenshot.png]
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_TO_LOAD = process.argv[2] ?? 'http://localhost:1420/';
const SHOT_PATH = process.argv[3] ?? '/tmp/moda-external-open.png';
const PORT = 9263;
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

/** The document the stub claims arrived with the launch. */
const EXTERNAL_PATH = '/tmp/moda-external/note.md';
const EXTERNAL_BODY = '# 外部打开的文档\n\n这一段必须出现在编辑器里。\n';

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

  // The pending file must be reported on the very first call, before the app has
  // finished starting — that is the cold-launch shape.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__modaTest = { calls: [], drained: false };
      window.__TAURI_INTERNALS__ = {
        invoke: async (cmd, args = {}) => {
          window.__modaTest.calls.push({ cmd, args });
          if (cmd === 'take_pending_open_files') {
            if (window.__modaTest.drained) return [];
            window.__modaTest.drained = true;
            return [${JSON.stringify(EXTERNAL_PATH)}];
          }
          if (cmd === 'read_document') {
            return {
              path: args.path,
              name: 'note.md',
              contents: ${JSON.stringify(EXTERNAL_BODY)},
              modifiedMs: 0,
            };
          }
          if (cmd === 'file_exists') return true;
          if (cmd === 'set_window_title') return null;
          return null;
        },
        transformCallback: () => 1,
        unregisterCallback: () => {},
        convertFileSrc: (path) => path,
      };
    `,
  });

  await cdp.send('Page.navigate', { url: URL_TO_LOAD });
  await sleep(7000);

  const state = await cdp.eval(`(() => {
    const editor = document.querySelector('.milkdown .ProseMirror');
    return {
      // The text the user actually sees.
      editorText: editor ? editor.innerText.trim() : null,
      editorHTML: editor ? editor.innerHTML.slice(0, 200) : null,
      headingRendered: Boolean(editor && editor.querySelector('h1')),
      title: document.getElementById('doc-name').textContent,
      path: document.getElementById('stat-path').textContent,
      chars: document.getElementById('stat-chars').textContent,
      status: document.getElementById('stat-state').textContent,
      emptyOverlayHidden: document.getElementById('empty').hidden,
      drained: window.__modaTest.drained,
      calls: window.__modaTest.calls.map((c) => c.cmd),
    };
  })()`);

  record(
    '拉取了待打开队列',
    state.calls.includes('take_pending_open_files'),
    JSON.stringify(state.calls),
  );
  record(
    '请求读取了外部路径',
    state.calls.includes('read_document'),
    JSON.stringify(state.calls),
  );
  record('窗口标题为文档名', state.title === 'note.md', state.title);
  record('状态栏显示路径', state.path.includes('note.md'), state.path);
  record(
    '渲染出一级标题',
    state.headingRendered === true,
    state.editorHTML ?? 'no editor',
  );
  record(
    '文档正文出现在编辑器里',
    (state.editorText ?? '').includes('这一段必须出现在编辑器里'),
    state.editorText ?? 'no editor',
  );
  record(
    '字数统计非零',
    !/^0\s/.test(state.chars) && state.chars !== '0 字符',
    state.chars,
  );
  record('欢迎遮罩已隐藏', state.emptyOverlayHidden === true);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SHOT_PATH, Buffer.from(shot.data, 'base64'));

  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n        ${r.detail}`}`);
  }
  console.log(`\nscreenshot: ${SHOT_PATH}`);

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${results.length} assertions failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS: the external document opened and rendered.`);
  }

  cdp.close();
} finally {
  edge.kill('SIGTERM');
}
