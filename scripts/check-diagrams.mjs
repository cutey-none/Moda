#!/usr/bin/env node
/**
 * Assert that ```mermaid blocks render as diagrams, and survive a save.
 *
 * Checks the rendered SVG for the diagram's own labels rather than just for an
 * <svg>: the code block's icons are SVGs too, so "an svg exists" proves nothing.
 *
 * Usage: node scripts/check-diagrams.mjs [url] [screenshot.png]
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_TO_LOAD = process.argv[2] ?? 'http://localhost:1420/';
const SHOT_PATH = process.argv[3] ?? '/tmp/moda-diagrams.png';
const PORT = 9269;
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

const FLOWCHART = `flowchart LR
  写作 --> 保存
  保存 --> 发布`;

const SEQUENCE = `sequenceDiagram
  Alice->>Bob: 你好`;

/** A state diagram: the one type whose own default layout is ELK. */
const STATE = `stateDiagram-v2
  [*] --> 草稿
  草稿 --> 已发布`;

const DOCUMENT = `# 图表

\`\`\`mermaid
${FLOWCHART}
\`\`\`

\`\`\`mermaid
${SEQUENCE}
\`\`\`

\`\`\`mermaid
${STATE}
\`\`\`

\`\`\`js
const notADiagram = true;
\`\`\`
`;

const edge = spawn(
  EDGE,
  [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--user-data-dir=/tmp/moda-edge-diagrams',
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

const readPreviews = `[...document.querySelectorAll('.milkdown-code-block')].map((block) => {
  const preview = block.querySelector('.preview');
  return {
    svg: preview?.querySelector('svg') !== null && preview?.querySelector('svg') !== undefined,
    text: preview?.textContent ?? null,
    error: preview?.querySelector('.diagram-error')?.textContent ?? null,
  };
})`;

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
  await sleep(4000);

  const previews = await cdp.eval(readPreviews);
  record('有四个代码块', previews.length === 4, JSON.stringify(previews));
  record(
    '流程图渲染成 SVG，含节点文字',
    previews[0]?.svg && ['写作', '保存', '发布'].every((t) => previews[0].text.includes(t)),
    JSON.stringify(previews[0]),
  );
  record(
    '时序图渲染成 SVG，含消息文字',
    previews[1]?.svg && previews[1].text.includes('你好'),
    JSON.stringify(previews[1]),
  );
  record(
    '状态图不依赖 ELK 也能渲染',
    previews[2]?.svg && previews[2].text.includes('已发布') && previews[2].error === null,
    JSON.stringify(previews[2]),
  );
  record('普通代码块没有预览', previews[3]?.text === null, JSON.stringify(previews[3]));

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SHOT_PATH, Buffer.from(shot.data, 'base64'));

  const markdown = await cdp.eval(`window.moda.markdownEditor.getMarkdown()`);
  record(
    '保存出的 markdown 仍是 mermaid 源码',
    markdown.includes('```mermaid') && markdown.includes('写作 --> 保存') && !markdown.includes('<svg'),
    markdown,
  );

  await cdp.eval(`window.moda.markdownEditor.setMarkdown('\`\`\`mermaid\\nflowchart LR\\n  A -->\\n\`\`\`\\n')`);
  await sleep(2500);
  const broken = await cdp.eval(readPreviews);
  record(
    '语法错误时显示错误而不是空白',
    broken[0]?.error?.includes('图表无法渲染') === true,
    JSON.stringify(broken),
  );
  const strays = await cdp.eval(`document.querySelectorAll('body > [id^="dmoda-mermaid"], body > [id^="moda-mermaid"]').length`);
  record('渲染失败不在页面上留下残骸', strays === 0, String(strays));

  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n        ${r.detail}`}`);
  }
  console.log(`\nscreenshot: ${SHOT_PATH}`);

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${results.length} diagram assertions failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS: all ${results.length} diagram assertions held.`);
  }

  cdp.close();
} finally {
  edge.kill('SIGTERM');
}
