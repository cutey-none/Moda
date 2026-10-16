# Moda

A WYSIWYG markdown editor for macOS, in the spirit of Typora: write in formatted
prose, never in markup, and get plain `.md` files on disk.

Built with **Tauri 2** (Rust shell) and **Milkdown / Crepe** (the editor).

Moda itself is licensed **AGPL-3.0** ([LICENSE](LICENSE)); its dependencies are
all permissively licensed and impose no restrictions on that choice. Read
[Licensing](#licensing-and-commercial-use) before planning a commercial release —
AGPL-3.0 is a strong copyleft licence and that choice has real consequences.

---

## Status

Phase 1 (MVP) is implemented and verified. See
[What works today](#what-works-today) for the exact list, and
[Roadmap](#roadmap) for what is not built yet.

## Quick start

```bash
pnpm install
pnpm tauri dev      # run in development
pnpm tauri build    # produce Moda.app and a .dmg
```

The first `tauri dev` compiles the Rust dependency tree, which takes a few
minutes. Later runs are fast.

### Toolchain requirements

| Tool | Required | Why |
| --- | --- | --- |
| Node.js | ≥ 20 | Vite and the Tauri CLI |
| pnpm | ≥ 10 | The lockfile is v9 format; pnpm 7 cannot read it |
| Rust | **≥ 1.90** | `Cargo.toml` uses `edition = "2024"` (stabilised in 1.85); Tauri 2.12 requires 1.90 |
| Xcode Command Line Tools | any recent | Linking and the macOS SDK |

Check with `node -v`, `pnpm -v` and `rustc --version`.

## What works today

**Editing**

- WYSIWYG surface with instant formatting — headings, bold, italic,
  strikethrough, inline code, links, images, blockquotes, ordered/unordered/task
  lists, tables, fenced code blocks with syntax highlighting, horizontal rules.
- Every construct above is asserted to render *and* to survive a round trip back
  out to markdown, so nothing is silently lost on save.
- Markdown shortcuts while typing (`# `, `- `, `> `, ` ``` `, `**bold**`, …).
- LaTeX math via KaTeX, inline and block.
- A selection toolbar for applying formatting.
- Code blocks are real CodeMirror instances, so they get syntax highlighting.

**Files**

- New, Open, Save, Save As — through native macOS dialogs.
- Round-trips real markdown: what you save is `.md` text, not a serialized
  internal format.
- Relative image paths resolve against the open file.
- The window title shows the document name and a dot while there are unsaved
  changes.
- Closing the window, or discarding an open document, asks for confirmation when
  there is unsaved work.
- **Finder integration.** `.md`, `.markdown`, `.mdown`, `.mkd`, and `.txt` are
  associated with Moda, so double-clicking a document opens it. Launching while
  Moda is already running reuses the existing window rather than starting a
  second copy.

**Workspace sidebar**

- Open a folder and browse its documents as a tree: folders expand and collapse,
  markdown files open on click, the current document is highlighted, and its
  ancestors auto-expand so it is never hidden inside a collapsed folder.
- Directories are read in one pass with a depth limit and an entry cap, so
  pointing it at the wrong folder cannot hang the app. Hidden entries and
  `.git` / `node_modules` are skipped.
- The tree refreshes on demand and the sidebar toggles with `⇧⌘E`.

**Outline**

- The sidebar's second panel lists the current document's headings and jumps to
  the one you pick. Indentation follows the heading level as written, so a
  document that goes from `h1` to `h3` is shown that way rather than being
  straightened out.
- It refreshes as the document changes, and follows a new document when one is
  opened.
- Editing raw markdown disables navigation but keeps the list, since there is no
  rendered document to scroll to — the panel says so rather than offering a click
  that does nothing.

**View**

- Toggle between the rendered surface and the raw markdown (`⌘/`).
- Word and character counts. CJK ideographs count individually rather than being
  treated as one whitespace-delimited word.
- Light and dark themes that follow the macOS appearance setting.
- A centred, measure-limited column so long lines stay readable.
- macOS 26 "liquid glass" chrome. The window is transparent and the system
  material sits behind the webview, so the desktop is what the title bar,
  sidebar and status bar are translucent over — the real `NSGlassEffectView`,
  falling back to the older sidebar vibrancy material before macOS 26. The
  editing surface stays opaque paper, so the prose keeps its contrast.

**Shortcuts**

Every one of these is also listed in the native menu bar, so the app's commands
are discoverable without reading this table.

| Action | Shortcut |
| --- | --- |
| New | `⌘N` |
| Open | `⌘O` |
| Save | `⌘S` |
| Save As | `⇧⌘S` |
| Toggle source / WYSIWYG | `⌘/` |
| Bold | `⌘B` |
| Italic | `⌘I` or `⌘U` |
| Inline code | `` ⌘` `` or `⌘E` |
| Insert link | `⌘K` |
| Heading 1–6 | `⌘1` … `⌘6` |
| Body text | `⌘0` |
| Code block | `⇧⌘C` |
| Blockquote | `⇧⌘B` |
| Bullet list | `⇧⌘8` |
| Ordered list | `⇧⌘7` |
| Toggle sidebar | `⇧⌘E` |
| Show outline | `⇧⌘U` |
| Open folder | `⇧⌘F` |
| Find | `⌘F` (or `⌃F`) |
| Find next / previous | `⌘G` / `⇧⌘G` (`↩` / `⇧↩` in the find field) |

Markdown has no underline, so `⌘U` is treated as italic. `⌘K` asks for the URL
before applying the link, since markdown links need a destination. Milkdown's own
bindings stay available alongside these rather than being replaced.

## Roadmap

Not implemented yet:

- Sidebar file tree and folder/workspace open
- Document outline panel
- Multiple tabs or windows
- Export to PDF, HTML, or DOCX
- Image paste/drag-and-drop that copies the asset next to the document
- A menu-bar (native macOS) menu, so the shortcuts are discoverable without the
  README
- Replace (find is done: `⌘F`)
- Preferences, custom themes, and user stylesheets
- Mermaid diagrams
- Typewriter and focus modes
- Bundle polish: `CFBundleDocumentTypes` so Finder can open `.md` files with Moda
  (the app already declares the associations; Finder still hands the file to
  whatever owns the extension)

## Architecture

```
index.html            app shell markup
src/
  main.ts             entry point; calls launch()
  app.ts              document state, toolbar, shortcuts, view modes
  editor.ts           the WYSIWYG surface, wrapping Crepe
  shortcuts.ts        the Typora-aligned keymap
  remark-image-title.ts  normalises image nodes so Milkdown can parse them
  tauri.ts            the only place that talks to Rust (IPC + native dialogs)
  styles.css          app chrome + the Typora-like content theme
scripts/
  check-caret.mjs     browser-driven UI checks (see Verification)
  check-typing.mjs
  check-scrolling.mjs
  check-shortcuts.mjs
  check-rendering.mjs
  check-macos-bundle.sh  the built bundle is ad-hoc signed (see Distribution)
.github/
  workflows/release.yml  tag-triggered release: unsigned macOS DMGs
src-tauri/
  src/lib.rs          Tauri builder: plugins and the command registry
  src/file_ops.rs     reading and writing markdown files
  src/main.rs         binary entry point
  tauri.conf.json     window, bundle and build configuration
  capabilities/       what the webview is allowed to invoke
  icons/              generated app icon set
```

`window.moda` is exposed while the app runs so the checks under `scripts/` can
drive the real thing. The webview only ever loads bundled local content, so there
is no untrusted script to hand that reference to.

Three deliberate decisions:

- **The Rust side owns the filesystem, not the webview.** `file_ops.rs` exposes
  `read_document`, `save_document` and `file_exists`. Errors are a tagged enum
  (`notFound` / `io` / `notUtf8`) rather than strings, so the UI can tell "you
  cannot read this" apart from "this is not markdown" without parsing prose — and
  a binary file is refused instead of silently mangled.
- **`tauri.ts` is the only IPC seam.** Every `invoke` name and native dialog
  lives there, so the rest of the frontend is readable without a Tauri host and
  the permission surface is one file to audit.
- **The document is markdown in memory, always.** Both view modes read and write
  the same string, and switching modes serializes through it. That is what keeps
  "what you see" and "what is on disk" from drifting apart.

## Verification

What has actually been run on this checkout:

```bash
pnpm typecheck                    # tsc --noEmit, clean
pnpm exec vite build              # production bundle builds
cargo test --manifest-path src-tauri/Cargo.toml   # 6 tests, all passing
pnpm tauri dev                    # the app launches and the window opens
```

The Rust tests in `src-tauri/src/file_ops.rs` cover the file layer directly —
saving and reading back a Unicode document, creating missing parent directories,
rejecting a missing file with `NotFound`, rejecting a binary file with `NotUtf8`,
round-tripping an empty document, and agreeing on a canonical path between save
and read. That last one caught a real bug: on macOS `/var` is a symlink to
`/private/var`, so an un-normalised save path made the same file look like two
different documents.

### UI checks

The frontend is exercised in a real browser through the DevTools protocol, with
`pnpm dev` already running. These assert on the user-visible symptom rather than
on internals, so they can fail for the right reasons:

```bash
pnpm dev &                 # the checks drive the running app
pnpm check:caret           # a visible native caret, not a suppressed one
pnpm check:typing          # typing reaches the editor and changes the document
pnpm check:scrolling       # a long document scrolls in exactly one container
pnpm check:shortcuts       # every bound shortcut actually formats the text
pnpm check:rendering       # every markdown construct renders *and* round-trips
pnpm check:sidebar         # the file tree renders, expands, and opens files
pnpm check:external-open   # a document from outside opens *and renders*
pnpm check:menu            # native menu choices run their commands
pnpm check:outline         # the outline lists headings and jumps to them
pnpm check:find            # ⌘F finds and highlights text in both modes
pnpm check:ipc-contract    # every command gets the arguments its Rust side declares
```

And one check that drives the real application rather than a browser, because it
is the only one that reaches the actual IPC boundary:

```bash
pnpm tauri build && pnpm verify:save   # type into the built app, then save
```

It sends keystrokes through System Events, so the terminal it runs from needs
Accessibility permission. Without that nothing is typed and the check fails
rather than reporting a false pass.

And one that inspects the built bundle instead of running it, so the
[Distribution](#distribution) claims are asserted rather than assumed:

```bash
pnpm tauri build && pnpm check:bundle   # ad-hoc signed, and Gatekeeper says
                                        # "unidentified", not "damaged"
```

The sidebar, external-open and menu checks stub the IPC bridge, because they
depend on Tauri commands a browser cannot run. That splits the coverage
rather than duplicating it: the Rust unit tests (23 of them) prove what the
filesystem yields, which arguments count as documents, and how menu ids map to
commands, while these prove what the UI does with the result.

They found nine real defects that unit tests and browser checks could not:

- **The editor had no caret at all.** Crepe's `cursor` feature defaults to a
  *virtual* caret: it marks the editor `virtual-cursor-enabled`, which sets
  `caret-color: transparent`, and then draws its own element. The replacement
  never rendered, so the native caret was suppressed with nothing in its place.
  Fixed by building the editor with `Cursor: { virtual: false }` and asserting the
  computed `caret-color` is not transparent.
- **The welcome overlay swallowed the editor.** It covered the prose with
  `pointer-events: auto`, so a first click landed on the overlay and typing went
  nowhere. The check asserts `document.elementFromPoint` at the prose returns the
  editor, not the overlay.
- **`⌘K` threw.** Milkdown's link mark declares `href` as a required attribute,
  so invoking the command with no payload raised
  `RangeError: No value supplied for attribute href`. The app now asks for the URL
  first and the check asserts the resulting `href`.
- **Every image was silently dropped on open.** `remark-parse` emits
  `title: null` for an image written without a title, but Milkdown's image
  attribute is declared `validate: "string"`, so node creation threw
  `RangeError: Expected value of type string for attribute title … got null`. The
  parser caught that error, discarded the image, and the next save wrote the
  truncated document back to disk — data loss, not a rendering glitch. Fixed by
  the `remark-image-title` plugin, which normalises the AST before Milkdown reads
  it.
- **Image `alt` text was overwritten with `1.00`.** Crepe's `ImageBlock` feature
  encodes its resize ratio *in the `alt` attribute* — parsing reads
  `Number(node.alt || 1)`, serializing writes `${ratio.toFixed(2)}`. So
  `![说明](pic.png)` came back as `![1.00](pic.png)`. The feature is now off, which
  hands images back to commonmark's inline image; the check fails if `alt` is not
  preserved.
- **The sidebar's toggle hid the wrong element.** The component was given the
  tree's inner container as its host, so `setVisible` set `hidden` on that
  instead of the outer panel — which is the element that starts hidden. The tree
  rendered correctly and the panel stayed invisible forever. The component now
  takes the panel and the content host separately.
- **A document opened from Finder landed in an empty editor.** The path arrived,
  the window title and status bar were correct, and the editor was blank with a
  `0 字符` count. Instrumenting start-up showed why: the external document loaded
  first, and then `start()` unconditionally built its empty start-up document on
  top, discarding the content. The empty editor is now only created when nothing
  is open — and the check asserts on the rendered text and the character count,
  not merely on the title.
- **The filesystem tests shared one directory.** Three modules had each grown a
  scratch-directory helper named from a timestamp alone, and Rust runs tests in
  parallel threads — so tests starting in the same nanosecond shared a directory
  and saw each other's fixtures. It surfaced as the directory-walker test finding
  its neighbours' files. The helper is now shared (`src-tauri/src/test_support.rs`)
  and unique by timestamp, counter and thread.
- **Saving never worked at all.** The Rust command took a single `request`
  struct while the frontend sent `{ path, contents }`, so every save was rejected
  with `invalid args \`request\` for command \`save_document\``. Nothing caught it
  because no check crossed the boundary: the Rust tests call the function
  directly, and the browser checks stub the bridge and happily read whichever
  fields they are handed. It now takes `path` and `contents` like every other
  command, and `check:ipc-contract` compares each command's recorded arguments
  against the parameter names its Rust signature declares.

Two false leads worth recording, both about the checks rather than the app:

- **Synthetic `KeyboardEvent`s** were used first for the keyboard checks, but
  macOS resolves `Ctrl-U` natively, so those events never reached the editor and
  produced misleading results. The checks send real input events through the
  DevTools protocol instead.
- **The code-block check raced an async mount.** A fenced block renders a
  `<pre><code>` placeholder and is then *replaced* by a CodeMirror instance, so
  asserting immediately sometimes caught neither. The check now waits for the
  node views to settle and asserts on the mounted `.cm-editor`, which is also
  what proves syntax highlighting is live.

See [Troubleshooting](#troubleshooting) for the one local Cargo setting that can
stop `cargo build` before it starts.

## Troubleshooting

### `cargo build` fails on `mirrors.ustc.edu.cn`, or on `serde`

The machine-wide `~/.cargo/config.toml` redirects crates.io to the USTC mirror,
which no longer responds:

```toml
[source.crates-io]
replace-with = 'ustc'

[source.ustc]
registry = "git://mirrors.ustc.edu.cn/crates.io-index"
```

This is not a problem with Moda, and it **cannot** be worked around from inside
the project: Cargo merges configuration hierarchically, and a `[source]` key can
only be *added* by a deeper file, never unset. A project `.cargo/config.toml`
pointing `crates-io` at the official index therefore has no effect while the
global `replace-with` is present.

Fix it at the source by deleting those two sections from
`~/.cargo/config.toml`. To build without touching that file:

```bash
mv ~/.cargo/config.toml ~/.cargo/config.toml.disabled
cargo build --manifest-path src-tauri/Cargo.toml
mv ~/.cargo/config.toml.disabled ~/.cargo/config.toml
```

An isolated `CARGO_HOME` also works and leaves the file alone. Two things are
needed, and both are easy to miss:

```bash
mkdir -p /tmp/cargo-home && ln -s ~/.cargo/registry /tmp/cargo-home/registry
cd /tmp   # must be outside $HOME, see below
CARGO_HOME=/tmp/cargo-home cargo build --offline \
  --manifest-path ~/code/moda/src-tauri/Cargo.toml
```

The symlink is what lets the build reach the crates already in the cache.
Changing directory matters because Cargo discovers configuration by walking up
from the *working directory*, not from the manifest — `~/.cargo/config.toml` is
itself an ancestor of any checkout under `$HOME`, so it is read as a
directory-level config even when `CARGO_HOME` points somewhere else. `--offline`
is then satisfied by the cached crates.io index; the USTC mirror's index is an
empty checkout, which is why offline mode finds nothing through it.

### `pnpm install` fails with `ERR_INVALID_THIS` or `ERR_PNPM_META_FETCH_FAIL`

pnpm 7 cannot talk to the npm registry on Node 22. Upgrade pnpm:

```bash
corepack enable && corepack prepare pnpm@10 --activate
```

`package.json` pins `packageManager: pnpm@10.20.0`, so Corepack picks the right
version automatically once enabled.

### `error: package 'moda' requires a newer version of Cargo`

`edition = "2024"` needs Rust 1.90 or newer. Run `rustup update stable`.

## Distribution

Moda ships **unsigned**: no Apple Developer ID certificate, no notarisation, no
Apple Developer Program membership. That is the same choice MarkText makes, and
it is the usual one for an AGPL desktop app distributed directly. It costs users
one Terminal command on first launch.

Installing it: [Installing a release](#installing-a-release). Publishing it:
[Cutting a release](#cutting-a-release). Why it works this way:
[Why the bundle is still signed](#why-the-bundle-is-still-signed-just-not-by-apple).

```bash
pnpm tauri build    # Moda.app + Moda_<version>_<arch>.dmg
pnpm check:bundle   # asserts the signing story below still holds
```

### Installing a release

#### 1. Download the build for your Mac

| Your Mac | Download |
| --- | --- |
| Apple Silicon (M1, M2, M3, M4, …) | the file ending `_aarch64.dmg` |
| Intel | the file ending `_x64.dmg` |

Not sure which you have? Apple menu → **About This Mac** → **Chip** (or
**Processor**). "Apple M…" is Apple Silicon, "Intel Core…" is Intel. The `x64`
build will also run on Apple Silicon if Rosetta 2 is installed, more slowly; the
`aarch64` build will not run on an Intel Mac at all.

#### 2. Install it

Open the `.dmg`, drag **Moda** onto the **Applications** shortcut in the same
window, and eject the disk image. Nothing hides anywhere: Moda is a single `.app`
bundle, so uninstalling means deleting it (step 6).

#### 3. The first launch is refused — this is expected

Moda has no Apple Developer ID, so macOS cannot check it and will not open it the
first time. You will see one of two things:

| What macOS shows | What it means |
| --- | --- |
| "Moda cannot be opened because the developer cannot be verified"; on macOS 15 and later a dialog headed **"Moda" Not Opened** saying Apple could not verify it is free of malware | Normal for an unsigned app. Step 4 fixes it. |
| "Moda is damaged and can't be opened. You should move it to the Trash." | Not normal. The download or its signature is broken. Check step 5, then step 4 option C. |

#### 4. Let it through — pick one

**Option A — Terminal, every version of macOS.** This is the one to reach for:

```bash
xattr -cr /Applications/Moda.app
```

The download carries an extended attribute (`com.apple.quarantine`) recording
where it came from, and Gatekeeper only challenges apps that carry it. Clearing it
is a one-off. `-cr` clears every extended attribute from the bundle
*recursively* — the instruction MarkText ships, and safer than
`xattr -d com.apple.quarantine /Applications/Moda.app`, which removes one
attribute from the bundle root and leaves any nested copy behind.

Then open Moda normally. A new release is a new download with a new quarantine
attribute, so this repeats once per version you download.

**Option B — System Settings, macOS 15 and later.** Apple removed the
Control-click → Open override in Sequoia ([Apple, August 2024][apple-sequoia]), so
the GUI route is:

1. Try to open Moda, read the dialog, and dismiss it.
2. **System Settings → Privacy & Security**.
3. Scroll to **Security** and click **Open Anyway** next to the message about Moda.
4. Authenticate, then open Moda again and confirm.

That button appears only because the bundle's signature is valid. On a build whose
signature is broken, macOS does not offer it at all.

**Option C — when macOS insists the app is damaged.** That means the ad-hoc
signature did not survive the trip (an interrupted download, an unzip that dropped
metadata, a copy made by a tool that strips it). Re-sign it with the same command
the release build uses, then clear quarantine:

```bash
codesign --force --deep --sign - /Applications/Moda.app
xattr -cr /Applications/Moda.app
```

Neither command needs an Apple ID, and they only affect that copy of the app on
your machine.

[apple-sequoia]: https://developer.apple.com/news/?id=saqachfa

#### 5. Verify the download

Every release lists the SHA-256 of each file in `SHA256SUMS.txt`. Download that
file alongside the `.dmg`, then:

```bash
cd ~/Downloads
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```

Each line prints `OK` or `FAILED`. (macOS ships `shasum`, not GNU `sha256sum`; both
take `-c`.) This is also how to answer "what makes an unsigned build trustworthy?":
the files are built by GitHub Actions from a tag in this repository, so the release
is reproducible from the source you can read, and the checksum is what tells you
the file you got is the file that was built.

#### 6. Uninstalling

Quit Moda and delete `/Applications/Moda.app`. Your documents are ordinary `.md`
files wherever you saved them and are not touched. To remove the preferences and
webview storage as well:

```bash
rm -rf ~/Library/WebKit/com.cutey.moda \
       ~/Library/Caches/com.cutey.moda \
       ~/Library/Preferences/com.cutey.moda.plist
```

#### 7. Rather not download a binary at all?

Build it from source — the same code, compiled on your machine, with no Gatekeeper
step anywhere: see [Quick start](#quick-start).

### Cutting a release

To cut a release, bump the version in `package.json` **and**
`src-tauri/tauri.conf.json` (the workflow refuses to build when they disagree with
the tag), commit, then tag and push:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

[release.yml](.github/workflows/release.yml) takes it from there:

1. **Validates** the tag (`vX.Y.Z`, optionally `-prerelease`) against both version
   files.
2. **Builds** each architecture on its own runner — `macos-15` for Apple Silicon,
   `macos-15-intel` for Intel — running `pnpm typecheck`, the Rust tests, and
   `pnpm tauri build --target …`. There is no certificate step and no notarisation
   step, because there is nothing to sign with.
3. **Checks** each bundle with [check-macos-bundle.sh](scripts/check-macos-bundle.sh),
   so a release cannot be published from a build that has slipped back into the
   "damaged" state.
4. **Publishes** `Moda_<version>_aarch64.dmg`, `Moda_<version>_x64.dmg` and a
   combined `SHA256SUMS.txt`, with the note below written into the release body.

A tag containing a hyphen (`v0.2.0-rc.1`) is published as a pre-release. The
workflow creates the release as a draft and then promotes it in a second step, so
that it also works in repositories with immutable releases enabled; delete the last
step of the `release` job if you would rather read the notes before publishing.

The note every release carries:

```text
⚠️ Note for macOS users

Moda is unsigned (no Apple Developer ID, no notarisation). After dragging Moda
into Applications, clear the quarantine flag once:

    xattr -cr /Applications/Moda.app

Then open Moda normally. On macOS 15 and later you can do the same thing without
the Terminal: System Settings → Privacy & Security → Open Anyway.
```

Local builds are per-architecture as well: `pnpm tauri build` produces the `.dmg`
for the machine you are on, and a universal image needs both Rust targets:

```bash
rustup target add x86_64-apple-darwin
pnpm tauri build --target universal-apple-darwin
```

### Why the bundle is still signed, just not by Apple

`bundle.macOS.signingIdentity` is set to `"-"`, Tauri's pseudo-identity for an
**ad-hoc** signature ([Tauri's macOS signing guide][tauri-sign]). On Apple
Silicon this is not optional. Every arm64 binary must carry *some* signature, and
the one the linker writes is not a bundle signature: it seals no resources, so
the output of a plain `tauri build` fails verification:

```
$ codesign --verify --strict Moda.app
Moda.app: code has no resources but signature indicates they must be present
```

macOS shows that failure to users as **"Moda is damaged and can't be opened"** —
the one Gatekeeper verdict `xattr` cannot clear and System Settings cannot
override. Ad-hoc signing the finished bundle makes it internally valid, so
Gatekeeper refuses it as an *unidentified developer* instead, which
[step 4](#4-let-it-through--pick-one) does clear. Ad-hoc signing changes *which*
refusal users see, from unfixable to fixable; it does not earn trust the bundle
does not have, and a notarisation ticket is the only thing that would.

`pnpm check:bundle` builds a quarantined copy of the app, asks Gatekeeper to
judge it, and fails if the verdict has slipped back to "damaged".

[tauri-sign]: https://v2.tauri.app/distribute/sign/macos/

### Why notarisation is not used

Notarising needs an Apple Developer Program membership (≈ $99/yr), which an
open-source project with no revenue has no reason to pay for — MarkText does not
either. What it would buy is a first launch with no dialog and no Terminal step.
What it would not change is anything else about the build: pointing
`signingIdentity` at a *Developer ID Application* identity and supplying
`APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` is the entire difference.
Notarisation is also a requirement for the Mac App Store, which
[the licensing section](#licensing-and-commercial-use) explains is a poor fit for
AGPL code in the first place.

## Licensing and commercial use

### Moda's own licence

**Moda is licensed AGPL-3.0** — see [LICENSE](LICENSE). This is a strong
(copyleft) licence, and it is worth being explicit about what it means, because
it is easy to assume "open source" also means "closed-source product is fine":

- You **may** sell Moda, charge for it, or run it as a paid service. AGPL does
  not forbid commercial use.
- You **must** give every recipient the complete corresponding source of the
  version you distributed, under the same licence.
- **Section 13 is the part that catches people out:** if users interact with a
  modified version *over a network*, you must offer them that version's source.
  A desktop app alone does not trigger this, but any server component would.
- **You cannot ship AGPL code as a closed-source product.** If the plan is a
  proprietary paid app, the licence in `LICENSE` needs to change first — that is
  a one-file change, and it is entirely allowed, since you hold the copyright to
  your own code.
- **The Mac App Store is a poor fit for AGPL.** Apple's terms impose additional
  restrictions on redistribution and usage that conflict with AGPL §10 ("you may
  not impose any further restrictions"). Direct distribution — an unsigned
  `.dmg`, see [Distribution](#distribution) — is the usual route for AGPL macOS
  apps.

If that is not what you want, decide now rather than after shipping — switching
later means every past recipient keeps the rights they already received.

### The dependencies

The dependency set was audited for compatibility with commercial distribution.
**None of it constrains Moda's own licence choice**, because there is no copyleft
in the shipped set:

- **Every runtime dependency is permissive**: MIT, Apache-2.0, or a dual license
  resolving to one of those.
- **No copyleft, no non-commercial restriction, no paid tier, and no
  watermarking anywhere in the shipped set.** There is no "Milkdown Pro", and
  nothing in the MIT `@milkdown/*` packages requires payment.
- **Tauri imposes no royalty and no commercial agreement.** Its code is
  `MIT OR Apache-2.0`.
- **DOMPurify is `MPL-2.0 OR Apache-2.0`** — Moda elects **Apache-2.0**, which
  removes file-level copyleft. This election is recorded in
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- Build-time-only tooling (`lightningcss`, MPL-2.0) is not embedded in the
  shipped bundle.

Two obligations under any licence choice:

1. **Ship [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)** with the app — add
   it to an in-app "About / Third-Party Notices" screen.
2. **Tauri trademark rules apply.** The stock Tauri icon has already been
   replaced with Moda's own icon; that replacement is mandatory, not cosmetic.
   Do not imply endorsement by the Tauri Programme.

Notarising a macOS build needs an Apple Developer Program membership
(≈ $99/yr). Moda does not do it; see [Distribution](#distribution) for what the
released `.dmg` is signed with instead. The icon set in `src-tauri/icons` is
generated from `src-tauri/icons/moda-icon.svg` with `pnpm tauri icon`;
regenerate it there if the mark changes.
