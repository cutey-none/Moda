#!/usr/bin/env node
/**
 * Assert that the sidebar file tree renders, expands, and opens files.
 *
 * The real directory reader is a Tauri command, so it cannot run in a plain
 * browser. This check installs a stub `window.__TAURI_INTERNALS__.invoke` before
 * the app's scripts load, and feeds it a fixture tree. That splits the coverage
 * cleanly: `src-tauri/src/directory.rs` unit tests prove what the filesystem
 * yields, and this proves what the sidebar does with it — rendering depth,
 * expand/collapse state, which paths it asks for, and that clicking a file
 * issues a `read_document` for exactly that path.
 *
 * Usage: node scripts/check-sidebar.mjs [url] [screenshot.png]
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_TO_LOAD = process.argv[2] ?? 'http://localhost:1420/';
const SHOT_PATH = process.argv[3] ?? '/tmp/moda-sidebar.png';
const PORT = 9260;
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

/** The stub the page runs against: a small workspace with nested folders. */
const FIXTURE = {
  tree: {
    path: '/fixture/notes',
    name: 'notes',
    truncated: false,
    entries: [
      {
        name: 'archive',
        path: '/fixture/notes/archive',
        isDirectory: true,
        isMarkdown: false,
        size: 0,
        modifiedMs: 0,
        children: [
          {
            name: 'old.md',
            path: '/fixture/notes/archive/old.md',
            isDirectory: false,
            isMarkdown: true,
            size: 10,
            modifiedMs: 0,
            children: [],
          },
        ],
      },
      {
        name: 'readme.md',
        path: '/fixture/notes/readme.md',
        isDirectory: false,
        isMarkdown: true,
        size: 20,
        modifiedMs: 0,
        children: [],
      },
      {
        name: 'image.png',
        path: '/fixture/notes/image.png',
        isDirectory: false,
        isMarkdown: false,
        size: 30,
        modifiedMs: 0,
        children: [],
      },
    ],
  },
  /** Markdown keyed by path, for the stubbed `read_document`. */
  documents: {
    '/fixture/notes/readme.md': '来自侧边栏的正文',
    '/fixture/notes/archive/old.md': '档案里的正文',
  },
};

