#!/usr/bin/env node
/**
 * Assert that native menu choices actually run their commands.
 *
 * The menu bar itself is built in Rust and its items are unit-tested there
 * (`src-tauri/src/menu.rs`), but whether a click reaches the frontend and does
 * the right thing is a different question — and the one a user would notice. The
 * host's event channel is stubbed so each command can be injected directly.
 *
 * The assertions check the *effect* of each command, not that a handler was
 * called: "toggle-source" must actually swap the editing surface, "toggle-sidebar"
 * must actually hide the panel. A dispatch table that maps everything to a no-op
 * would pass a call-count check and fail these.
 *
 * Usage: node scripts/check-menu.mjs [url] [screenshot.png]
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_TO_LOAD = process.argv[2] ?? 'http://localhost:1420/';
const SHOT_PATH = process.argv[3] ?? '/tmp/moda-menu-check.png';
const PORT = 9265;
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

/** The tree the sidebar is given, so its commands have something to act on. */
const TREE = {
  path: '/fixture/notes',
  name: 'notes',
  truncated: false,
  entries: [
    {
      name: 'readme.md',
      path: '/fixture/notes/readme.md',
      isDirectory: false,
      isMarkdown: true,
      size: 1,
      modifiedMs: 0,
      children: [],
    },
  ],
};

const edge = spawn(
  EDGE,
  [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--user-data-dir=/tmp/moda-edge-menu',
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

  // Only the IPC bridge is stubbed. The menu's event channel is not: digging
  // into Tauri's event plugin internals just to fake a delivery would test the
  // stub, not the app. The dispatch table that the listener calls is driven
  // directly instead, which is the real seam.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__modaTest = { listeners: {}, calls: [] };
      window.__TAURI_INTERNALS__ = {
        invoke: async (cmd, args = {}) => {
          window.__modaTest.calls.push({ cmd, args });
          if (cmd === 'read_directory_tree') return ${JSON.stringify(TREE)};
          if (cmd === 'take_pending_open_files') return [];
          if (cmd === 'read_document') {
            return { path: args.path, name: 'readme.md', contents: '正文', modifiedMs: 0 };
          }
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
            return { path: args.path, name: 'readme.md', contents: args.contents, modifiedMs: 0 };
          }
          if (cmd === 'file_exists') return true;
          return null;
        },
        // Tauri's event API registers its callbacks through this.
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

  // Load a folder so the sidebar commands have something to act on.
  await cdp.eval(`window.moda.loadFolder('/fixture/notes')`);
  await sleep(700);

  /**
   * Run a menu command through the app's own dispatch table.
   *
   * This is the method the native menu's event listener calls, so the path is
   * the production one; only the transport is skipped.
   */
  const deliver = async (command) => {
    await cdp.eval(`window.moda.runMenuCommand(${JSON.stringify(command)})`);
    await sleep(400);
  };

  // toggle-source must actually swap the editing surface.
  const beforeMode = await cdp.eval(`document.getElementById('btn-mode').textContent`);
  await deliver('toggle-source');
  const afterMode = await cdp.eval(`(() => ({
    button: document.getElementById('btn-mode').textContent,
    sourceHidden: document.getElementById('source').hidden,
  }))()`);
  record(
    'toggle-source 切换了编辑界面',
    afterMode.button !== beforeMode && afterMode.sourceHidden === false,
    JSON.stringify({ beforeMode, afterMode }),
  );

  // Back to WYSIWYG for the remaining checks.
  await deliver('toggle-source');
  const restored = await cdp.eval(`document.getElementById('btn-mode').textContent`);
  record('toggle-source 可切回', restored === beforeMode, restored);

  // toggle-sidebar must actually hide the panel.
  const sidebarWasVisible = await cdp.eval(`!document.getElementById('sidebar').hidden`);
  await deliver('toggle-sidebar');
  const sidebarNowHidden = await cdp.eval(`document.getElementById('sidebar').hidden`);
  record(
    'toggle-sidebar 隐藏了侧边栏',
    sidebarWasVisible === true && sidebarNowHidden === true,
    JSON.stringify({ sidebarWasVisible, sidebarNowHidden }),
  );
  await deliver('toggle-sidebar');

  // refresh-tree must ask the host for the tree again.
  const callsBefore = await cdp.eval(
    `window.__modaTest.calls.filter((c) => c.cmd === 'read_directory_tree').length`,
  );
  await deliver('refresh-tree');
  const callsAfter = await cdp.eval(
    `window.__modaTest.calls.filter((c) => c.cmd === 'read_directory_tree').length`,
  );
  record(
    'refresh-tree 重新读取了目录树',
    callsAfter > callsBefore,
    `${callsBefore} -> ${callsAfter}`,
  );

  // about must report something in the status line rather than doing nothing.
  await deliver('about');
  const aboutStatus = await cdp.eval(
    `document.getElementById('stat-state').textContent`,
  );
  record(
    'about 给出了反馈',
    aboutStatus.includes('Moda'),
    aboutStatus,
  );

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SHOT_PATH, Buffer.from(shot.data, 'base64'));

  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n        ${r.detail}`}`);
  }
  console.log(`\nscreenshot: ${SHOT_PATH}`);

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${results.length} menu assertions failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS: all ${results.length} menu assertions held.`);
  }

  cdp.close();
} finally {
  edge.kill('SIGTERM');
}
