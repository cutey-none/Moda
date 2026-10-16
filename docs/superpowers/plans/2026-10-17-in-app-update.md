# 应用内更新 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户点 "Moda → 检查更新…" 就能在 app 内下载、安装最新正式版并重启。

**Architecture:** Tauri 官方 `tauri-plugin-updater`（下载、校验 minisign 签名、替换 .app）与
`tauri-plugin-process`（重启）。Rust 只注册插件和菜单项；流程和更新条在前端
`src/updater.ts`，经 `src/tauri.ts` 的 `UpdateBackend` 接口调用插件。发布 CI 额外产出按架构命名的
`.app.tar.gz` + `.sig`，并由 `scripts/make-update-manifest.mjs` 生成 `latest.json`。

**Tech Stack:** Tauri 2、TypeScript + Vite、Rust、GitHub Actions、Node 22（`node --test`）、
headless Edge + CDP 的浏览器检查。

**Spec:** `docs/superpowers/specs/2026-10-17-in-app-update-design.md`

## Global Constraints

- 只手动检查：除用户点"检查更新…"外，任何时刻都不调用 `check()` 或联网。
- 更新地址：`https://github.com/cutey-none/Moda/releases/latest/download/latest.json`。
- 更新包资产名：`Moda_aarch64.app.tar.gz`、`Moda_x64.app.tar.gz`，签名为同名加 `.sig`。
- `latest.json` 平台键：`darwin-aarch64`、`darwin-x86_64`；`notes` 为 `""`。
- 菜单 id 与命令名：`check-for-updates`；菜单文字：`检查更新…`。
- UI 文案为简体中文，与现有界面一致。
- 私钥只存在于 `~/.tauri/moda-updater.key` 与 GitHub Secrets，**绝不提交**。
- 不改 DMG、ad-hoc 签名（`bundle.macOS.signingIdentity: "-"`）和 `check-macos-bundle.sh`。
- `bundle.createUpdaterArtifacts` **不写进** `tauri.conf.json`，只由 CI 用 `--config` 打开。
  原因：开着它而没有 `TAURI_SIGNING_PRIVATE_KEY` 时 `tauri build` 会报错，会让没有私钥的本地
  `pnpm tauri build` 失败。（与 spec 的唯一偏差，效果相同：发布版都带更新包。）
- 本机 `~/.cargo/config.toml` 指向已失效的 USTC 镜像。任何需要拉新 crate 的 cargo 命令，都按
  README "Troubleshooting" 的办法临时移开它：
  `mv ~/.cargo/config.toml ~/.cargo/config.toml.disabled && trap 'mv ~/.cargo/config.toml.disabled ~/.cargo/config.toml' EXIT; <命令>`
  （整段放在同一个 shell 调用里，保证 trap 会还原文件）。
- 全局 pnpm 是 7.x，读不了 lockfile；一律用 `corepack pnpm ...`。
- 浏览器检查需要 `corepack pnpm dev` 在 `http://localhost:1420/` 运行。
- 每个任务按小步提交；commit message 简单清晰，末尾附
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

## Review Focus

1. **下载期间用户继续编辑。** 下载前确认时文档是干净的，下载中用户打了字；重启会丢掉这些内容。
   期望：重启前再确认一次，用户取消时显示"已安装，重启后生效"，不重启。（Task 3 测试 `ready` 状态）
2. **检查/下载进行中再次点菜单。** 期望：忽略，不会并发两次 `check()` 或两次下载。（Task 3 测试）
3. **下载不知道总大小**（`Started` 没有 `contentLength`）。期望：显示"正在下载…"，不出现
   `NaN%` 或 `Infinity%`。（Task 3 测试）
4. **签名校验失败 / 下载中断后重试。** 期望：重试的是"安装同一个更新"，不是重新检查；当前 app
   仍可用。（Task 3 测试 failed→retry 再次调用 install）
5. **重启时触发关闭守卫导致二次确认或卡住。** `relaunch()` 走的是进程退出，不应弹"确定要退出吗"。
   浏览器检查无法覆盖，在 Task 5 的本地端到端里用一个未保存文档实测。

---

### Task 1: `latest.json` 生成脚本

**Files:**
- Create: `scripts/make-update-manifest.mjs`
- Create: `scripts/make-update-manifest.test.mjs`
- Modify: `package.json`（scripts 增加 `test:scripts`）

**Interfaces:**
- Produces:
  - `makeManifest({ version: string, signatures: { aarch64: string, x64: string }, baseUrl: string, pubDate: string }) => object`
  - CLI：`node scripts/make-update-manifest.mjs --version <x.y.z> --dir <资产目录> --base-url <下载前缀> --out <文件>`；
    从 `<dir>/Moda_aarch64.app.tar.gz.sig`、`<dir>/Moda_x64.app.tar.gz.sig` 读签名；缺任一则退出码 1。
  - `pnpm test:scripts` 运行 `scripts/*.test.mjs`。

- [ ] **Step 1: Write the failing test**

`scripts/make-update-manifest.test.mjs`:

