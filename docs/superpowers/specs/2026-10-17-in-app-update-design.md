# 应用内更新 — 设计

日期：2026-10-17

## 目标

用户（包括开发者本人）在 Moda 里点一下就能升级到最新正式版，不再每次去 GitHub
下载 DMG、拖进 Applications、清 quarantine。

## 已确定的约束与决定

- **只跟随正式 Release。** 更新源是 GitHub Releases 的 `latest`，预发布 tag（含
  `-`）永远不会推送给用户。开发者想验证新功能，就发正式版。
- **只手动检查。** 不在启动时或任何后台时机联网。只有用户点 "Moda → 检查更新…"
  才检查，每次都给出明确反馈。
- **安装前确认。** 有新版时由用户点"更新并重启"才下载安装；有未保存修改时先走现有的
  放弃确认。
- **不引入 Apple Developer ID。** 维持现有的 ad-hoc 签名。更新包另用 Tauri updater
  的 minisign 密钥签名，与 Apple 签名无关。
- **方案：** Tauri 官方 `tauri-plugin-updater` + `tauri-plugin-process`，流程与 UI
  在前端（webview）实现。理由：未保存状态归前端所有，Rust 保持"薄"。

updater 由 app 自己下载更新包，新版本不会带 `com.apple.quarantine`，因此只有首次
安装需要 `xattr`，之后每次升级都没有 Gatekeeper 拦截。

## 组件

### Rust

- `src-tauri/Cargo.toml`：新增 `tauri-plugin-updater`、`tauri-plugin-process`。
- `src-tauri/src/lib.rs`：注册两个插件。
- `src-tauri/tauri.conf.json`：
  - `plugins.updater.pubkey`：更新签名公钥（可提交）。
  - `plugins.updater.endpoints`：
    `["https://github.com/cutey-none/Moda/releases/latest/download/latest.json"]`。
  - `bundle.createUpdaterArtifacts: true`。
- `src-tauri/capabilities/default.json`：新增 `updater:default`、
  `process:allow-restart`。
- `src-tauri/src/menu.rs`：App 菜单"关于"下新增"检查更新…"，菜单 id
  `check-for-updates`，对应新的 `MenuCommand::CheckForUpdates`（序列化为
  `check-for-updates`），沿用 `command_for_id` 与现有单元测试。

### 前端

- `src/tauri.ts`：封装 `@tauri-apps/plugin-updater` 的 `check()` 与
  `@tauri-apps/plugin-process` 的 `relaunch()`，前端其余部分不直接接触插件。
- `src/updater.ts`（新）：拥有整个更新流程与更新条的状态。`app.ts` 只负责创建它，
  注入 `confirmDiscard()`，并在收到 `check-for-updates` 菜单命令时调用它。
- `index.html` / `src/styles.css`：编辑区底部的浮动更新条，沿用状态栏的玻璃样式。

### 更新条状态

| 状态 | 显示 | 操作 |
| --- | --- | --- |
| 检查中 | "正在检查更新…" | — |
| 已是最新 | "已是最新版本 0.0.x" | [好] |
| 有新版 | "Moda 0.0.y 可用" + 发布说明前几行 | [更新并重启] [稍后] |
| 下载中 | "正在下载… 42%" | — |
| 失败 | "检查更新失败：<原因>" 或 "更新失败：<原因>" | [重试] [关闭] |

"稍后"只是隐藏更新条，不记录跳过的版本。

## 流程

1. 用户点 "检查更新…"。若已在检查或下载中，忽略这次点击。
2. 调用 `check()`：
   - 无更新 → "已是最新版本"。
   - 有更新 → "有新版"。
   - 抛错 → "失败"，可重试。
3. 用户点"更新并重启"：
   - 先 `confirmDiscard()`；用户取消 → 回到"有新版"，不下载。
   - 否则 `downloadAndInstall()`，按进度事件更新百分比（无总大小时只显示"正在下载…"）。
   - 安装成功 → `relaunch()`。
   - 下载中断或签名校验失败 → "失败"，当前 app 保持原样。
4. 不在 Tauri 环境（浏览器开发/检查脚本）时，菜单命令不调用任何插件。

## 发布流程（CI）

### 一次性准备

- 本地运行 `pnpm tauri signer generate -w ~/.tauri/moda-updater.key` 生成密钥对，
  私钥留在仓库外，公钥写入 `tauri.conf.json`。
- 维护者在 GitHub 仓库添加 Secrets：`TAURI_SIGNING_PRIVATE_KEY`（私钥内容）、
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，并自行备份私钥。**私钥丢失意味着已安装的
  app 再也无法验证新更新，所有用户只能手动重装。**

### `.github/workflows/release.yml` 变更

- `build` job：把两个 Secret 作为环境变量传给 `pnpm tauri build`。构建后把
  `bundle/macos/Moda.app.tar.gz` 与 `.sig` 重命名为 `Moda_<arch>.app.tar.gz` 与
  `Moda_<arch>.app.tar.gz.sig`，与 DMG 一同上传；tarball 也写入该架构的 SHA256SUMS。
  找不到 tarball 或 `.sig`（例如 Secret 缺失）则失败。
- `release` job：发布前运行 `node scripts/make-update-manifest.mjs`，读入版本号
  （tag 去掉 `v`）、仓库名与两个 `.sig`，生成 `latest.json`：

  ```json
  {
    "version": "0.0.3",
    "notes": "",
    "pub_date": "<RFC 3339>",
    "platforms": {
      "darwin-aarch64": {
        "signature": "<Moda_aarch64.app.tar.gz.sig 内容>",
        "url": "https://github.com/cutey-none/Moda/releases/download/v0.0.3/Moda_aarch64.app.tar.gz"
      },
      "darwin-x86_64": {
        "signature": "<Moda_x64.app.tar.gz.sig 内容>",
        "url": "https://github.com/cutey-none/Moda/releases/download/v0.0.3/Moda_x64.app.tar.gz"
      }
    }
  }
  ```

  缺任一 `.sig` 时脚本报错退出。`latest.json` 与 tarball、`.sig` 一起作为 Release
  资产发布。预发布同样上传，但 `releases/latest` 不会指向它。
- DMG、ad-hoc 签名、`check-macos-bundle.sh` 与首装说明不变。

## 测试

- **Rust**：`menu.rs` 现有测试覆盖新的 `check-for-updates`（id 映射、唯一性、序列化名）。
- **清单脚本**：`node --test` 单元测试——结构正确、两个平台键、URL 指向对应 tag、
  缺 `.sig` 时报错。
- **`pnpm check:updater`**（新浏览器检查，仿 `check:menu` 打桩 IPC）：注入菜单事件，
  断言用户实际看到的结果——有新版、已是最新、检查失败、下载进度、未保存时取消则不下载、
  仅在安装成功后才 relaunch。
- **本地端到端**（实现时执行一次，不提交）：用 `tauri build --config` 把 endpoint
  指向本地服务器，构建旧版 app；再构建签名的新版更新包并在本地提供；在真实 app 里点
  "检查更新…"，确认完成更新、重启后版本号变化，且新版本没有 quarantine 属性。
- **真实验收**：第一个带 updater 的版本（如 v0.0.3）需手动安装；下一个 Release 是
  首次通过应用内更新的版本。

## 文档

README 新增"应用内更新"说明；"Cutting a release"补充一次性密钥与 Secret 配置；
注明 0.0.3 之前的版本需要最后手动安装一次。

## 不做

- 启动时或定时自动检查。
- 预发布 / nightly 频道。
- 跳过某个版本、自动下载、退出时安装。
- Windows / Linux 的更新包。
