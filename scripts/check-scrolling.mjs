#!/usr/bin/env node
/**
 * Assert that a long document scrolls in exactly one container.
 *
 * Regression probe for the editor's scroll behaviour. Two nested elements both
 * declared `overflow-y: auto` would put a scrollbar at the window edge instead
 * of beside the text column, and make wheel handling unpredictable. This checks
 * which element actually scrolls once the document is taller than the viewport.
 *
 * Usage: node scripts/check-scrolling.mjs [url]
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_TO_LOAD = process.argv[2] ?? 'http://localhost:1420/';
const PORT = 9228;
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

const edge = spawn(
  EDGE,
  [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--user-data-dir=/tmp/moda-edge-scroll',
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

  // Put the editor in a state a real user would create: lots of text.
  await cdp.eval(`(() => {
    const editor = document.querySelector('.milkdown .ProseMirror');
    editor.focus();
    return true;
  })()`);
  await cdp.send('Input.insertText', {
    text: Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 行内容，用来把文档撑得比窗口更高。`).join('\n\n'),
  });
  await sleep(1500);

  const report = await cdp.eval(`(() => {
    const measure = (element, name) => ({
      name,
      scrollTop: Math.round(element.scrollTop),
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
      canScroll: element.scrollHeight > element.clientHeight + 1,
    });
    const editor = document.getElementById('editor');
    const milkdown = document.querySelector('.milkdown');
    return {
      editor: measure(editor, '#editor'),
      milkdown: measure(milkdown, '.milkdown'),
      scrollers: [editor, milkdown].filter((el) => el.scrollHeight > el.clientHeight + 1).length,
    };
  })()`);

  console.log(JSON.stringify(report, null, 2));

  if (report.scrollers === 0) {
    console.error('\nFAIL: nothing scrolls, but the document is taller than the viewport.');
    process.exitCode = 1;
  } else if (report.scrollers > 1) {
    console.error(`\nFAIL: ${report.scrollers} nested containers scroll; expected exactly one.`);
    process.exitCode = 1;
  } else {
    console.log('\nPASS: exactly one container scrolls.');
  }

  cdp.close();
} finally {
  edge.kill('SIGTERM');
}
