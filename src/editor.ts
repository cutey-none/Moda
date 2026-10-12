/**
 * The WYSIWYG surface.
 *
 * Wraps Crepe (Milkdown's ready-made editor) behind the small surface the app
 * actually uses: create, read the markdown out, put markdown in, and observe
 * edits. Everything else — Milkdown contexts, ProseMirror transactions, the
 * plugin list — stays in this module.
 */

import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { commandsCtx, editorViewCtx, remarkPluginsCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { TextSelection } from '@milkdown/kit/prose/state';
import { replaceAll } from '@milkdown/kit/utils';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { remarkImageTitle } from './remark-image-title';
import { ScrollAnchor } from './scroll-anchor';
import { typoraShortcuts } from './shortcuts';

/** One entry in the document outline. */
export interface OutlineEntry {
  /** The heading's text, as shown in the panel. */
  text: string;
  /** Heading level, 1 through 6. */
  level: number;
  /** Milkdown's heading id, derived from the text. */
  id: string;
  /**
   * Position of the heading node in the document.
   *
   * Carried alongside because the outline is used for navigation, and Milkdown's
   * own `outline()` macro reports only text, level and id — enough to display,
   * not enough to scroll to.
   */
  pos: number;
}

/**
 * Features tuned for a Typora-like writing surface.
 *
 * Crepe's own title bar is a menu strip of its own design, so it is off: the app
 * draws its own chrome. The AI feature needs an API key and stays off.
 *
 * `ImageBlock` is off for a data-integrity reason, not a cosmetic one. It
 * replaces the plain markdown image with a resizable "image block" that encodes
 * its size ratio **in the `alt` attribute**: parsing reads `alt` as a number
 * (`Number(node.alt || 1)`) and serializing writes `${ratio.toFixed(2)}` back
 * into it. A document containing `![说明](pic.png)` therefore comes back as
 * `![1.00](pic.png)` — the user's alternative text is destroyed on save.
 * Leaving the feature off hands images to commonmark's inline image, which
 * round-trips `alt` and `title` faithfully. Verified by
 * `scripts/check-rendering.mjs`, which fails on the `1.00` rewrite.
 */
const ENABLED_FEATURES: Partial<Record<CrepeFeature, boolean>> = {
  [CrepeFeature.CodeMirror]: true,
  [CrepeFeature.ListItem]: true,
  [CrepeFeature.LinkTooltip]: true,
  [CrepeFeature.Cursor]: true,
  [CrepeFeature.ImageBlock]: false,
  [CrepeFeature.Toolbar]: true,
  [CrepeFeature.Placeholder]: true,
  [CrepeFeature.Table]: true,
  [CrepeFeature.Latex]: true,
  [CrepeFeature.TopBar]: false,
  [CrepeFeature.AI]: false,
};

export interface MarkdownEditorOptions {
  /** Element Crepe mounts into. */
  root: HTMLElement;
  /** Initial document text. */
  initialValue: string;
  /** Called after any user edit, with the serialized markdown. */
  onChange: (markdown: string) => void;
}

/** A writing surface that speaks markdown in both directions. */
export class MarkdownEditor {
  private readonly crepe: Crepe;
  private readonly options: MarkdownEditorOptions;
  /** Keeps the view still while Crepe swaps code blocks in and out. */
  private anchor: ScrollAnchor | undefined;

  constructor(options: MarkdownEditorOptions) {
    this.options = options;
    this.crepe = new Crepe({
      root: options.root,
      defaultValue: options.initialValue,
      features: { ...ENABLED_FEATURES },
      featureConfigs: {
        [CrepeFeature.Placeholder]: {
          text: '开始写作，或按 ⌘O 打开一个 Markdown 文件…',
        },
        // Use the platform's own text caret.
        //
        // Crepe's default is a "virtual" caret: `prosemirror-virtual-cursor`
        // marks the editor `virtual-cursor-enabled`, which sets
        // `caret-color: transparent`, and then draws its own element. That left
        // the editor with no visible caret at all — the native one suppressed
        // and the replacement not rendering. The native caret is also what a
        // Mac text editor is expected to behave like (it blinks, it follows the
        // system accent settings, and it stays in step with the IME).
        [CrepeFeature.Cursor]: {
          virtual: false,
        },
        [CrepeFeature.CodeMirror]: {
          // A dark syntax theme inside code blocks when the system is dark.
          theme: window.matchMedia('(prefers-color-scheme: dark)').matches
            ? oneDark
            : EditorView.baseTheme({}),
        },
      },
    });

    this.crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown, previous) => {
        // Crepe reports the initial parse as an update too; a caller that just
        // loaded that same text should not be told the document is dirty.
        if (markdown === previous) return;
        this.options.onChange(markdown);
      });
    });
  }

  /**
   * Build the editor. Must be awaited before any other member is used.
   *
   * Both extra plugins are registered first: Crepe only accepts its feature list
   * through the constructor, so anything else has to go onto the underlying
   * editor before `create()` runs the plugin list.
   *
   * - `typoraShortcuts` adds the app's key bindings.
   * - `remarkImageTitle` normalises image nodes in the markdown AST. Without it
   *   every titleless image throws during parsing and is silently dropped — see
   *   the plugin's own module for the details.
   */
  async create(): Promise<void> {
    this.crepe.editor.use(typoraShortcuts);
    this.crepe.editor.config((ctx) => {
      ctx.update(remarkPluginsCtx, (plugins) => [...plugins, remarkImageTitle]);
    });
    await this.crepe.create();

    const scroller = this.options.root.querySelector<HTMLElement>('.milkdown');
    const content = scroller?.querySelector<HTMLElement>('.ProseMirror');
    if (scroller && content) this.anchor = new ScrollAnchor(scroller, content);
  }

  /** Tear the editor down and release its DOM. */
  async destroy(): Promise<void> {
    this.anchor?.disconnect();
    await this.crepe.destroy();
  }

  /** The current document as markdown. */
  getMarkdown(): string {
    return this.crepe.getMarkdown();
  }

  /**
   * Run a function against Milkdown's editor context.
   *
   * Escape hatch for the automated UI checks under `scripts/`, which need to
   * read state the app itself does not surface (the registered keymaps, the
   * ProseMirror view). Keeping it narrow means the checks can reach in without
   * the app having to publish its internals broadly.
   */
  inspect<T>(read: (ctx: Ctx) => T): T {
    return this.crepe.editor.action(read);
  }

  /**
   * Apply a link mark to the current selection.
   *
   * The URL has to be supplied: Milkdown's link mark declares `href` as a
   * required attribute, so invoking the command without one throws a
   * `RangeError` rather than doing nothing.
   *
   * @param href - the destination URL.
   * @returns whether the mark was applied.
   */
  setLink(href: string): boolean {
    return this.crepe.editor.action((ctx) =>
      ctx.get(commandsCtx).call('ToggleLink', { href }),
    );
  }

  /**
   * Whether the current selection carries a link, for pre-filling the prompt.
   *
   * @returns the existing href, or undefined.
   */
  currentLinkHref(): string | undefined {
    return this.crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { doc, selection } = view.state;
      const link = doc
        .resolve(selection.from)
        .marks()
        .find((mark) => mark.type.name === 'link');
      const href = link?.attrs.href;
      return typeof href === 'string' && href.length > 0 ? href : undefined;
    });
  }

  /**
   * The document's headings, in order.
   *
   * Walks the ProseMirror document rather than calling Milkdown's `outline()`
   * macro, because that macro reports only text, level and id — and navigation
   * needs the node position. One walk gives both.
   */
  headings(): OutlineEntry[] {
    return this.crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const entries: OutlineEntry[] = [];
      view.state.doc.descendants((node, pos) => {
        if (node.type.name !== 'heading') return true;
        const level = Number(node.attrs.level);
        if (!Number.isFinite(level) || level < 1) return true;
        entries.push({
          text: node.textContent,
          level,
          id: typeof node.attrs.id === 'string' ? node.attrs.id : '',
          pos,
        });
        return true;
      });
      return entries;
    });
  }

  /**
   * Put the caret at the start of a heading and scroll it into view.
   *
   * @param pos - the heading node's position, as reported by {@link headings}.
   */
  goToHeading(pos: number): void {
    this.crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { doc } = view.state;
      // A heading's content begins one position past the node itself. Clamped,
      // because a later edit could have made the recorded position stale.
      const target = Math.min(pos + 1, doc.content.size);
      const selection = TextSelection.near(doc.resolve(target));
      view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
      view.focus();
    });
  }

  /**
   * Replace the whole document.
   *
   * Uses Milkdown's own `replaceAll` macro rather than hand-rolling a
   * transaction: it goes through the editor's parser, which is configured with
   * the same remark plugins the serializer uses, so text read back out of the
   * editor round-trips.
   *
   * This is an edit like any other: it is undoable and reported through
   * `onChange`. To show a different file, use {@link load}.
   */
  setMarkdown(markdown: string): void {
    this.crepe.editor.action(replaceAll(markdown));
  }

  /**
   * Show a newly opened document, without reporting it as a change.
   *
   * Builds a fresh editor state instead of dispatching an edit. An edit reaches
   * the change listener, which reports on a 200ms debounce — long after any
   * flag set around the call is cleared — so the document just opened was
   * marked modified, autosaved, and asked about on close. A fresh state also
   * starts a fresh undo history, so ⌘Z cannot walk back into the previous file.
   */
  load(markdown: string): void {
    this.crepe.editor.action(replaceAll(markdown, true));
  }

  /** Focus the editor so typing starts immediately after an open. */
  focus(): void {
    this.crepe.editor.action((ctx) => {
      ctx.get(editorViewCtx).focus();
    });
  }
}