```js
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeManifest } from './make-update-manifest.mjs';

const SCRIPT = fileURLToPath(new URL('./make-update-manifest.mjs', import.meta.url));
const BASE = 'https://github.com/cutey-none/Moda/releases/download/v0.0.3';

test('lists both macOS architectures with their own signature and asset', () => {
  const manifest = makeManifest({
    version: '0.0.3',
    signatures: { aarch64: 'SIG-ARM', x64: 'SIG-INTEL' },
    baseUrl: BASE,
    pubDate: '2026-10-17T00:00:00Z',
  });
  assert.deepEqual(manifest, {
    version: '0.0.3',
    notes: '',
    pub_date: '2026-10-17T00:00:00Z',
    platforms: {
      'darwin-aarch64': { signature: 'SIG-ARM', url: `${BASE}/Moda_aarch64.app.tar.gz` },
      'darwin-x86_64': { signature: 'SIG-INTEL', url: `${BASE}/Moda_x64.app.tar.gz` },
    },
  });
});

test('a trailing slash on the base URL does not double up', () => {
  const manifest = makeManifest({
    version: '0.0.3',
    signatures: { aarch64: 'a', x64: 'b' },
    baseUrl: `${BASE}/`,
    pubDate: '2026-10-17T00:00:00Z',
  });
  assert.equal(manifest.platforms['darwin-aarch64'].url, `${BASE}/Moda_aarch64.app.tar.gz`);
});

test('the CLI writes the manifest from the .sig files, trimming whitespace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moda-manifest-'));
  writeFileSync(join(dir, 'Moda_aarch64.app.tar.gz.sig'), 'SIG-ARM\n');
  writeFileSync(join(dir, 'Moda_x64.app.tar.gz.sig'), 'SIG-INTEL\n');
  const out = join(dir, 'latest.json');
  execFileSync('node', [SCRIPT, '--version', '0.0.3', '--dir', dir, '--base-url', BASE, '--out', out]);
  const manifest = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(manifest.version, '0.0.3');
  assert.equal(manifest.platforms['darwin-aarch64'].signature, 'SIG-ARM');
  assert.equal(manifest.platforms['darwin-x86_64'].signature, 'SIG-INTEL');
  assert.ok(!Number.isNaN(Date.parse(manifest.pub_date)));
});

test('the CLI fails when a signature is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moda-manifest-'));
  writeFileSync(join(dir, 'Moda_aarch64.app.tar.gz.sig'), 'SIG-ARM\n');
  assert.throws(
    () =>
      execFileSync(
        'node',
        [SCRIPT, '--version', '0.0.3', '--dir', dir, '--base-url', BASE, '--out', join(dir, 'latest.json')],
        { stdio: 'pipe' },
      ),
    /Moda_x64\.app\.tar\.gz\.sig/,
  );
});
```

Add to `package.json` `scripts`, after `"typecheck"`:

```json
    "test:scripts": "node --test scripts/*.test.mjs",
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm test:scripts`
Expected: FAIL — `Cannot find module '.../scripts/make-update-manifest.mjs'`.

- [ ] **Step 3: Write minimal implementation**

`scripts/make-update-manifest.mjs`:

```js
#!/usr/bin/env node
/**
 * Write the `latest.json` an installed Moda reads to learn about a new release.
 *
 * Tauri's updater fetches this file from the endpoint in `tauri.conf.json`,
 * compares `version` with its own, and — if it is newer — downloads the
 * `url` for its platform and refuses it unless it verifies against `signature`.
 * The release workflow runs this once both architectures are built, so one
 * manifest describes the whole release.
 *
 * Usage:
 *   node scripts/make-update-manifest.mjs --version 0.0.3 --dir dist \
 *     --base-url https://github.com/<owner>/<repo>/releases/download/v0.0.3 \
 *     --out dist/latest.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** Tauri's platform key for each architecture the release builds. */
const PLATFORMS = {
  aarch64: 'darwin-aarch64',
  x64: 'darwin-x86_64',
};

/** The update package's file name for one architecture. */
export function assetName(arch) {
  return `Moda_${arch}.app.tar.gz`;
}

/**
 * Build the manifest.
 *
 * @param {{ version: string, signatures: Record<'aarch64' | 'x64', string>,
 *           baseUrl: string, pubDate: string }} options
 */
export function makeManifest({ version, signatures, baseUrl, pubDate }) {
  const base = baseUrl.replace(/\/+$/, '');
  const platforms = {};
  for (const [arch, key] of Object.entries(PLATFORMS)) {
    platforms[key] = { signature: signatures[arch], url: `${base}/${assetName(arch)}` };
  }
  return { version, notes: '', pub_date: pubDate, platforms };
}

function main() {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      dir: { type: 'string' },
      'base-url': { type: 'string' },
      out: { type: 'string' },
    },
  });
  for (const name of ['version', 'dir', 'base-url', 'out']) {
    if (values[name] === undefined) throw new Error(`missing --${name}`);
  }

  const signatures = {};
  for (const arch of Object.keys(PLATFORMS)) {
    const file = join(values.dir, `${assetName(arch)}.sig`);
    try {
      signatures[arch] = readFileSync(file, 'utf8').trim();
    } catch {
      throw new Error(`missing signature ${file}; was the update package built and signed?`);
    }
  }

  const manifest = makeManifest({
    version: values.version,
    signatures,
    baseUrl: values['base-url'],
    pubDate: new Date().toISOString(),
  });
  writeFileSync(values.out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${values.out} for ${values.version}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm test:scripts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/make-update-manifest.mjs scripts/make-update-manifest.test.mjs package.json
git commit -m "Add a script that writes the update manifest"
```

