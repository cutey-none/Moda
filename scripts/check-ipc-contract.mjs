#!/usr/bin/env node
/**
 * Assert the frontend calls every Rust command with the arguments it expects.
 *
 * Tauri matches arguments by name: a Rust parameter `path: String` is a
 * JavaScript `{ path }`, and a parameter `contents: String` is `{ contents }`.
 * Nothing checks that at build time, and neither existing test layer can see it —
 * the Rust unit tests call the functions directly and never cross the boundary,
 * while the other browser checks stub the bridge and accept whatever shape they
 * are handed. A mismatch is therefore invisible until a user presses the button
 * and gets "invalid args".
 *
 * That is exactly how `save_document` shipped broken: the Rust side took a single
 * `request` struct while the frontend sent `{ path, contents }`, so every save
 * failed. This check closes that gap by recording the real arguments each command
 * is invoked with and comparing them against the command signatures.
 *
 * The expected shapes below are the contract. When a command's Rust signature
 * changes, its entry here must change with it — and that is the point: the two
 * sides cannot drift silently.
 *
 * Usage: node scripts/check-ipc-contract.mjs [url]
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_TO_LOAD =
  (process.argv[2] ?? 'http://localhost:1420/') +
  // `file_exists` is only reached on the launch-with-a-file path, which reports
  // a file the app was asked to open when it started. Without this the command
  // would go unexercised and its contract unverified.
  '?file=' +
  encodeURIComponent('/fixture/notes/note.md');
const PORT = 9267;
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

/**
 * The argument names each command's Rust signature declares.
 *
 * Derived from `src-tauri/src/*.rs`; `save_document(path, contents)` and the
 * rest take one or two named scalars.
 */
const CONTRACT = {
  read_document: ['path'],
  save_document: ['path', 'contents'],
  file_exists: ['path'],
  read_directory_tree: ['path'],
  take_pending_open_files: [],
};

/** A document to open, so the read and save paths are exercised. */
const TREE = {
  path: '/fixture/notes',
  name: 'notes',
  truncated: false,
  entries: [
    {
      name: 'note.md',
      path: '/fixture/notes/note.md',
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
    '--user-data-dir=/tmp/moda-edge-contract',
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

  // Record every command name and the exact arguments object it received.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__modaTest = { calls: [] };
      window.__TAURI_INTERNALS__ = {
        invoke: async (cmd, args = {}) => {
          window.__modaTest.calls.push({ cmd, args: JSON.parse(JSON.stringify(args ?? {})) });
          if (cmd === 'read_directory_tree') return ${JSON.stringify(TREE)};
          if (cmd === 'take_pending_open_files') return [];
          if (cmd === 'read_document') {
            return { path: args.path, name: 'note.md', contents: '# 正文\\n', modifiedMs: 0 };
          }
          if (cmd === 'save_document') {
            // Reject the way the real command did when its arguments did not
            // match, so a wrong shape fails here rather than being absorbed.
            if (typeof args.path !== 'string' || typeof args.contents !== 'string') {
              return Promise.reject(
                'invalid args for command save_document: expected { path, contents }',
              );
            }
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

  // Exercise every command the app can reach, so its invocation is recorded.
  await cdp.eval(`window.moda.loadFolder('/fixture/notes')`);
  await sleep(600);
  await cdp.eval(`window.moda.openPath('/fixture/notes/note.md')`);
  await sleep(600);
  await cdp.eval(`window.moda.markdownEditor.setMarkdown('# 修改后的内容\\n')`);
  await sleep(600);
  const saveOutcome = await cdp.eval(`(async () => {
    try {
      // The app's own save path: what the save shortcut and menu item call,
      // so this drives the real chain rather than the bridge directly.
      await window.moda.saveDocument();
      return { ok: true, status: document.getElementById('stat-state').textContent };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  })()`);
  await sleep(700);

  const calls = await cdp.eval(`window.__modaTest.calls`);

  // Which argument names did each command actually receive?
  const observed = new Map();
  for (const { cmd, args } of calls) {
    const names = Object.keys(args).sort();
    const previous = observed.get(cmd);
    if (previous === undefined) observed.set(cmd, names);
    else if (JSON.stringify(previous) !== JSON.stringify(names)) {
      // A command invoked two different ways is itself a defect.
      observed.set(cmd, [...new Set([...previous, ...names])].sort());
    }
  }

  for (const [cmd, expected] of Object.entries(CONTRACT)) {
    const seen = observed.get(cmd);
    if (seen === undefined) {
      // Not reached in this run is reported rather than silently passing.
      record(`${cmd} 被调用`, false, '命令未被调用，契约未验证');
      continue;
    }
    const same =
      seen.length === expected.length && expected.every((name) => seen.includes(name));
    record(
      `${cmd} 参数形状 (${expected.join(', ') || '无参数'})`,
      same,
      `期望 [${expected.join(', ')}]，实际 [${seen.join(', ')}]`,
    );
  }

  // Saving must actually reach the command and report success.
  const saveCall = calls.find((c) => c.cmd === 'save_document');
  record(
    'save_document 收到了 path 与 contents',
    saveCall !== undefined &&
      typeof saveCall.args.path === 'string' &&
      typeof saveCall.args.contents === 'string',
    JSON.stringify(saveCall?.args ?? null),
  );
  record(
    '保存成功并更新状态栏',
    saveOutcome.ok === true && String(saveOutcome.status).includes('已保存'),
    JSON.stringify(saveOutcome),
  );

  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n        ${r.detail}`}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${results.length} IPC contract assertions failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS: all ${results.length} IPC contract assertions held.`);
  }

  cdp.close();
} finally {
  edge.kill('SIGTERM');
}
