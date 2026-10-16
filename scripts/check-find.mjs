#!/usr/bin/env node
/**
 * Assert that ⌘F finds text, in both the rendered document and the source.
 *
 * The count alone would pass a bar that searched but never showed anything, so
 * the checks also read back the highlights painted into the editor and the
 * selection that marks the current match.
 *
 * Usage: node scripts/check-find.mjs [url] [screenshot.png]
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_TO_LOAD = process.argv[2] ?? 'http://localhost:1420/';
const SHOT_PATH = process.argv[3] ?? '/tmp/moda-find.png';
const PORT = 9268;
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

/** "Moda" three times: once plain, once half bold, once in another case. */
const DOCUMENT = `# Moda 笔记

Moda 是一个编辑器。

**Mo**da 的名字里有加粗。

MODA 大写也算。
`;

const edge = spawn(
  EDGE,
  [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--user-data-dir=/tmp/moda-edge-find',
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

/** Press a key with modifiers, through the window listener the app installs. */
const press = (key, mods = {}) =>
  `window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, ...${JSON.stringify(mods)} }))`;

/** Type into the find field the way a user does, firing `input`. */
const type = (text) => `(() => {
  const input = document.querySelector('.findbar__input');
  input.value = ${JSON.stringify(text)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`;

const enter = (shiftKey = false) => `document.querySelector('.findbar__input').dispatchEvent(
  new KeyboardEvent('keydown', { key: 'Enter', shiftKey: ${shiftKey}, bubbles: true, cancelable: true }))`;

const readBar = `(() => ({
  hidden: document.getElementById('findbar').hidden,
  focused: document.activeElement === document.querySelector('.findbar__input'),
  count: document.querySelector('.findbar__count').textContent,
  highlights: document.querySelectorAll('.ProseMirror .find-match').length,
  current: document.querySelector('.ProseMirror .find-match--current')?.textContent ?? null,
  selected: window.moda.markdownEditor.inspect((ctx) => {
    const { from, to } = ctx.get('editorView').state.selection;
    return ctx.get('editorView').state.doc.textBetween(from, to);
  }),
}))()`;

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

  await cdp.eval(`window.moda.markdownEditor.setMarkdown(${JSON.stringify(DOCUMENT)})`);
  await sleep(600);

  await cdp.eval(press('f', { metaKey: true }));
  await sleep(200);
  const opened = await cdp.eval(readBar);
  record('⌘F 打开查找栏并聚焦输入框', !opened.hidden && opened.focused, JSON.stringify(opened));

  await cdp.eval(type('moda'));
  await sleep(200);
  const found = await cdp.eval(readBar);
  record('不区分大小写，跨加粗也能匹配', found.count === '1/4', JSON.stringify(found));
  record('匹配处被高亮', found.highlights >= 4, JSON.stringify(found));
  record('第一个匹配被选中', found.selected === 'Moda', JSON.stringify(found));
  record('输入框仍保有焦点', found.focused, JSON.stringify(found));

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SHOT_PATH, Buffer.from(shot.data, 'base64'));

  await cdp.eval(enter());
  await cdp.eval(enter());
  const stepped = await cdp.eval(readBar);
  record('回车跳到下一个', stepped.count === '3/4', JSON.stringify(stepped));
  record('跨加粗的匹配整体选中', stepped.selected === 'Moda', JSON.stringify(stepped));

  await cdp.eval(enter(true));
  await cdp.eval(enter(true));
  await cdp.eval(enter(true));
  const wrapped = await cdp.eval(readBar);
  record('⇧回车向前并在开头回绕', wrapped.count === '4/4', JSON.stringify(wrapped));
  record('回绕后选中最后一个', wrapped.selected === 'MODA', JSON.stringify(wrapped));

  await cdp.eval(type('不存在的词'));
  await sleep(100);
  const missing = await cdp.eval(readBar);
  record('无匹配时提示', missing.count === '无结果' && missing.highlights === 0, JSON.stringify(missing));

  await cdp.eval(type('编辑器'));
  await cdp.eval(`document.querySelector('.findbar__input').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await sleep(200);
  const closed = await cdp.eval(readBar);
  record(
    'Esc 关闭并清除高亮，选区留在匹配上',
    closed.hidden && closed.highlights === 0 && closed.selected === '编辑器',
    JSON.stringify(closed),
  );

  await cdp.eval(press('f', { ctrlKey: true }));
  await sleep(200);
  const ctrl = await cdp.eval(readBar);
  record('⌃F 也能打开，且保留上次的词', !ctrl.hidden && ctrl.count === '1/1', JSON.stringify(ctrl));

  // Source mode: the same bar, now selecting inside the textarea. The markup is
  // visible here, so the half-bold \`**Mo**da\` is no longer a match.
  await cdp.eval(`window.moda.toggleMode()`);
  await sleep(400);
  // Switching modes hands the keyboard to the surface; ⌘F takes it back.
  await cdp.eval(press('f', { metaKey: true }));
  await cdp.eval(type('moda'));
  await cdp.eval(enter());
  const source = await cdp.eval(`(() => {
    const area = document.getElementById('source');
    return {
      count: document.querySelector('.findbar__count').textContent,
      selected: area.value.slice(area.selectionStart, area.selectionEnd),
      focused: document.activeElement === document.querySelector('.findbar__input'),
    };
  })()`);
  record(
    '源码模式下查找并选中',
    source.count === '2/3' && source.selected.toLowerCase() === 'moda' && source.focused,
    JSON.stringify(source),
  );

  // ⇧⌘F stays "open folder", not find.
  await cdp.eval(`document.querySelector('.findbar__close').click()`);
  await cdp.eval(press('f', { metaKey: true, shiftKey: true }));
  await sleep(200);
  const folder = await cdp.eval(`document.getElementById('findbar').hidden`);
  record('⇧⌘F 不打开查找栏', folder === true, String(folder));

  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n        ${r.detail}`}`);
  }
  console.log(`\nscreenshot: ${SHOT_PATH}`);

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${results.length} find assertions failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS: all ${results.length} find assertions held.`);
  }

  cdp.close();
} finally {
  edge.kill('SIGTERM');
}