---

### Task 2: Updater keys, Rust plugins, and the menu item

**Files:**
- Modify: `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`
- Modify: `src-tauri/src/lib.rs:65-67`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/src/menu.rs`

**Interfaces:**
- Produces:
  - Rust `MenuCommand::CheckForUpdates`, serialized `"check-for-updates"`, menu id `check-for-updates`,
    emitted on `moda://menu` like the other commands.
  - Plugins `updater` and `process` available to the webview with permissions
    `updater:default`, `process:allow-restart`.
  - `~/.tauri/moda-updater.key`, `~/.tauri/moda-updater.key.pub`, `~/.tauri/moda-updater.key.password`
    (local only).

- [ ] **Step 1: Generate the update signing key pair**

```bash
mkdir -p ~/.tauri && chmod 700 ~/.tauri
openssl rand -base64 24 > ~/.tauri/moda-updater.key.password
chmod 600 ~/.tauri/moda-updater.key.password
corepack pnpm tauri signer generate --ci \
  -w ~/.tauri/moda-updater.key \
  -p "$(cat ~/.tauri/moda-updater.key.password)"
chmod 600 ~/.tauri/moda-updater.key
cat ~/.tauri/moda-updater.key.pub
```

Expected: the last command prints one base64 line (the public key). If `~/.tauri/moda-updater.key`
already exists, **stop and ask** — overwriting it would orphan any build signed with the old key.

- [ ] **Step 2: Write the failing Rust tests**

In `src-tauri/src/menu.rs` tests:

- in `commands_serialize_to_the_names_the_frontend_switches_on`, add to `cases`:

```rust
            (MenuCommand::CheckForUpdates, "check-for-updates"),
```

- add a new test:

```rust
    #[test]
    fn check_for_updates_has_its_own_id() {
        // It lives in the app menu rather than in COMMANDS' document menus, so
        // it is mapped separately — and must still be found.
        assert_eq!(
            command_for_id("check-for-updates"),
            Some(MenuCommand::CheckForUpdates)
        );
    }
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml menu`
Expected: compile error — `no variant named CheckForUpdates`.

- [ ] **Step 4: Implement the menu item**

In `src-tauri/src/menu.rs`:

- add `CheckForUpdates,` to `enum MenuCommand` right after `About,`.
- in `command_for_id`, after the `about-moda` branch:

```rust
    if id == "check-for-updates" {
        return Some(MenuCommand::CheckForUpdates);
    }
```

- in `build`, the app menu becomes:

```rust
    // "检查更新…" sits under About, where a Mac user looks for it. It is the only
    // way Moda ever contacts the update server: there is no check on launch.
    let check_for_updates =
        MenuItemBuilder::with_id("check-for-updates", "检查更新…").build(app)?;

    let app_menu = SubmenuBuilder::new(app, "Moda")
        .about(Some(AboutMetadata {
            name: Some("Moda".to_string()),
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
            comments: Some("所见即所得的 Markdown 编辑器".to_string()),
            ..Default::default()
        }))
        .item(&check_for_updates)
        .separator()
        .services()
```

(the rest of the chain is unchanged).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml menu`
Expected: PASS (5 menu tests).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/menu.rs
git commit -m "Add a Check for Updates item to the app menu"
```

- [ ] **Step 7: Add the plugins**

`src-tauri/Cargo.toml`, in `[dependencies]` after `tauri-plugin-dialog = "2"`:

```toml
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
```

`src-tauri/src/lib.rs`, in `run()`, extend the plugin chain:

```rust
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // In-app updates. Both are driven from the webview, and only when the user
        // chooses "检查更新…": the updater downloads and verifies the new bundle,
        // the process plugin restarts into it.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
```

`src-tauri/tauri.conf.json`, add a top-level `"plugins"` key after `"app"` (paste the public key from Step 1
as the `pubkey` value, on one line):

```json
  "plugins": {
    "updater": {
      "pubkey": "<contents of ~/.tauri/moda-updater.key.pub>",
      "endpoints": [
        "https://github.com/cutey-none/Moda/releases/latest/download/latest.json"
      ]
    }
  },
```

`src-tauri/capabilities/default.json`, append to `permissions`:

```json
    "dialog:default",
    "updater:default",
    "process:allow-restart"
```

- [ ] **Step 8: Build and test with the new crates**

Run (one shell call):

```bash
mv ~/.cargo/config.toml ~/.cargo/config.toml.disabled && trap 'mv ~/.cargo/config.toml.disabled ~/.cargo/config.toml' EXIT
cd /Users/cutey/code/moda && corepack pnpm build && cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all Rust tests pass (the previous count plus 1), and `ls ~/.cargo/config.toml` still succeeds afterwards.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/tauri.conf.json src-tauri/capabilities/default.json
git commit -m "Register the updater and process plugins"
```

---

