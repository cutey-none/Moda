#!/usr/bin/env node
/**
 * Assert that "检查更新…" tells the user what happened, and only restarts after
 * an update installed.
 *
 * The updater plugin cannot run in a browser, so the app's update backend is
 * swapped for a scripted one through `window.moda.updates.useBackend` — the
 * same seam idea as `runMenuCommand` in check-menu. What is asserted is what a
 * user would see: the bar's text and buttons, and whether a restart happened.
 * The plugin itself is exercised by the local end-to-end run in the plan.
 *
 * Usage: node scripts/check-updater.mjs [url] [screenshot.png]
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_TO_LOAD = process.argv[2] ?? 'http://localhost:1420/';
const SHOT_PATH = process.argv[3] ?? '/tmp/moda-updater-check.png';
const PORT = 9268;
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

const edge = spawn(
  EDGE,
  [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--user-data-dir=/tmp/moda-edge-updater',
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
      window.__modaTest = { askAnswer: true, asks: 0 };
      window.__TAURI_INTERNALS__ = {
        invoke: async (cmd) => {
          if (cmd.startsWith('plugin:dialog|')) {
            window.__modaTest.asks += 1;
            // ask() resolves true only when the dialog answered its OK label.
            return window.__modaTest.askAnswer ? 'Yes' : 'No';
          }
          if (cmd === 'take_pending_open_files') return [];
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

  /**
   * Install a scripted backend.
   *
   * `check` is the JS source of an async function body; `install` likewise, with
   * `onProgress` in scope. Every call is counted on `window.__u`.
   */
  const useBackend = ({ check, install = 'onProgress(0.5); onProgress(1);' }) =>
    cdp.eval(`(() => {
      window.__u = { checks: 0, installs: 0, relaunches: 0, gate: null };
      window.moda.updates.useBackend({
        currentVersion: async () => '0.0.2',
        check: async () => { window.__u.checks += 1; ${check} },
        relaunch: async () => { window.__u.relaunches += 1; },
      });
      window.__makeUpdate = (version, notes = '') => ({
        version,
        notes,
        install: async (onProgress) => { window.__u.installs += 1; ${install} },
      });
      return true;
    })()`);

  const bar = () =>
    cdp.eval(`(() => {
      const root = document.getElementById('updatebar');
      const buttons = [...root.querySelectorAll('button')].filter((b) => !b.hidden);
      return {
        hidden: root.hidden,
        text: root.querySelector('.updatebar__text').textContent,
        notes: root.querySelector('.updatebar__notes').textContent,
        buttons: buttons.map((b) => b.textContent),
      };
    })()`);
  const counts = () => cdp.eval(`window.__u`);
  const click = async (label) => {
    await cdp.eval(`[...document.querySelectorAll('#updatebar button')]
      .find((b) => !b.hidden && b.textContent === ${JSON.stringify(label)}).click()`);
    await sleep(300);
  };
  const menu = async () => {
    await cdp.eval(`window.moda.runMenuCommand('check-for-updates')`);
    await sleep(300);
  };

  // 0. Nothing is checked until the user asks.
  await useBackend({ check: 'return null;' });
  record('启动后不会自动检查更新', (await counts()).checks === 0 && (await bar()).hidden);

  // 1. Already up to date.
  await menu();
  let b = await bar();
  record('已是最新时如实告知', !b.hidden && b.text === '已是最新版本 0.0.2', JSON.stringify(b));
  await click('好');
  record('“好”关闭了更新条', (await bar()).hidden);

  // 2. The check fails, and retry checks again.
  await useBackend({ check: "throw new Error('网络不可用');" });
  await menu();
  b = await bar();
  record('检查失败时显示原因', b.text.includes('检查更新失败') && b.text.includes('网络不可用'), JSON.stringify(b));
  await click('重试');
  record('重试会重新检查', (await counts()).checks === 2);
  await click('关闭');

  // 3. An update is available; "稍后" hides it without installing.
  await useBackend({ check: "return window.__makeUpdate('0.0.3', '修复了查找\\n新增应用内更新\\n第三行\\n第四行');" });
  await menu();
  b = await bar();
  record(
    '有新版时显示版本和说明',
    b.text === 'Moda 0.0.3 可用' && b.notes === '修复了查找\n新增应用内更新\n第三行' &&
      JSON.stringify(b.buttons) === JSON.stringify(['更新并重启', '稍后']),
    JSON.stringify(b),
  );
  await click('稍后');
  record('“稍后”不下载', (await bar()).hidden && (await counts()).installs === 0);

  // 4. Clean document: update and restart.
  await menu();
  await click('更新并重启');
  await sleep(300);
  let c = await counts();
  record('干净文档：安装后重启', c.installs === 1 && c.relaunches === 1, JSON.stringify(c));

  // 5. Dirty document, user refuses to discard: nothing is downloaded.
  await cdp.eval(`window.moda.runMenuCommand('new-document')`);
  await sleep(500);
  await cdp.eval(`(() => {
    const prose = document.querySelector('.milkdown .ProseMirror');
    prose.focus();
    return true;
  })()`);
  await cdp.send('Input.insertText', { text: '未保存的内容' });
  await sleep(300);
  await cdp.eval(`window.__modaTest.askAnswer = false`);
  await useBackend({ check: "return window.__makeUpdate('0.0.3');" });
  await menu();
  await click('更新并重启');
  b = await bar();
  c = await counts();
  record(
    '未保存且取消：不下载，回到可更新状态',
    c.installs === 0 && b.text === 'Moda 0.0.3 可用',
    JSON.stringify({ c, b }),
  );

  // 5b. Dirty document, discard confirmed, nothing typed during the download:
  //     the answer stands, so the user is asked once, not again before restart.
  await cdp.eval(`window.__modaTest.askAnswer = true; window.__modaTest.asks = 0`);
  await useBackend({ check: "return window.__makeUpdate('0.0.3');" });
  await menu();
  await click('更新并重启');
  await sleep(300);
  c = await counts();
  let asks = await cdp.eval(`window.__modaTest.asks`);
  record('未保存但已确认放弃：只问一次就重启', asks === 1 && c.relaunches === 1, JSON.stringify({ asks, c }));

  // 6. Edits made during the download: confirmed before, refused after.
  //    The update is installed but the app must not restart.
  await cdp.eval(`window.__modaTest.askAnswer = true; window.__modaTest.asks = 0`);
  await useBackend({
    check: "return window.__makeUpdate('0.0.3');",
    install: `onProgress(0.5);
      document.querySelector('.milkdown .ProseMirror').focus();
      document.execCommand('insertText', false, '下载时写的');
      await new Promise((r) => setTimeout(r, 300));
      window.__modaTest.askAnswer = false;`,
  });
  await menu();
  await click('更新并重启');
  await sleep(600);
  b = await bar();
  c = await counts();
  asks = await cdp.eval(`window.__modaTest.asks`);
  record(
    '下载期间又有修改且取消：已安装但不重启',
    asks === 2 && c.installs === 1 && c.relaunches === 0 && b.text === 'Moda 0.0.3 已安装，重启后生效' &&
      JSON.stringify(b.buttons) === JSON.stringify(['立即重启', '稍后']),
    JSON.stringify({ asks, c, b }),
  );

  await cdp.eval(`window.__modaTest.askAnswer = true`);
  await click('立即重启');
  record('“立即重启”在确认后重启', (await counts()).relaunches === 1);

  // 7. Progress: a known size shows a percentage, an unknown size never shows NaN.
  await useBackend({
    check: "return window.__makeUpdate('0.0.3');",
    install: 'onProgress(0.42); window.__u.gate = new Promise((r) => { window.__release = r; }); await window.__u.gate;',
  });
  await menu();
  await click('更新并重启');
  b = await bar();
  record('下载中显示百分比', b.text === '正在下载… 42%', JSON.stringify(b));

  // 8. Choosing the menu item again mid-download is ignored.
  await menu();
  record('下载中再次检查被忽略', (await counts()).checks === 1 && (await bar()).text === '正在下载… 42%');
  await cdp.eval(`window.__release()`);
  await sleep(300);

  await useBackend({
    check: "return window.__makeUpdate('0.0.3');",
    install: 'onProgress(undefined); window.__u.gate = new Promise((r) => { window.__release = r; }); await window.__u.gate;',
  });
  await menu();
  await click('更新并重启');
  b = await bar();
  record('大小未知时不显示百分比', b.text === '正在下载…', JSON.stringify(b));
  await cdp.eval(`window.__release()`);
  await sleep(300);

  // 9. A failed install retries the same install, not a fresh check.
  await useBackend({
    check: "return window.__makeUpdate('0.0.3');",
    install: "if (window.__u.installs === 1) throw new Error('签名校验失败');",
  });
  await menu();
  await click('更新并重启');
  b = await bar();
  record('安装失败时显示原因', b.text.includes('更新失败') && b.text.includes('签名校验失败'), JSON.stringify(b));
  await click('重试');
  await sleep(300);
  c = await counts();
  record('重试的是安装而非检查', c.checks === 1 && c.installs === 2 && c.relaunches === 1, JSON.stringify(c));



  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SHOT_PATH, Buffer.from(shot.data, 'base64'));

  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n        ${r.detail}`}`);
  }
  console.log(`\nscreenshot: ${SHOT_PATH}`);

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${results.length} updater assertions failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS: all ${results.length} updater assertions held.`);
  }

  cdp.close();
} finally {
  edge.kill('SIGTERM');
}
