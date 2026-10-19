#!/usr/bin/env node
/**
 * Assert that every markdown construct the app promises to render, renders.
 *
 * The other checks cover caret, typing, scrolling and shortcuts. This one covers
 * the *content* pipeline: a document is loaded through the app's own parser and
 * the resulting DOM is inspected for the element each construct must produce.
 * Asserting on the DOM rather than on a screenshot means a construct that
 * silently round-trips as plain text is caught.
 *
 * Usage: node scripts/check-rendering.mjs [url] [screenshot.png]
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_TO_LOAD = process.argv[2] ?? 'http://localhost:1420/';
const SHOT_PATH = process.argv[3] ?? '/tmp/moda-rendering.png';
const PORT = 9241;
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

const edge = spawn(
  EDGE,
  [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--user-data-dir=/tmp/moda-edge-render',
    '--window-size=1280,1400',
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

/** A document exercising every construct in the first-phase scope. */
const DOCUMENT = `# 一级标题

正文包含 **粗体**、*斜体*、~~删除线~~ 和 \`行内代码\`。

## 二级标题

> 引用块内容

- 无序项 A
- 无序项 B

1. 有序项一
2. 有序项二

- [ ] 未完成任务
- [x] 已完成任务

[链接文本](https://example.com/target)

![图片说明](https://example.com/pic.png)

| 列一 | 列二 |
| --- | --- |
| 单元格 | 值 |
| 长路径 | \`/Users/someone/projects/moda/node_modules/.pnpm/@milkdown+components@7.22.2/node_modules\` |

\`\`\`js
const x = 1;
\`\`\`

---

行内公式 $a^2 + b^2 = c^2$ 与块级公式：

$$
\\int_0^1 x\\,dx
$$
`;

/**
 * Each entry names a construct and the probe that must hold for it in the
 * rendered DOM.
 */
const EXPECTATIONS = [
  ['一级标题 h1', `!!editor.querySelector('h1')`],
  ['二级标题 h2', `!!editor.querySelector('h2')`],
  ['粗体 strong', `!!editor.querySelector('strong')`],
  ['斜体 em', `!!editor.querySelector('em')`],
  ['删除线 s/del', `!!editor.querySelector('s, del')`],
  ['行内代码 code', `!!editor.querySelector('code')`],
  ['引用块 blockquote', `!!editor.querySelector('blockquote')`],
  ['无序列表 ul>li', `!!editor.querySelector('ul li')`],
  ['有序列表 ol>li', `!!editor.querySelector('ol li')`],
  [
    '任务列表图标',
    // Crepe renders the checkbox as an SVG label, not an <input>.
    `!!editor.querySelector('.milkdown-icon.label.checked, .milkdown-icon.label.unchecked')`,
  ],
  ['链接 a[href]', `!!editor.querySelector('a[href]')`],
  ['图片 img[src]', `!!editor.querySelector('img[src]')`],
  ['表格 table', `!!editor.querySelector('table')`],
  ['表格单元格 td/th', `!!editor.querySelector('td, th')`],
  [
    '代码块 CodeMirror',
    // A fenced block renders a light placeholder first and is then replaced by a
    // CodeMirror instance, asynchronously. Asserting on the mounted editor (with
    // its text) is both deterministic and evidence of syntax highlighting, which
    // the bare placeholder is not.
    `(() => {
      const cm = editor.querySelector('.cm-editor');
      if (cm) return cm.textContent.includes('const x = 1');
      // Fall back to the placeholder shape if CodeMirror has not mounted yet.
      const code = [...editor.querySelectorAll('pre code')]
        .find((el) => el.textContent.includes('const x = 1'));
      return Boolean(code);
    })()`,
  ],
  ['分隔线 hr', `!!editor.querySelector('hr')`],
  [
    '数学公式 KaTeX',
    `!!editor.querySelector('.katex, [data-type="math"], mjx-container')`,
  ],
];

/**
 * Extra assertions about the *content* of what was produced, not just that an
 * element exists. These are the ones that catch silent data loss.
 */
const CONTENT_EXPECTATIONS = [
  [
    '图片 alt 未被改写',
    // ProseMirror inserts separator <img> elements with an empty alt; the real
    // image is the one carrying a src.
    `(() => {
      const img = [...editor.querySelectorAll('img[src]')]
        .find((candidate) => !candidate.classList.contains('ProseMirror-separator'));
      return Boolean(img) && img.getAttribute('alt') === '图片说明';
    })()`,
  ],
  [
    '表格中的长行内代码不溢出单元格',
    // A run with no spaces used to stay on one line as an inline block and run
    // across the neighbouring column.
    `(() => {
      const code = [...editor.querySelectorAll('td code')]
        .find((candidate) => candidate.textContent.includes('node_modules'));
      if (!code) return false;
      return code.getBoundingClientRect().right <= code.closest('td').getBoundingClientRect().right;
    })()`,
  ],
];

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
  await sleep(7000);

  const loaded = await cdp.eval(`(() => {
    if (!window.moda || !window.moda.markdownEditor) return { error: 'app not ready' };
    window.moda.markdownEditor.setMarkdown(${JSON.stringify(DOCUMENT)});
    return { ok: true };
  })()`);
  if (loaded.error) throw new Error(loaded.error);
  // Long enough for the asynchronous node views (CodeMirror, KaTeX, tables) to
  // finish mounting; asserting sooner races them.
  await sleep(2500);

  const results = [];
  for (const [name, probe] of [...EXPECTATIONS, ...CONTENT_EXPECTATIONS]) {
    const ok = await cdp.eval(`(() => {
      const editor = document.querySelector('.milkdown .ProseMirror');
      return Boolean(${probe});
    })()`);
    results.push({ name, ok });
  }

  // What survived a round trip back out to markdown? A construct that renders
  // but does not serialize would be lost on save.
  const roundTrip = await cdp.eval(
    `window.moda.markdownEditor.getMarkdown()`,
  );
  const roundTripChecks = [
    ['标题保留', /^#\s/m],
    ['粗体保留', /\*\*[^*]+\*\*/],
    ['删除线保留', /~~[^~]+~~/],
    ['任务列表保留', /[-*]\s\[[ x]\]/],
    ['链接保留', /\]\(https:\/\/example\.com\/target\)/],
    ['图片保留', /!\[[^\]]*\]\(https:\/\/example\.com\/pic\.png\)/],
    // The image-block feature rewrites alt to its size ratio; this is the
    // assertion that catches it coming back.
    ['图片 alt 保留', /!\[图片说明\]/],
    ['表格保留', /\|\s*---/],
    ['代码块保留', /```/],
    // A thematic break may serialize as `---`, `***`, or `___`; all are valid.
    ['分隔线保留', /^(?:-{3,}|\*{3,}|_{3,})$/m],
    ['公式保留', /\$[^$]+\$/],
  ];
  for (const [name, pattern] of roundTripChecks) {
    results.push({ name: `往返：${name}`, ok: pattern.test(roundTrip) });
  }

  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  });
  writeFileSync(SHOT_PATH, Buffer.from(shot.data, 'base64'));

  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  }
  console.log(`\nscreenshot: ${SHOT_PATH}`);

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${results.length} constructs did not render or round-trip.`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS: all ${results.length} constructs render and survive a round trip.`);
  }

  cdp.close();
} finally {
  edge.kill('SIGTERM');
}