### Task 3: The update flow and its bar

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml` (frontend plugin packages)
- Modify: `src/tauri.ts` (types, backend, `MenuCommand`)
- Create: `src/updater.ts`
- Modify: `src/app.ts` (construct `UpdateFlow`, dispatch the command, expose it)
- Modify: `index.html` (bar markup), `src/styles.css` (bar style)
- Create: `scripts/check-updater.mjs`; Modify: `package.json` (`check:updater`)

**Interfaces:**
- Consumes: menu command `'check-for-updates'` (Task 2); plugins `updater`, `process` (Task 2).
- Produces (in `src/tauri.ts`):

```ts
export interface AvailableUpdate {
  version: string;
  /** Release notes; empty when the release has none. */
  notes: string;
  /** Download, verify and install. `fraction` is 0–1, or undefined when the size is unknown. */
  install(onProgress: (fraction: number | undefined) => void): Promise<void>;
}
export interface UpdateBackend {
  currentVersion(): Promise<string>;
  check(): Promise<AvailableUpdate | null>;
  relaunch(): Promise<void>;
}
export const tauriUpdateBackend: UpdateBackend;
```

- Produces (in `src/updater.ts`):

```ts
export type UpdateState =
  | { kind: 'hidden' }
  | { kind: 'checking' }
  | { kind: 'latest'; version: string }
  | { kind: 'available'; update: AvailableUpdate }
  | { kind: 'downloading'; fraction: number | undefined }
  | { kind: 'ready'; update: AvailableUpdate }
  | { kind: 'failed'; message: string; retry: () => void };
export class UpdateFlow {
  constructor(root: HTMLElement, options: { backend: UpdateBackend | undefined; confirmDiscard: () => Promise<boolean> });
  get state(): UpdateState;
  checkForUpdates(): Promise<void>;
  useBackend(backend: UpdateBackend): void; // seam for scripts/check-updater.mjs
}
```

- Produces (in `src/app.ts`): `ModaApp.updates: UpdateFlow` (getter), and `runMenuCommand('check-for-updates')`.

- [ ] **Step 1: Install the frontend plugin packages**

```bash
corepack pnpm add @tauri-apps/plugin-updater@^2 @tauri-apps/plugin-process@^2
```

Expected: both appear under `dependencies` in `package.json`.

- [ ] **Step 2: Add the bridge in `src/tauri.ts`**

Add `'check-for-updates'` to the `MenuCommand` union (after `'about'`).

Append to the end of `src/tauri.ts`:

```ts
/** A newer release the updater found. */
export interface AvailableUpdate {
  version: string;
  /** Release notes; empty when the release has none. */
  notes: string;
  /**
   * Download, verify and install the update over the running app.
   *
   * @param onProgress - called as bytes arrive, with the fraction done (0–1), or
   *   undefined when the server did not say how big the download is.
   */
  install(onProgress: (fraction: number | undefined) => void): Promise<void>;
}

/** What the update flow needs from the host. */
export interface UpdateBackend {
  /** The running app's version, e.g. "0.0.3". */
  currentVersion(): Promise<string>;
  /** Ask the update server; null when this is already the newest release. */
  check(): Promise<AvailableUpdate | null>;
  /** Restart into the installed update. */
  relaunch(): Promise<void>;
}

/**
 * The real backend: Tauri's updater and process plugins.
 *
 * Imported lazily, like the event API above, so a plain browser session never
 * loads them.
 */