const edge = spawn(
  EDGE,
  [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--user-data-dir=/tmp/moda-edge-sidebar',
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

  // Install the stub before any app script runs.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__modaTest = { calls: [] };
      window.__TAURI_INTERNALS__ = {
        invoke: async (cmd, args = {}) => {
          window.__modaTest.calls.push({ cmd, args });
          const fixture = ${JSON.stringify(FIXTURE)};
          if (cmd === 'read_directory_tree') return fixture.tree;
          if (cmd === 'read_document') {
            const contents = fixture.documents[args.path];
            if (contents === undefined) {
              return Promise.reject({ kind: 'notFound', path: args.path });
            }
            return {
              path: args.path,
              name: args.path.split('/').pop(),
              contents,
              modifiedMs: 0,
            };
          }
          if (cmd === 'file_exists') return true;
          if (cmd === 'save_document') {
            // Assert the argument shape rather than reading it hopefully: the
            // command once took a single 'request' struct while the frontend sent
            // { path, contents }, and a stub that merely reads the fields cannot
            // notice. See scripts/check-ipc-contract.mjs for the full contract.
            if (typeof args.path !== 'string' || typeof args.contents !== 'string') {
              return Promise.reject(
                'save_document: expected { path, contents }, got ' + JSON.stringify(Object.keys(args)),
              );
            }
            return { path: args.path, name: 'x.md', contents: args.contents, modifiedMs: 0 };
          }
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

  // The sidebar starts hidden; the app must be able to reveal it.
  const initiallyHidden = await cdp.eval(
    `document.getElementById('sidebar').hidden`,
  );
  record('侧边栏初始隐藏', initiallyHidden === true);

  // Load the fixture folder directly: the folder picker is a native dialog and
  // returns nothing headless. `loadFolder` is the same path the picker feeds.
  await cdp.eval(`window.moda.loadFolder('/fixture/notes')`);
  await sleep(800);

  const afterOpen = await cdp.eval(`(() => {
    const sidebar = document.getElementById('sidebar');
    const rows = [...document.querySelectorAll('#sidebar-tree .tree__row')];
    return {
      hidden: sidebar.hidden,
      title: document.getElementById('sidebar-title').textContent,
      labels: rows.map((r) => r.querySelector('.tree__label').textContent),
      // Indentation is what encodes depth in the DOM.
      indents: rows.map((r) => r.style.paddingLeft),
      activeLabels: [...document.querySelectorAll('#sidebar-tree .tree__row--active .tree__label')]
        .map((el) => el.textContent),
      calls: window.__modaTest.calls.map((c) => c.cmd),
    };
  })()`);

  record('打开文件夹后侧边栏可见', afterOpen.hidden === false, JSON.stringify(afterOpen));
  record('侧边栏标题为文件夹名', afterOpen.title === 'notes', afterOpen.title);
  record(
    '渲染了顶层条目',
    afterOpen.labels.includes('readme.md') && afterOpen.labels.includes('archive'),
    JSON.stringify(afterOpen.labels),
  );
  record(
    '请求了 read_directory_tree',
    afterOpen.calls.includes('read_directory_tree'),
    JSON.stringify(afterOpen.calls),
  );

  // The root's subfolders are expanded by default, so the nested file shows.
  record(
    '子文件夹默认展开，嵌套文件可见',
    afterOpen.labels.includes('old.md'),
    JSON.stringify(afterOpen.labels),
  );

  // Depth: the nested row is indented further than its parent.
  const archiveIndent = afterOpen.indents[afterOpen.labels.indexOf('archive')] ?? '';
  const nestedIndent = afterOpen.indents[afterOpen.labels.indexOf('old.md')] ?? '';
  record(
    '嵌套条目缩进更深',
    parseInt(nestedIndent, 10) > parseInt(archiveIndent, 10),
    `${archiveIndent} vs ${nestedIndent}`,
  );

  // Collapse the folder and confirm its children go away.
  await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#sidebar-tree .tree__row')];
    const archive = rows.find((r) => r.querySelector('.tree__label').textContent === 'archive');
    archive.click();
    return true;
  })()`);
  await sleep(300);
  const collapsed = await cdp.eval(
    `[...document.querySelectorAll('#sidebar-tree .tree__label')].map((el) => el.textContent)`,
  );
  record('折叠后子项消失', !collapsed.includes('old.md'), JSON.stringify(collapsed));

  // Expand it again.
  await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#sidebar-tree .tree__row')];
    const archive = rows.find((r) => r.querySelector('.tree__label').textContent === 'archive');
    archive.click();
    return true;
  })()`);
  await sleep(300);
  const reExpanded = await cdp.eval(
    `[...document.querySelectorAll('#sidebar-tree .tree__label')].map((el) => el.textContent)`,
  );
  record('再次展开恢复子项', reExpanded.includes('old.md'), JSON.stringify(reExpanded));

  // Click a markdown file: it must request exactly that path and load it.
  await cdp.eval(`(() => {
    window.__modaTest.calls.length = 0;
    const rows = [...document.querySelectorAll('#sidebar-tree .tree__row')];
    rows.find((r) => r.querySelector('.tree__label').textContent === 'readme.md').click();
    return true;
  })()`);
  await sleep(900);
  const opened = await cdp.eval(`(() => {
    const read = window.__modaTest.calls.find((c) => c.cmd === 'read_document');
    return {
      readPath: read ? read.args.path : null,
      editorText: document.querySelector('.milkdown .ProseMirror').innerText.trim(),
      activeLabels: [...document.querySelectorAll('#sidebar-tree .tree__row--active .tree__label')]
        .map((el) => el.textContent),
    };
  })()`);
  record(
    '点击文件请求了正确的路径',
    opened.readPath === '/fixture/notes/readme.md',
    String(opened.readPath),
  );
  record(
    '文档内容进入编辑器',
    opened.editorText.includes('来自侧边栏的正文'),
    opened.editorText,
  );
  record(
    '当前文件在树中高亮',
    opened.activeLabels.includes('readme.md'),
    JSON.stringify(opened.activeLabels),
  );

  // A non-markdown file must not be opened.
  await cdp.eval(`(() => {
    window.__modaTest.calls.length = 0;
    const rows = [...document.querySelectorAll('#sidebar-tree .tree__row')];
    rows.find((r) => r.querySelector('.tree__label').textContent === 'image.png').click();
    return true;
  })()`);
  await sleep(300);
  const nonMarkdown = await cdp.eval(`(() => ({
    readCalled: window.__modaTest.calls.some((c) => c.cmd === 'read_document'),
    status: document.getElementById('stat-state').textContent,
  }))()`);
  record(
    '非 Markdown 文件不被打开并给出提示',
    nonMarkdown.readCalled === false && nonMarkdown.status.includes('不是 Markdown'),
    JSON.stringify(nonMarkdown),
  );

  // Toggling hides and shows again.
  const toggled = await cdp.eval(`(() => {
    const before = document.getElementById('sidebar').hidden;
    window.moda.toggleSidebar();
    const after = document.getElementById('sidebar').hidden;
    window.moda.toggleSidebar();
    return { before, after, restored: document.getElementById('sidebar').hidden };
  })()`);
  record(
    '切换会隐藏并恢复侧边栏',
    toggled.before === false && toggled.after === true && toggled.restored === false,
    JSON.stringify(toggled),
  );

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SHOT_PATH, Buffer.from(shot.data, 'base64'));

  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n        ${r.detail}`}`);
  }
  console.log(`\nscreenshot: ${SHOT_PATH}`);

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${results.length} sidebar assertions failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS: all ${results.length} sidebar assertions held.`);
  }

  cdp.close();
} finally {
  edge.kill('SIGTERM');
}
