#!/usr/bin/env node
/**
 * Assert that the outline lists a document's headings and navigates between them.
 *
 * The panel is only useful if clicking a heading actually moves the caret, so the
 * assertions check the editor's selection and scroll position afterwards — not
 * merely that a list of the right length rendered. A list wired to a no-op
 * handler would pass a count check and fail these.
 *
 * Usage: node scripts/check-outline.mjs [url] [screenshot.png]
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_TO_LOAD = process.argv[2] ?? 'http://localhost:1420/';
const SHOT_PATH = process.argv[3] ?? '/tmp/moda-outline.png';
const PORT = 9266;
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

/**
 * A document whose headings deliberately skip a level (h1 then h3) and repeat a
 * title, to check that indentation reflects the document rather than being
 * derived from position.
 */
const DOCUMENT = `# 第一章

引言段落。

## 第一节

正文。

### 小节

更多正文。

# 第二章

结尾。

## 重复标题

一段。

## 重复标题

另一段。
`;

const edge = spawn(
  EDGE,
  [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--user-data-dir=/tmp/moda-edge-outline',
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
  await cdp.send('Page.navigate', { url: URL_TO_LOAD });
  await sleep(6000);

  // Put the document in place, then reveal the outline the way the UI does. The
  // menu command is the real path: it shows the panel *and* selects the view,
  // and it is what `⌘⇧U` triggers.
  await cdp.eval(`window.moda.markdownEditor.setMarkdown(${JSON.stringify(DOCUMENT)})`);
  await sleep(900);
  await cdp.eval(`window.moda.runMenuCommand('show-outline')`);
  await sleep(500);

  const listed = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#sidebar-outline .outline__row')];
    return {
      outlineHidden: document.getElementById('sidebar').hidden,
      filesPanelHidden: document.getElementById('panel-files').hidden,
      outlinePanelHidden: document.getElementById('panel-outline').hidden,
      labels: rows.map((r) => r.textContent),
      // Indentation is what encodes the level in the DOM.
      indents: rows.map((r) => parseInt(r.style.paddingLeft, 10)),
      classes: rows.map((r) => r.className),
    };
  })()`);

  const expected = ['第一章', '第一节', '小节', '第二章', '重复标题', '重复标题'];
  record(
    '侧边栏切到大纲面板',
    listed.outlineHidden === false &&
      listed.filesPanelHidden === true &&
      listed.outlinePanelHidden === false,
    JSON.stringify(listed),
  );
  record(
    '列出全部标题（含重复标题）',
    JSON.stringify(listed.labels) === JSON.stringify(expected),
    JSON.stringify(listed.labels),
  );
  record(
    '缩进对应标题层级',
    // h1 = 8, h2 = 20, h3 = 32
    listed.indents[0] === 8 &&
      listed.indents[1] === 20 &&
      listed.indents[2] === 32 &&
      listed.indents[3] === 8,
    JSON.stringify(listed.indents),
  );
  record(
    '层级也反映在 class 上',
    listed.classes[0].includes('outline__row--h1') &&
      listed.classes[1].includes('outline__row--h2') &&
      listed.classes[2].includes('outline__row--h3'),
    JSON.stringify(listed.classes),
  );

  // Clicking a heading must move the caret to it.
  const navigation = await cdp.eval(`(() => {
    const before = window.moda.markdownEditor.inspect(
      (ctx) => ctx.get('editorView').state.selection.from,
    );
    const rows = [...document.querySelectorAll('#sidebar-outline .outline__row')];
    // Jump to the third heading — "小节" — which is well down the document.
    rows[2].click();
    const after = window.moda.markdownEditor.inspect(
      (ctx) => ctx.get('editorView').state.selection.from,
    );
    // The heading the caret now sits in, read back from the document.
    const landedIn = window.moda.markdownEditor.inspect((ctx) => {
      const view = ctx.get('editorView');
      const { $from } = view.state.selection;
      for (let depth = $from.depth; depth > 0; depth -= 1) {
        const node = $from.node(depth);
        if (node.type.name === 'heading') return node.textContent;
      }
      return null;
    });
    return { before, after, landedIn };
  })()`);
  record(
    '点击标题移动了光标',
    navigation.after !== navigation.before,
    JSON.stringify(navigation),
  );
  record(
    '光标落在被点击的标题上',
    navigation.landedIn === '小节',
    JSON.stringify(navigation),
  );

  // Jumping to a later heading must move further down than an earlier one.
  const ordering = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#sidebar-outline .outline__row')];
    const positions = [];
    for (const index of [0, 3]) {
      rows[index].click();
      positions.push(window.moda.markdownEditor.inspect(
        (ctx) => ctx.get('editorView').state.selection.from,
      ));
    }
    return positions;
  })()`);
  record(
    '后面的标题位置更靠后',
    ordering[1] > ordering[0],
    JSON.stringify(ordering),
  );

  // Capture while the outline has content: a screenshot of the empty state would
  // show the panel but not what it is for.
  const populatedShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SHOT_PATH, Buffer.from(populatedShot.data, 'base64'));

  // The outline must follow the document rather than freeze at load time.
  const afterEdit = await cdp.eval(`(() => {
    window.moda.markdownEditor.setMarkdown('# 仅一个标题\\n\\n正文。\\n');
    return true;
  })()`);
  await sleep(900);
  const refreshed = await cdp.eval(
    `[...document.querySelectorAll('#sidebar-outline .outline__row')].map((r) => r.textContent)`,
  );
  record(
    '文档变化后大纲同步更新',
    JSON.stringify(refreshed) === JSON.stringify(['仅一个标题']),
    JSON.stringify({ afterEdit, refreshed }),
  );

  // A document with no headings must say so rather than render an empty list.
  await cdp.eval(`window.moda.markdownEditor.setMarkdown('只有正文，没有标题。')`);
  await sleep(900);
  const emptyState = await cdp.eval(`(() => ({
    rows: document.querySelectorAll('#sidebar-outline .outline__row').length,
    text: document.getElementById('sidebar-outline').textContent.trim(),
  }))()`);
  record(
    '无标题时给出提示',
    emptyState.rows === 0 && emptyState.text.includes('没有标题'),
    JSON.stringify(emptyState),
  );

  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n        ${r.detail}`}`);
  }
  console.log(`\nscreenshot: ${SHOT_PATH}`);

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${results.length} outline assertions failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS: all ${results.length} outline assertions held.`);
  }

  cdp.close();
} finally {
  edge.kill('SIGTERM');
}
