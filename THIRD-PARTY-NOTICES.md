# Third-Party Notices — Moda

Moda is distributed with the third-party components listed below. This file
satisfies the attribution requirements of their licenses.

## How the dependencies are licensed

Every component shipped inside the Moda application binary is under a permissive
license (MIT, Apache-2.0, or a disjunctive dual license that resolves to one of
those). **There is no copyleft, no non-commercial restriction, and no paid tier
anywhere in the shipped dependency set.**

Two components need a deliberate choice, recorded here so it is not lost:

- **DOMPurify** is offered under `MPL-2.0 OR Apache-2.0`. **Moda elects
  Apache-2.0.** This removes any file-level copyleft obligation; the packaged
  copy is unmodified.
- **Tauri, tao, wry, serde, TypeScript** are offered under Apache-2.0 (some as
  `MIT OR Apache-2.0`). Where a choice exists, **Moda elects MIT** for the
  components that offer both, and relies on Apache-2.0 §4 obligations (retain
  notices, include the license text) for the Apache-only ones.

Build-time-only tooling (Vite, lightningcss, and their transitive dependencies)
is **not** embedded in the shipped application bundle and imposes no obligation
on it. `lightningcss` is MPL-2.0; it is unmodified and used only during the
build.

## Runtime components

### Editor core

| Component | Version | License | Copyright |
| --- | --- | --- | --- |
| `@milkdown/crepe` | 7.22.2 | MIT | © 2020-present Mirone |
| `@milkdown/kit` | 7.22.2 | MIT | © 2020-present Mirone |
| `prosemirror-model` | 1.25.x | MIT | © 2015-2017 Marijn Haverbeke and others |
| `prosemirror-state` | 1.4.x | MIT | © 2015-2017 Marijn Haverbeke and others |
| `prosemirror-view` | 1.42.x | MIT | © 2015-2017 Marijn Haverbeke and others |
| `prosemirror-commands` | 1.7.x | MIT | © 2015-2017 Marijn Haverbeke and others |
| `prosemirror-inputrules` | 1.5.x | MIT | © 2015-2017 Marijn Haverbeke and others |
| `prosemirror-keymap` | 1.2.x | MIT | © 2015-2017 Marijn Haverbeke and others |
| `prosemirror-schema-list` | 1.5.x | MIT | © 2015-2017 Marijn Haverbeke and others |
| `prosemirror-tables` | 1.8.x | MIT | © 2015-2017 Marijn Haverbeke and others |
| `prosemirror-history` | 1.5.x | MIT | © 2015-2017 Marijn Haverbeke and others |
| `prosemirror-dropcursor` | 1.8.x | MIT | © 2015-2017 Marijn Haverbeke and others |
| `prosemirror-gapcursor` | 1.4.x | MIT | © 2015-2017 Marijn Haverbeke and others |

### Markdown processing

| Component | Version | License | Copyright |
| --- | --- | --- | --- |
| `remark-parse` | 11.0.0 | MIT | © 2015 Titus Wormer |
| `remark-stringify` | 11.0.0 | MIT | © 2015 Titus Wormer |
| `remark-math` | 6.0.0 | MIT | © 2021 Junyoung Choi |
| `unified` | 11.0.x | MIT | © 2015 Titus Wormer |
| `micromark` | 4.0.x | MIT | © Titus Wormer |
| `mdast-util-from-markdown` | 2.1.x | MIT | © Titus Wormer |
| `mdast-util-to-markdown` | 2.2.x | MIT | © Titus Wormer |
| `mdast-util-math`, `micromark-extension-math` | 3.x | MIT | © Titus Wormer |
| `unist-util-visit`, `unist-util-visit-parents` | 5.x / 6.x | MIT | © Titus Wormer |

### Code editing and syntax highlighting

| Component | Version | License | Copyright |
| --- | --- | --- | --- |
| `codemirror` | 6.0.x | MIT | © 2018-2021 Marijn Haverbeke and others |
| `@codemirror/state` | 6.7.x | MIT | © 2018-2021 Marijn Haverbeke and others |
| `@codemirror/view` | 6.43.x | MIT | © 2018-2021 Marijn Haverbeke and others |
| `@codemirror/language` | 6.13.x | MIT | © 2018-2021 Marijn Haverbeke and others |
| `@codemirror/language-data` | 6.5.x | MIT | © 2018-2021 Marijn Haverbeke and others |
| `@codemirror/commands` | 6.11.x | MIT | © 2018-2021 Marijn Haverbeke and others |
| `@codemirror/theme-one-dark` | 6.1.x | MIT | © 2018-2021 Marijn Haverbeke and others |

### Rendering and UI support

| Component | Version | License | Copyright |
| --- | --- | --- | --- |
| `vue` | 3.5.x | MIT | © 2013-present, Yuxi (Evan) You |
| `katex` | 0.18.x, 0.16.x | MIT | © 2013-2020 Khan Academy and other contributors |
| `dompurify` | 3.4.x | MPL-2.0 OR Apache-2.0 — **Apache-2.0 elected** | © 2015 Mario Heiderich and contributors |
| `prosemirror-virtual-cursor` | 0.4.2 | MIT | © 2022 ocavue |
| `clsx` | 2.1.x | MIT | © Luke Edwards |
| `lodash-es` | 4.17.x | MIT | © OpenJS Foundation and other contributors |

### Desktop runtime (Rust)

| Crate | Version | License |
| --- | --- | --- |
| `tauri` | 2.12.x | Apache-2.0 OR MIT |
| `tauri-build` | 2.7.x | Apache-2.0 OR MIT |
| `tauri-plugin-dialog` | 2.8.x | Apache-2.0 OR MIT |
| `tauri-plugin-opener` | 2.7.x | MIT OR Apache-2.0 |
| `tao` | 0.37.x | Apache-2.0 |
| `wry` | 0.57.x | Apache-2.0 OR MIT |
| `serde`, `serde_json` | 1.0.x | MIT OR Apache-2.0 |

## Build-time components (not redistributed)

`vite` (MIT), `typescript` (Apache-2.0), `lightningcss` + `lightningcss-darwin-arm64`
(MPL-2.0), `@tauri-apps/cli` (Apache-2.0 OR MIT), and their transitive
dependencies. None of these are embedded in the shipped application bundle.

## Full license texts

### MIT License

The following text applies to every component marked `MIT` above, each with its
own copyright holder as listed in the tables.

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Apache License 2.0

Applies to `tauri`, `tauri-build`, `tauri-plugin-dialog`, `tauri-plugin-opener`,
`tao`, `wry`, `serde`, `serde_json`, `dompurify`, and (build-time) `typescript`
and `@tauri-apps/cli`.

The full text is available at <https://www.apache.org/licenses/LICENSE-2.0>.
A copy must be included when redistributing these components. Obtain the verbatim
text from any of the named packages (each ships a `LICENSE` file) or from the URL
above, and ship it alongside this notice.

---

## Trademarks

"Tauri" and the Tauri logo are trademarks of the Tauri Programme within the
Commons Conservancy. Moda uses Tauri as a framework; Moda is **not** endorsed by
or affiliated with the Tauri Programme. Moda does not ship the Tauri logo as its
application icon.

## Note on completeness

This file covers the components known at the time of writing. Before a commercial
release, regenerate the dependency inventory from the lockfiles
(`pnpm-lock.yaml`, `src-tauri/Cargo.lock`) and diff it against this list, so that
a newly added dependency's license cannot ship unnoticed. `cargo-about` and
`license-checker` automate that check.