export const tauriUpdateBackend: UpdateBackend = {
  async currentVersion() {
    const { getVersion } = await import('@tauri-apps/api/app');
    return getVersion();
  },
  async check() {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (update === null) return null;
    return {
      version: update.version,
      notes: update.body ?? '',
      async install(onProgress) {
        let total: number | undefined;
        let received = 0;
        await update.downloadAndInstall((event) => {
          if (event.event === 'Started') {
            total = event.data.contentLength;
            onProgress(total ? 0 : undefined);
          } else if (event.event === 'Progress') {
            received += event.data.chunkLength;
            onProgress(total ? Math.min(received / total, 1) : undefined);
          }
        });
      },
    };
  },
  async relaunch() {
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  },
};
```

Run: `corepack pnpm typecheck`
Expected: FAIL only in `src/app.ts` — `runMenuCommand`'s switch is not exhaustive / `'check-for-updates'` not handled
(if the project's tsconfig doesn't flag non-exhaustive switches, it passes; either is fine at this point).

- [ ] **Step 3: Write the failing browser check**

Create `scripts/check-updater.mjs`. Copy these parts of `scripts/check-menu.mjs` verbatim: the `import`
lines, the `EDGE` constant, the `spawn(EDGE, …)` launcher (change `--user-data-dir` to `/tmp/moda-edge-updater`),
`class Cdp`, `waitForEndpoint`, `results`/`record`, the target-creation block, and the result printing /
exit-code block at the end (change the word "menu" to "updater" in its messages). Use:

```js
const URL_TO_LOAD = process.argv[2] ?? 'http://localhost:1420/';
const SHOT_PATH = process.argv[3] ?? '/tmp/moda-updater-check.png';
const PORT = 9268;
```

The file header:

```js
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
```

The IPC stub (installed with `Page.addScriptToEvaluateOnNewDocument` before navigating). The dialog
answer is scriptable so the unsaved-changes prompt can be accepted or refused:

```js
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__modaTest = { askAnswer: true, asks: 0 };
      window.__TAURI_INTERNALS__ = {
        invoke: async (cmd) => {
          if (cmd.startsWith('plugin:dialog|')) {
            window.__modaTest.asks += 1;
            return window.__modaTest.askAnswer;
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
```

The scripted backend and helpers, then the scenarios:

```js
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

  // 6. Edits made during the download: confirmed before, refused after.
  //    The update is installed but the app must not restart.
  await cdp.eval(`window.__modaTest.askAnswer = true; window.__modaTest.asks = 0`);
  await useBackend({
    check: "return window.__makeUpdate('0.0.3');",
    install: "onProgress(0.5); window.__modaTest.askAnswer = false;",
  });
  await menu();
  await click('更新并重启');
  await sleep(300);
  b = await bar();
  c = await counts();
  record(
    '下载期间又有修改且取消：已安装但不重启',
    c.installs === 1 && c.relaunches === 0 && b.text === 'Moda 0.0.3 已安装，重启后生效' &&
      JSON.stringify(b.buttons) === JSON.stringify(['立即重启', '稍后']),
    JSON.stringify({ c, b }),
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
```

Add to `package.json` scripts after `"check:find"`:

```json
    "check:updater": "node scripts/check-updater.mjs",
```

Run (with `corepack pnpm dev` running): `corepack pnpm check:updater`
Expected: FAIL — `window.moda.updates` is undefined.

- [ ] **Step 4: Add the bar markup and style**

`index.html`, directly after the find bar's closing `</div>`:

```html
          <!-- The update bar. Only "检查更新…" in the app menu ever shows it. -->
          <div class="updatebar" id="updatebar" role="status" aria-live="polite" hidden>
            <div class="updatebar__body">
              <span class="updatebar__text"></span>
              <span class="updatebar__notes"></span>
            </div>
            <button class="btn btn--primary updatebar__primary"></button>
            <button class="btn updatebar__secondary"></button>
          </div>
```

`src/styles.css`, after the `.findbar .btn` rule:

```css
/* The update bar: the same raised glass as the find bar, centred over the
   bottom of the editing surface so it never covers the find field. */
.updatebar {
  position: absolute;
  left: 50%;
  bottom: 14px;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(560px, calc(100% - 32px));
  padding: 8px 8px 8px 16px;
  transform: translateX(-50%);
  border: 1px solid var(--chrome-border);
  border-radius: 14px;
  background: var(--glass-tint-raised);
  -webkit-backdrop-filter: var(--glass-filter);
  backdrop-filter: var(--glass-filter);
  box-shadow: var(--glass-shadow);
  font-size: 13px;
  color: var(--chrome-fg);
}

.updatebar[hidden],
.updatebar [hidden] {
  display: none;
}

.updatebar__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.updatebar__text {
  font-variant-numeric: tabular-nums;
}

.updatebar__notes {
  white-space: pre-line;
  font-size: 12px;
  color: var(--chrome-fg-dim);
}

.updatebar .btn {
  flex: none;
}
```

- [ ] **Step 5: Implement `src/updater.ts`**

```ts
/**
 * In-app updates: the "检查更新…" flow and the bar that reports it.
 *
 * Nothing here runs on its own. Moda never contacts the update server unless
 * the user asks, so the only way in is {@link UpdateFlow.checkForUpdates},
 * reached from the app menu. Every check ends in something visible — a newer
 * version, "already up to date", or the reason it failed.
 *
 * Installing replaces the app bundle on disk; the running app keeps going until
 * it restarts. Unsaved work is asked about twice: before downloading, and again
 * before restarting, because the user may have kept typing while it downloaded.
 */

import type { AvailableUpdate, UpdateBackend } from './tauri';

export type UpdateState =
  | { kind: 'hidden' }
  | { kind: 'checking' }
  | { kind: 'latest'; version: string }
  | { kind: 'available'; update: AvailableUpdate }
  | { kind: 'downloading'; fraction: number | undefined }
  | { kind: 'ready'; update: AvailableUpdate }
  | { kind: 'failed'; message: string; retry: () => void };

export interface UpdateFlowOptions {
  /** The host's updater, or undefined in a plain browser, where nothing happens. */
  backend: UpdateBackend | undefined;
  /** The app's own unsaved-changes prompt; true when it is safe to proceed. */
  confirmDiscard: () => Promise<boolean>;
}

/** How many lines of release notes the bar shows. */
const NOTES_LINES = 3;

/** A thrown value as something to show the user. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The update flow's behaviour, bound to its markup in `index.html`. */
export class UpdateFlow {
  private current: UpdateState = { kind: 'hidden' };
  private backend: UpdateBackend | undefined;
  private readonly text: HTMLElement;
  private readonly notes: HTMLElement;
  private readonly primary: HTMLButtonElement;
  private readonly secondary: HTMLButtonElement;
  private onPrimary: () => void = () => {};
  private onSecondary: () => void = () => {};

  constructor(
    private readonly root: HTMLElement,
    private readonly options: UpdateFlowOptions,
  ) {
    this.backend = options.backend;
    const part = <T extends HTMLElement>(selector: string): T => {
      const element = root.querySelector<T>(selector);
      if (element === null) throw new Error(`update bar is missing ${selector}`);
      return element;
    };
    this.text = part('.updatebar__text');
    this.notes = part('.updatebar__notes');
    this.primary = part<HTMLButtonElement>('.updatebar__primary');
    this.secondary = part<HTMLButtonElement>('.updatebar__secondary');
    this.primary.addEventListener('click', () => {
      this.onPrimary();
    });
    this.secondary.addEventListener('click', () => {
      this.onSecondary();
    });
  }

  get state(): UpdateState {
    return this.current;
  }

  /**
   * Replace the backend.
   *
   * The seam `scripts/check-updater.mjs` drives: the updater plugin cannot run
   * in a browser, so the check scripts the server's answers instead.
   */
  useBackend(backend: UpdateBackend): void {
    this.backend = backend;
    this.set({ kind: 'hidden' });
  }

  /**
   * Ask the update server whether there is a newer release.
   *
   * Ignored while a check or a download is already under way, so a second
   * click cannot start a second download.
   */
  async checkForUpdates(): Promise<void> {
    const backend = this.backend;
    if (backend === undefined) return;
    if (this.current.kind === 'checking' || this.current.kind === 'downloading') return;

    this.set({ kind: 'checking' });
    try {
      const update = await backend.check();
      if (update === null) {
        this.set({ kind: 'latest', version: await backend.currentVersion() });
      } else {
        this.set({ kind: 'available', update });
      }
    } catch (error) {
      this.set({
        kind: 'failed',
        message: `检查更新失败：${reason(error)}`,
        retry: () => void this.checkForUpdates(),
      });
    }
  }

  /** Download and install, then restart — each step only with the user's leave. */
  private async install(update: AvailableUpdate): Promise<void> {
    if (!(await this.options.confirmDiscard())) {
      this.set({ kind: 'available', update });
      return;
    }

    this.set({ kind: 'downloading', fraction: undefined });
    try {
      await update.install((fraction) => {
        this.set({ kind: 'downloading', fraction });
      });
    } catch (error) {
      this.set({
        kind: 'failed',
        message: `更新失败：${reason(error)}`,
        retry: () => void this.install(update),
      });
      return;
    }

    this.set({ kind: 'ready', update });
    await this.restart();
  }

  /**
   * Restart into the installed update.
   *
   * Asks about unsaved work again: anything typed during the download would
   * otherwise be lost. Refusing leaves the update installed for next launch.
   */
  private async restart(): Promise<void> {
    const backend = this.backend;
    if (backend === undefined) return;
    if (!(await this.options.confirmDiscard())) return;
    try {
      await backend.relaunch();
    } catch (error) {
      this.set({
        kind: 'failed',
        message: `重启失败：${reason(error)}。请手动重新打开 Moda`,
        retry: () => void this.restart(),
      });
    }
  }

  private set(state: UpdateState): void {
    this.current = state;
    this.render();
  }

  /** Show the current state: its text, notes, and up to two buttons. */
  private render(): void {
    const state = this.current;
    this.root.hidden = state.kind === 'hidden';

    let text = '';
    let notes = '';
    let primary: [string, () => void] | undefined;
    let secondary: [string, () => void] | undefined;
    const hide = (): void => {
      this.set({ kind: 'hidden' });
    };

    switch (state.kind) {
      case 'hidden':
        break;
      case 'checking':
        text = '正在检查更新…';
        break;
      case 'latest':
        text = `已是最新版本 ${state.version}`;
        primary = ['好', hide];
        break;
      case 'available':
        text = `Moda ${state.update.version} 可用`;
        notes = state.update.notes
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .slice(0, NOTES_LINES)
          .join('\n');
        primary = ['更新并重启', () => void this.install(state.update)];
        secondary = ['稍后', hide];
        break;
      case 'downloading':
        text =
          state.fraction === undefined
            ? '正在下载…'
            : `正在下载… ${Math.round(state.fraction * 100)}%`;
        break;
      case 'ready':
        text = `Moda ${state.update.version} 已安装，重启后生效`;
        primary = ['立即重启', () => void this.restart()];
        secondary = ['稍后', hide];
        break;
      case 'failed':
        text = state.message;
        primary = ['重试', state.retry];
        secondary = ['关闭', hide];
        break;
    }

    this.text.textContent = text;
    this.notes.textContent = notes;
    this.notes.hidden = notes.length === 0;
    this.primary.hidden = primary === undefined;
    this.secondary.hidden = secondary === undefined;
    if (primary !== undefined) [this.primary.textContent, this.onPrimary] = primary;
    if (secondary !== undefined) [this.secondary.textContent, this.onSecondary] = secondary;
  }
}
```

- [ ] **Step 6: Wire it into `src/app.ts`**

- Imports: add `isTauri` from `'@tauri-apps/api/core'`, `tauriUpdateBackend` to the existing `'./tauri'` import,
  and `import { UpdateFlow } from './updater';`.
- Field, next to `findBar`: `private readonly updateFlow: UpdateFlow;`
- In the constructor, after `this.findBar = new FindBar(…)`:

```ts
    // Only "检查更新…" drives this. Outside Tauri there is no updater, so the
    // backend is left out and the menu command does nothing.
    this.updateFlow = new UpdateFlow(required<HTMLElement>('updatebar'), {
      backend: isTauri() ? tauriUpdateBackend : undefined,
      confirmDiscard: () => this.confirmDiscard(),
    });
```

- Next to the `markdownEditor` getter:

```ts
  /** The update flow, for `scripts/check-updater.mjs`. */
  get updates(): UpdateFlow {
    return this.updateFlow;
  }
```

- In `runMenuCommand`, after the `'about'` case:

```ts
      case 'check-for-updates':
        void this.updateFlow.checkForUpdates();
        return;
```

- [ ] **Step 7: Run the checks**

Run: `corepack pnpm typecheck && corepack pnpm check:updater && corepack pnpm check:menu`
Expected: typecheck clean; `PASS: all 16 updater assertions held.`; check:menu still passes.

If an assertion fails, fix the code (not the expectation) unless the expectation contradicts the spec.
If the unsaved-changes scenarios fail because the dialog stub is never hit, check which command and return
shape the installed `@tauri-apps/plugin-dialog` uses for `ask` (`node_modules/@tauri-apps/plugin-dialog/dist-js/index.js`)
and adjust the stub in `check-updater.mjs` to return what `ask` expects for "yes"/"no".

- [ ] **Step 8: Commit** (two small commits)

```bash
git add package.json pnpm-lock.yaml src/tauri.ts
git commit -m "Bridge the updater and process plugins"
git add src/updater.ts src/app.ts index.html src/styles.css scripts/check-updater.mjs package.json
git commit -m "Show the update flow when Check for Updates is chosen"
```

---

### Task 4: Release workflow publishes the update

**Files:**
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `scripts/make-update-manifest.mjs` CLI (Task 1); public key in `tauri.conf.json` (Task 2).
- Produces: Release assets `Moda_<arch>.app.tar.gz`, `.sig`, `latest.json`; secrets
  `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` required.

- [ ] **Step 1: Run the script tests in `validate`**

In the `validate` job, after the "Both version files agree with the tag" step:

```yaml
      - name: Script tests
        run: node --test scripts/*.test.mjs
```

- [ ] **Step 2: Build with updater artifacts**

Replace the "Build the bundle" step with:

```yaml
      # Updater artifacts are switched on here rather than in tauri.conf.json:
      # with them on, `tauri build` refuses to run without the private key, and
      # a local build has no key. In CI a missing secret therefore fails the
      # release instead of publishing one that installed copies cannot update to.
      - name: Build the bundle
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        run: >-
          pnpm tauri build --target ${{ matrix.target }}
          --config '{"bundle":{"createUpdaterArtifacts":true}}'
```

- [ ] **Step 3: Collect the update package next to the disk image**

Insert before "Checksum the disk image":

```yaml
      # The updater fetches one archive per architecture from the same release,
      # so the generic Moda.app.tar.gz is renamed after its architecture.
      - name: Collect the update package
        run: |
          src="src-tauri/target/${{ matrix.target }}/release/bundle/macos"
          dest="src-tauri/target/${{ matrix.target }}/release/bundle/dmg"
          for file in Moda.app.tar.gz Moda.app.tar.gz.sig; do
            if [ ! -f "$src/$file" ]; then
              echo "::error::$src/$file was not built — are the TAURI_SIGNING_PRIVATE_KEY secrets set?"
              exit 1
            fi
          done
          cp "$src/Moda.app.tar.gz" "$dest/Moda_${{ matrix.arch }}.app.tar.gz"
          cp "$src/Moda.app.tar.gz.sig" "$dest/Moda_${{ matrix.arch }}.app.tar.gz.sig"
```

In "Checksum the disk image", rename the step to "Checksum the downloads" and change the last two lines to:

```yaml
          shasum -a 256 "${images[0]}" "Moda_${{ matrix.arch }}.app.tar.gz" > "SHA256SUMS-${{ matrix.name }}.txt"
          cat "SHA256SUMS-${{ matrix.name }}.txt"
```

In `actions/upload-artifact`, add to `path`:

```yaml
            src-tauri/target/${{ matrix.target }}/release/bundle/dmg/Moda_*.app.tar.gz
            src-tauri/target/${{ matrix.target }}/release/bundle/dmg/Moda_*.app.tar.gz.sig
```

- [ ] **Step 4: Write `latest.json` in the `release` job**

The `release` job has no checkout; add one as its first step so the script is available:

```yaml
      - uses: actions/checkout@v7
```

After "Merge the per-architecture checksums":

```yaml
      # What installed copies read. `releases/latest/download/latest.json` never
      # resolves to a pre-release, so a `-rc` tag publishes one that nobody is
      # offered.
      - name: Write the update manifest
        run: >-
          node scripts/make-update-manifest.mjs
          --version "${GITHUB_REF_NAME#v}"
          --dir dist
          --base-url "https://github.com/${GITHUB_REPOSITORY}/releases/download/${GITHUB_REF_NAME}"
          --out dist/latest.json
```

(`files: dist/*` in the release step already uploads it, with the archives and signatures.)

- [ ] **Step 5: Validate the workflow file**

Run: `node -e "const y=require('fs').readFileSync('.github/workflows/release.yml','utf8'); console.log(y.length)"` and
`ruby -ryaml -e 'YAML.load_file(".github/workflows/release.yml"); puts "ok"'`
Expected: `ok`. If `actionlint` is installed (`which actionlint`), run it too and expect no errors.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "Publish signed update packages and latest.json with each release"
```

---

### Task 5: Local end-to-end run and docs

**Files:**
- Modify: `README.md`
- Nothing else is committed; the end-to-end run uses the scratchpad.

**Interfaces:**
- Consumes: everything above; `~/.tauri/moda-updater.key(.password)`.

- [ ] **Step 1: Build the "new" release, 0.0.3, with update artifacts**

Set `S` to the session scratchpad directory (never inside the repo). In one shell call:

```bash
mv ~/.cargo/config.toml ~/.cargo/config.toml.disabled && trap 'mv ~/.cargo/config.toml.disabled ~/.cargo/config.toml' EXIT
cd /Users/cutey/code/moda
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/moda-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/moda-updater.key.password)"
corepack pnpm tauri build --bundles app \
  --config '{"version":"0.0.3","bundle":{"createUpdaterArtifacts":true}}'
mkdir -p "$S/serve"
cp src-tauri/target/release/bundle/macos/Moda.app.tar.gz "$S/serve/Moda_aarch64.app.tar.gz"
cp src-tauri/target/release/bundle/macos/Moda.app.tar.gz.sig "$S/serve/Moda_aarch64.app.tar.gz.sig"
cp "$S/serve/Moda_aarch64.app.tar.gz.sig" "$S/serve/Moda_x64.app.tar.gz.sig"
node scripts/make-update-manifest.mjs --version 0.0.3 --dir "$S/serve" \
  --base-url http://127.0.0.1:8765 --out "$S/serve/latest.json"
```

Expected: `wrote …/latest.json for 0.0.3`.

- [ ] **Step 2: Build the "old" app, 0.0.2, pointed at the local server**

```bash
mv ~/.cargo/config.toml ~/.cargo/config.toml.disabled && trap 'mv ~/.cargo/config.toml.disabled ~/.cargo/config.toml' EXIT
cd /Users/cutey/code/moda
corepack pnpm tauri build --bundles app --config '{"version":"0.0.2","plugins":{"updater":{"endpoints":["http://127.0.0.1:8765/latest.json"],"dangerousInsecureTransportProtocol":true}}}'
rm -rf "$S/Moda.app" && cp -R src-tauri/target/release/bundle/macos/Moda.app "$S/Moda.app"
```

- [ ] **Step 3: Serve and update in the real app**

Start `python3 -m http.server 8765 --directory "$S/serve"` in the background, then `open "$S/Moda.app"`.
In the app (the human does the clicking if no automation is available):
1. 新建文档, type a few characters (do not save).
2. Moda → 检查更新… → bar shows "Moda 0.0.3 可用".
3. 更新并重启 → the unsaved-changes prompt appears once → 确定.
4. The app restarts **without** a second "确定要退出吗？" prompt (Review Focus 5).

Then verify:

```bash
defaults read "$S/Moda.app/Contents/Info.plist" CFBundleShortVersionString   # 0.0.3
xattr -l "$S/Moda.app" | grep -c quarantine                                   # 0
codesign --verify --strict "$S/Moda.app" && echo sig-ok
```

Also choose 检查更新… once more in the restarted app: the bar should say `已是最新版本 0.0.3`.
Stop the http server. If step 4 shows a second prompt, fix it before continuing (e.g. skip the
close guard when the update flow is relaunching) and add a commit for that fix.

- [ ] **Step 4: Update `README.md`**

1. In "What works today", add a bullet:

```markdown
- **In-app updates.** Moda → 检查更新… asks GitHub for the newest release and, if
  there is one, downloads it, verifies its signature, installs it and restarts —
  after asking about unsaved changes. Moda never checks on its own.
```

2. In the UI checks list, after `pnpm check:find`:

```markdown
pnpm check:updater         # 检查更新… reports every outcome, restarts only after an install
```

3. In "Installing a release", at the end of the section:

```markdown
#### Updating

From 0.0.3 on, choose **Moda → 检查更新…**. Updates arrive inside the app, so they
carry no quarantine flag and need no `xattr`. Versions 0.0.1 and 0.0.2 have no
updater: install 0.0.3 by hand once, as above.
```

4. In "Cutting a release", before the numbered list:

```markdown
**One-time setup.** Updates are signed with Tauri's updater key, which is
unrelated to Apple signing. The public half is `plugins.updater.pubkey` in
`tauri.conf.json`; the private half must exist as two repository secrets:

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | the contents of `~/.tauri/moda-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password |

Back the key up. If it is lost, no installed copy can verify another update and
every user has to reinstall by hand. Without the secrets the build step fails.
```

and in the numbered list, change item 4 to:

```markdown
4. **Publishes** `Moda_<version>_aarch64.dmg`, `Moda_<version>_x64.dmg`, the update
   packages `Moda_<arch>.app.tar.gz` with their `.sig` signatures, `latest.json`
   (what installed copies read) and a combined `SHA256SUMS.txt`.
```

5. In the "Architecture" file tree, under `scripts/`, add
   `make-update-manifest.mjs  writes latest.json for a release`, and under `src/` add
   `updater.ts  the 检查更新… flow and its bar` if `src/` files are listed there.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "Document in-app updates"
```

---

## After the plan (not tasks — for the human)

1. Add the two GitHub Secrets from `~/.tauri/moda-updater.key` and `~/.tauri/moda-updater.key.password`;
   back both up in a password manager.
2. Bump `package.json` and `src-tauri/tauri.conf.json` to `0.0.3`, commit, push `main`, tag `v0.0.3`.
3. Install 0.0.3 by hand once. The next release (0.0.4) is the first one delivered in-app.
