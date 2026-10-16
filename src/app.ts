/**
 * Moda — application entry point.
 *
 * Owns the document state (path, text, dirty flag, view mode) and wires the
 * toolbar, keyboard shortcuts and status bar to it. The editor itself is
 * behind {@link MarkdownEditor}; the disk is behind the module in `tauri.ts`.
 */

import { isTauri } from '@tauri-apps/api/core';

import './styles.css';
import { MarkdownEditor } from './editor';
import { FindBar, TextareaFinder, type Finder } from './find-bar';
import { Outline } from './outline';
import { Sidebar } from './sidebar';
import { installSidebarResize } from './sidebar-resize';
import {
  confirmDiscard as askDiscard,
  describeFileError,
  fileExists,
  guardWindowClose,
  onMenuCommand,
  onOpenFilesRequested,
  pickAndReadDocument,
  pickSavePath,
  promptForText,
  readDocument,
  setWindowTitle,
  takePendingOpenFiles,
  tauriUpdateBackend,
  toFileError,
  writeDocument,
  type Document,
  type MenuCommand,
} from './tauri';
import { UpdateFlow } from './updater';

/** Which surface the document is being edited on. */
type ViewMode = 'wysiwyg' | 'source';

/** A document with no path yet. */
const UNTITLED_NAME = '未命名.md';

/** Markdown for a brand new document, so the editor starts somewhere. */
const EMPTY_DOCUMENT = '';

/**
 * How long typing must pause before the outline is rebuilt.
 *
 * Long enough that ordinary typing does not rebuild the list mid-word, short
 * enough that the panel feels live.
 */
const OUTLINE_REFRESH_DELAY_MS = 250;

/**
 * How long typing must pause before an edited document saves itself.
 *
 * Only documents that already have a path are saved this way: an untitled one
 * would need a save dialog, and a dialog appearing mid-sentence is worse than
 * waiting for the user to save.
 */
const AUTOSAVE_DELAY_MS = 2000;

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing element #${id}`);
  return element as T;
}

/**
 * The editor window's state and behaviour.
 *
 * Deliberately a plain class rather than a framework: the whole surface is a
 * handful of elements and a few transitions between them.
 */
export class ModaApp {
  private readonly editorRoot = required<HTMLDivElement>('editor');
  private readonly sourceArea = required<HTMLTextAreaElement>('source');
  private readonly emptyOverlay = required<HTMLDivElement>('empty');
  private readonly nameEl = required<HTMLSpanElement>('doc-name');
  private readonly dirtyEl = required<HTMLSpanElement>('doc-dirty');
  private readonly pathEl = required<HTMLSpanElement>('stat-path');
  private readonly wordsEl = required<HTMLSpanElement>('stat-words');
  private readonly charsEl = required<HTMLSpanElement>('stat-chars');
  private readonly stateEl = required<HTMLSpanElement>('stat-state');
  private readonly modeButton = required<HTMLButtonElement>('btn-mode');
  private readonly sidebarTitle = required<HTMLSpanElement>('sidebar-title');
  private readonly filesPanel = required<HTMLElement>('panel-files');
  private readonly outlinePanel = required<HTMLElement>('panel-outline');
  private readonly filesTab = required<HTMLButtonElement>('tab-files');
  private readonly outlineTab = required<HTMLButtonElement>('tab-outline');

  private editor: MarkdownEditor | undefined;
  private readonly sidebar: Sidebar;
  private readonly outline: Outline;
  private readonly findBar: FindBar;
  private readonly updateFlow: UpdateFlow;
  private readonly sourceFinder: TextareaFinder;
  /** Which sidebar panel is showing. */
  private sidebarView: 'files' | 'outline' = 'files';

  /** Absolute path of the open file, absent for a document never saved. */
  private path: string | undefined;
  /** Current text, in markdown, whichever surface produced it. */
  private text = EMPTY_DOCUMENT;
  /** Whether `text` differs from what is on disk. */
  private dirty = false;
  private mode: ViewMode = 'wysiwyg';
  /** Guard against re-entrant file operations from held-down shortcuts. */
  private busy = false;
  /**
   * Whether the user has begun a document.
   *
   * Distinct from "has content": a brand new empty document is started, and the
   * welcome overlay must not sit on top of it.
   */
  private started = false;
  /** Pending outline rebuild, while the user is still typing. */
  private outlineTimer: number | undefined;
  /** Pending auto-save, while the user is still typing. */
  private autosaveTimer: number | undefined;

  constructor() {
    // The sidebar reports back through the same public verbs the toolbar uses,
    // so it never needs access to document state.
    this.sidebar = new Sidebar(
      required<HTMLElement>('sidebar'),
      required<HTMLElement>('sidebar-tree'),
      {
        onOpenFile: (path) => {
          void this.openPathWithGuard(path);
        },
        onStatus: (message) => {
          this.setState(message);
        },
      },
    );
    installSidebarResize(
      required<HTMLElement>('sidebar'),
      required<HTMLElement>('sidebar-resizer'),
    );

    this.outline = new Outline(required<HTMLElement>('sidebar-outline'), {
      onGoTo: (pos) => {
        this.editor?.goToHeading(pos);
        // The click's own heading becomes the marked one straight away, rather
        // than waiting for the caret to move.
        this.outline.setActive(pos);
      },
    });

    this.sourceFinder = new TextareaFinder(this.sourceArea);
    this.findBar = new FindBar(required<HTMLElement>('findbar'), {
      finder: () => this.activeFinder(),
      onClose: () => {
        this.focusActiveSurface();
      },
    });

    // Only "检查更新…" drives this. Outside Tauri there is no updater, so the
    // backend is left out and the menu command does nothing.
    this.updateFlow = new UpdateFlow(required<HTMLElement>('updatebar'), {
      backend: isTauri() ? tauriUpdateBackend : undefined,
      confirmDiscard: () => this.confirmDiscard(),
    });
  }

  async start(): Promise<void> {
    this.bindToolbar();
    this.bindSource();
    this.bindEditorEngagement();
    this.bindShortcuts();
    this.bindCloseGuard();
    await this.bindHostEvents();

    // A document handed in from outside — a Finder double-click, or a path on the
    // command line — has already been opened by now, editor and all. Building the
    // empty start-up document on top of it would replace that content with
    // nothing, which is exactly what used to happen: the path was tracked, the
    // window title was right, and the editor was blank. So the empty editor is
    // only created when nothing is open yet.
    if (this.editor === undefined) {
      await this.createEditor(EMPTY_DOCUMENT);
    }
    this.render();

    // Exposed for the automated UI checks under `scripts/`, which drive the real
    // application in a browser and assert on its state. The webview loads only
    // bundled local content, so there is no untrusted script to hand this to.
    (window as unknown as { moda?: ModaApp }).moda = this;
  }

  /** The editor instance, for the automated checks. */
  get markdownEditor(): MarkdownEditor | undefined {
    return this.editor;
  }

  /** The update flow, for `scripts/check-updater.mjs`. */
  get updates(): UpdateFlow {
    return this.updateFlow;
  }

  // ------------------------------------------------------------------ editor

  private async createEditor(initialValue: string): Promise<void> {
    if (this.editor !== undefined) await this.editor.destroy();
    this.editor = new MarkdownEditor({
      root: this.editorRoot,
      initialValue,
      onChange: (markdown) => {
        this.text = markdown;
        this.setDirty(true);
        this.renderCounts();
        this.scheduleOutlineRefresh();
        this.scheduleAutosave();
      },
    });
    await this.editor.create();
    this.text = initialValue;
    this.refreshOutline();
  }

  // ------------------------------------------------------------------- state

  /** Show or hide the empty-state overlay and the editing surfaces. */
  private render(): void {
    // The overlay is only for the initial "nothing open yet" state. A document
    // counts as begun once the user starts one *or* the active surface turns out
    // to hold text — content can also arrive from a file or from an embedding
    // caller, and an overlay covering real content is the bug this guards
    // against.
    const liveText =
      this.mode === 'source'
        ? this.sourceArea.value
        : (this.editor?.getMarkdown() ?? this.text);
    this.emptyOverlay.hidden = this.started || liveText.length > 0;

    this.nameEl.textContent = this.displayName();
    this.dirtyEl.hidden = !this.dirty;
    this.pathEl.textContent = this.path ?? '';
    this.pathEl.title = this.path ?? '';
    this.modeButton.textContent = this.mode === 'wysiwyg' ? '源码' : '所见即所得';
    this.modeButton.setAttribute('aria-pressed', String(this.mode === 'source'));
    void this.syncWindowTitle();
    this.renderCounts();
  }

  private displayName(): string {
    if (this.path === undefined) return this.dirty ? '未命名.md' : '未命名';
    const parts = this.path.split('/');
    return parts[parts.length - 1] ?? this.path;
  }

  /**
   * Keep the macOS window title in step with the document.
   *
   * Falls back to the DOM title in a browser-only `vite dev` session, where
   * there is no Tauri host to talk to.
   */
  private async syncWindowTitle(): Promise<void> {
    const title = `${this.dirty ? '• ' : ''}${this.displayName()} — Moda`;
    if (!(await setWindowTitle(title))) document.title = title;
  }

  private setDirty(value: boolean): void {
    if (this.dirty === value) return;
    this.dirty = value;
    this.render();
  }

  private setState(message: string): void {
    this.stateEl.textContent = message;
  }

  private renderCounts(): void {
    const text = this.mode === 'source' ? this.sourceArea.value : this.text;
    // CJK has no spaces, so a whitespace split undercounts badly. Count CJK
    // ideographs individually and latin runs as words.
    const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
    const latin = text
      .replace(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ')
      .match(/[A-Za-z0-9_'’-]+/g);
    const words = (cjk?.length ?? 0) + (latin?.length ?? 0);
    this.wordsEl.textContent = `${words} 字`;
    this.charsEl.textContent = `${text.length} 字符`;
  }

  // -------------------------------------------------------------- file verbs

  /**
   * Open a path, asking about unsaved work first.
   *
   * The sidebar clicks through here rather than calling `openPath` directly, so
   * switching files from the tree cannot silently discard edits.
   */
  async openPathWithGuard(path: string): Promise<void> {
    if (this.busy) return;
    if (!(await this.confirmDiscard())) return;
    this.busy = true;
    try {
      await this.openPath(path);
    } finally {
      this.busy = false;
    }
  }

  /** Start a document with no path. Asks first if there is unsaved work. */
  async newDocument(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.path = undefined;
    this.started = true;
    await this.createEditor(EMPTY_DOCUMENT);
    this.dirty = false;
    this.render();
    this.findBar.refresh();
    this.setState('新建文档');
    this.focusActiveSurface();
  }

  /** Open a markdown file, after checking for unsaved work. */
  async openDocument(): Promise<void> {
    if (this.busy) return;
    if (!(await this.confirmDiscard())) return;
    this.busy = true;
    try {
      const document = await pickAndReadDocument();
      if (document === undefined) return;
      await this.loadDocument(document);
      this.setState(`已打开 ${document.name}`);
    } catch (error) {
      this.reportError(error);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Open a specific file, bypassing the dialog.
   *
   * Used when the app is launched with a path (Finder double-click), and by
   * automation that needs to load a document deterministically.
   */
  async openPath(path: string): Promise<void> {
    try {
      const document = await readDocument(path);
      await this.loadDocument(document);
      this.setState(`已打开 ${document.name}`);
    } catch (error) {
      this.reportError(error);
    }
  }

  private async loadDocument(document: Document): Promise<void> {
    this.path = document.path;
    this.text = document.contents;
    this.started = true;
    if (this.mode === 'source') {
      this.sourceArea.value = document.contents;
    } else if (this.editor !== undefined) {
      // Reuse the live editor rather than rebuilding it: the plugins survive,
      // and only the document and its undo history start afresh.
      this.editor.load(document.contents);
    } else {
      await this.createEditor(document.contents);
    }
    this.dirty = false;
    this.render();
    await this.showFolderOf(document.path);
    this.sidebar.setActivePath(document.path);
    // A different document has different headings; the outline must not keep
    // showing the previous one's.
    this.refreshOutline();
    this.findBar.refresh();
    this.focusActiveSurface();
  }

  /** Save to the current path, or ask for one when there is none. */
  async saveDocument(): Promise<void> {
    if (this.path === undefined) return this.saveDocumentAs();
    await this.writeTo(this.path);
  }

  /** Save to a path the user picks. */
  async saveDocumentAs(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const suggested = this.path ?? UNTITLED_NAME;
      const chosen = await pickSavePath(suggested);
      if (chosen === undefined) return;
      await this.writeTo(chosen);
    } catch (error) {
      this.reportError(error);
    } finally {
      this.busy = false;
    }
  }

  /** Save the open document once typing pauses, if it has somewhere to go. */
  private scheduleAutosave(): void {
    if (this.autosaveTimer !== undefined) window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      this.autosaveTimer = undefined;
      // A dialog may be open (save as, discard), or the document may have been
      // saved or replaced since the edit; any of those makes this save moot.
      if (!this.dirty || this.path === undefined || this.busy) return;
      void this.writeTo(this.path, '已自动保存');
    }, AUTOSAVE_DELAY_MS);
  }

  private async writeTo(path: string, savedLabel = '已保存'): Promise<void> {
    try {
      this.setState('保存中…');
      const contents = this.currentText();
      const saved = await writeDocument(path, contents);
      this.path = saved.path;
      // Typing can continue while the write is in flight. Only what was written
      // is clean; anything typed since still needs saving.
      this.dirty = this.currentText() !== contents;
      this.render();
      this.setState(`${savedLabel} ${saved.name}`);
    } catch (error) {
      this.reportError(error);
    }
  }

  /** The markdown currently on screen, from whichever surface is active. */
  private currentText(): string {
    if (this.mode === 'source') {
      this.text = this.sourceArea.value;
    } else if (this.editor !== undefined) {
      this.text = this.editor.getMarkdown();
    }
    return this.text;
  }

  // ------------------------------------------------------------- view modes

  /** Switch between the rendered surface and the raw markdown. */
  async toggleMode(): Promise<void> {
    if (this.mode === 'wysiwyg') {
      // Leaving the rendered view: take the latest text out first.
      const text = this.currentText();
      this.mode = 'source';
      this.sourceArea.value = text;
      this.sourceArea.hidden = false;
      this.editorRoot.hidden = true;
      // There is no rendered document to scroll to while editing raw text, so
      // the outline shows the document but stops offering navigation.
      this.outline.setEnabled(false, '源码模式下无法跳转');
      this.render();
      this.sourceArea.focus();
      this.findBar.refresh();
      this.setState('源码模式');
      return;
    }

    const text = this.sourceArea.value;
    this.mode = 'wysiwyg';
    this.sourceArea.hidden = true;
    this.editorRoot.hidden = false;
    await this.createEditor(text);
    this.outline.setEnabled(true);
    this.render();
    this.focusActiveSurface();
    this.findBar.refresh();
    this.setState('所见即所得');
  }

  // -------------------------------------------------------------------- find

  /** Open the find bar (⌘F). */
  find(): void {
    this.findBar.open();
  }

  /** Move to the next match (⌘G), or the previous one (⇧⌘G). */
  findStep(step: 1 | -1): void {
    this.findBar.step(step);
  }

  /** The surface the find bar searches: whichever one is showing. */
  private activeFinder(): Finder | undefined {
    if (this.mode === 'source') return this.sourceFinder;
    const editor = this.editor;
    if (editor === undefined) return undefined;
    return {
      find: (query) => editor.find(query),
      step: (step) => editor.findStep(step),
    };
  }

  private focusActiveSurface(): void {
    if (this.mode === 'source') {
      this.sourceArea.focus();
      return;
    }
    this.editor?.focus();
  }

  // --------------------------------------------------------------- prompting

  /**
   * Ask before throwing away unsaved changes.
   *
   * @returns true when the caller may proceed.
   */
  private async confirmDiscard(): Promise<boolean> {
    if (!this.dirty) return true;
    return askDiscard(
      `「${this.displayName()}」有未保存的更改，确定要放弃吗？`,
      '未保存的更改',
    );
  }

  private reportError(error: unknown): void {
    const described = describeFileError(toFileError(error));
    this.setState(described);
    console.error(error);
  }

  // ------------------------------------------------------------------ wiring

  // ---------------------------------------------------------------- sidebar

  /**
   * Ask the user for a workspace folder.
   *
   * Opening a folder implies wanting to see it, so the sidebar reveals itself.
   */
  async openFolder(): Promise<void> {
    if (await this.sidebar.chooseFolder()) {
      this.sidebar.setVisible(true);
      this.syncSidebarTitle();
    }
  }

  /**
   * Run the command a native menu item stands for.
   *
   * Public because it is the seam the native menu's event listener calls. The
   * menu bar itself is built in Rust, so this is the only place the frontend half
   * of a menu click can be exercised — `scripts/check-menu.mjs` drives it.
   *
   * Every branch is the same method the toolbar button and the keyboard shortcut
   * call, so the menu cannot behave differently from the rest of the app.
   */
  runMenuCommand(command: MenuCommand): void {
    switch (command) {
      case 'new-document':
        void this.newDocument();
        return;
      case 'open-document':
        void this.openDocument();
        return;
      case 'open-folder':
        void this.openFolder();
        return;
      case 'save-document':
        void this.saveDocument();
        return;
      case 'save-as':
        void this.saveDocumentAs();
        return;
      case 'refresh-tree':
        void this.refreshFolder();
        return;
      case 'toggle-source':
        void this.toggleMode();
        return;
      case 'toggle-sidebar':
        this.toggleSidebar();
        return;
      case 'show-outline':
        this.sidebar.setVisible(true);
        this.setSidebarView('outline');
        return;
      case 'insert-link':
        this.insertLink();
        return;
      case 'find':
        this.find();
        return;
      case 'find-next':
        this.findStep(1);
        return;
      case 'find-previous':
        this.findStep(-1);
        return;
      case 'about':
        // The native About panel already showed the version; this is the status
        // line's nod to the same information.
        this.setState(`Moda — 所见即所得的 Markdown 编辑器`);
        return;
      case 'check-for-updates':
        void this.updateFlow.checkForUpdates();
        return;
    }
  }

  /**
   * Subscribe to everything the host sends: documents from outside the app, and
   * native menu choices.
   *
   * The document queue is drained first, then the listeners are installed,
   * because a cold launch races start-up: draining after subscribing could miss
   * a path delivered in the gap.
   *
   * The drained document is awaited before returning. Start-up creates an empty
   * editor right after this call, and an *unawaited* open would race it — the
   * content would load and then be replaced by the empty document, which is
   * exactly the bug this ordering guards against.
   */
  private async bindHostEvents(): Promise<void> {
    try {
      await this.offerExternalPaths(await takePendingOpenFiles());
    } catch {
      // No Tauri host; nothing was queued.
    }

    await onOpenFilesRequested((paths) => {
      // Later deliveries are not racing start-up, so they need no awaiting.
      void this.offerExternalPaths(paths);
    });

    // The menu is available from the first moment the window appears, so this
    // subscription is installed alongside the document one.
    await onMenuCommand((command) => {
      this.runMenuCommand(command);
    });
  }

  /**
   * Open the first of a batch of externally supplied paths.
   *
   * There is one document surface, so a multi-file selection opens the first and
   * says so rather than silently discarding the rest.
   */
  private async offerExternalPaths(paths: string[]): Promise<void> {
    const [first, ...rest] = paths;
    if (first === undefined) return;
    await this.openPathWithGuard(first);
    if (rest.length > 0) {
      this.setState(`一次只能打开一个文件，已打开第一个（另有 ${rest.length} 个未打开）`);
    }
  }

  /**
   * Load a folder without asking, as the workspace.
   *
   * Used when a folder arrives from outside the app (or from automation) and
   * there is nothing to choose.
   *
   * @param path - absolute path of the folder.
   * @returns whether it loaded.
   */
  async loadFolder(path: string): Promise<boolean> {
    const loaded = await this.sidebar.loadFolder(path);
    if (loaded) {
      this.sidebar.setVisible(true);
      this.syncSidebarTitle();
    }
    return loaded;
  }

  /**
   * Make the file tree show the folder a document lives in.
   *
   * A file opened from Finder or the open dialog brings its folder along, the
   * way Typora does, so its neighbours are one click away. A file already
   * inside the workspace — one picked from the tree itself — leaves the tree
   * alone, or clicking into a subfolder would narrow the workspace each time.
   * Whether the sidebar is showing is the user's call and is left as it is.
   */
  private async showFolderOf(path: string): Promise<void> {
    const root = this.sidebar.rootPath;
    if (root !== undefined && path.startsWith(`${root}/`)) return;
    const folder = path.slice(0, path.lastIndexOf('/'));
    if (folder === '') return;
    if (await this.sidebar.loadFolder(folder)) this.syncSidebarTitle();
  }

  /** Re-read the workspace folder. */
  async refreshFolder(): Promise<void> {
    await this.sidebar.refresh();
  }

  /** Show or hide the file tree. */
  toggleSidebar(): void {
    this.sidebar.setVisible(!this.sidebar.visible);
    if (this.sidebar.visible) this.syncSidebarTitle();
  }

  /** Keep the sidebar header showing the workspace folder's name. */
  private syncSidebarTitle(): void {
    const root = this.sidebar.rootPath;
    if (root === undefined) {
      this.sidebarTitle.textContent = '文件';
      return;
    }
    const parts = root.split('/');
    this.sidebarTitle.textContent = parts[parts.length - 1] ?? '文件';
  }

  // ----------------------------------------------------------------- outline

  /**
   * Rebuild the outline from the editor's current headings.
   *
   * Cheap enough to call directly on document load; typing goes through
   * {@link scheduleOutlineRefresh} instead, because rebuilding the list on every
   * keystroke would churn the DOM for no visible benefit.
   */
  refreshOutline(): void {
    if (this.editor === undefined) {
      this.outline.setEntries([]);
      return;
    }
    this.outline.setEntries(this.editor.headings());
  }

  /** Rebuild the outline once typing pauses. */
  private scheduleOutlineRefresh(): void {
    if (this.outlineTimer !== undefined) window.clearTimeout(this.outlineTimer);
    this.outlineTimer = window.setTimeout(() => {
      this.outlineTimer = undefined;
      this.refreshOutline();
    }, OUTLINE_REFRESH_DELAY_MS);
  }

  /** Show the file tree or the outline. */
  setSidebarView(view: 'files' | 'outline'): void {
    this.sidebarView = view;
    const showFiles = view === 'files';
    this.filesPanel.hidden = !showFiles;
    this.outlinePanel.hidden = showFiles;
    this.filesTab.setAttribute('aria-selected', String(showFiles));
    this.outlineTab.setAttribute('aria-selected', String(!showFiles));
    if (!showFiles) this.refreshOutline();
  }

  /** Which sidebar panel is showing, for the automated checks. */
  get currentSidebarView(): 'files' | 'outline' {
    return this.sidebarView;
  }

  private bindToolbar(): void {
    required<HTMLButtonElement>('btn-new').addEventListener('click', () => {
      void this.newDocument();
    });
    required<HTMLButtonElement>('btn-empty-new').addEventListener('click', () => {
      void this.newDocument();
    });
    for (const id of ['btn-open', 'btn-empty-open']) {
      required<HTMLButtonElement>(id).addEventListener('click', () => {
        void this.openDocument();
      });
    }
    required<HTMLButtonElement>('btn-save').addEventListener('click', () => {
      void this.saveDocument();
    });
    required<HTMLButtonElement>('btn-save-as').addEventListener('click', () => {
      void this.saveDocumentAs();
    });
    this.modeButton.addEventListener('click', () => {
      void this.toggleMode();
    });

    required<HTMLButtonElement>('btn-sidebar').addEventListener('click', () => {
      this.toggleSidebar();
    });
    for (const id of ['btn-sidebar-folder', 'btn-empty-folder']) {
      required<HTMLButtonElement>(id).addEventListener('click', () => {
        void this.openFolder();
      });
    }
    required<HTMLButtonElement>('btn-sidebar-refresh').addEventListener('click', () => {
      void this.refreshFolder();
    });

    this.filesTab.addEventListener('click', () => {
      this.setSidebarView('files');
    });
    this.outlineTab.addEventListener('click', () => {
      this.setSidebarView('outline');
    });
  }

  private bindSource(): void {
    this.sourceArea.addEventListener('input', () => {
      this.markStarted();
      this.setDirty(true);
      this.renderCounts();
      this.scheduleAutosave();
    });
  }

  /**
   * Treat the first intentional interaction with a surface as "the document has
   * begun", which dismisses the welcome overlay.
   *
   * Bound to the editor host rather than to the editor instance because the
   * instance is replaced on every mode switch.
   */
  private bindEditorEngagement(): void {
    const begin = () => this.markStarted();
    this.editorRoot.addEventListener('input', begin);
    this.editorRoot.addEventListener('paste', begin);
    this.editorRoot.addEventListener('pointerdown', begin);
    this.editorRoot.addEventListener('keydown', begin);
  }

  /** Dismiss the welcome overlay the first time it is warranted. */
  private markStarted(): void {
    if (this.started) return;
    this.started = true;
    this.render();
  }

  /**
   * Apply a link to the selection, asking for the URL (Typora's `⌘K`).
   *
   * Milkdown's link command cannot be bound to a key directly: its `href`
   * attribute is required, so the command throws when invoked without one. The
   * URL therefore has to come from the user first.
   */
  private insertLink(): void {
    if (this.mode !== 'wysiwyg' || this.editor === undefined) {
      this.setState('链接只支持在所见即所得模式下插入');
      return;
    }
    const existing = this.editor.currentLinkHref();
    const href = promptForText('链接地址：', existing ?? 'https://');
    if (href === undefined) return;
    if (this.editor.setLink(href)) {
      this.setDirty(true);
      this.setState('已插入链接');
    } else {
      this.setState('请先选中要加链接的文字');
    }
    this.editor.focus();
  }

  private bindShortcuts(): void {
    window.addEventListener('keydown', (event) => {
      const key = event.key.toLowerCase();
      // ⌃F as well as ⌘F, for hands used to it from other platforms. It gives up
      // the Emacs-style "forward one character", which ← → already cover.
      if (key === 'f' && !event.shiftKey && !event.altKey && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.find();
        return;
      }
      if (!event.metaKey) return;

      if (key === 'g') {
        event.preventDefault();
        this.findStep(event.shiftKey ? -1 : 1);
        return;
      }

      // Shift+⌘S must be checked before ⌘S, and ⇧⌘E is checked before the
      // plain-`e` bindings Milkdown owns (inline code).
      if (key === 's' && event.shiftKey) {
        event.preventDefault();
        void this.saveDocumentAs();
        return;
      }
      if (key === 'e' && event.shiftKey) {
        event.preventDefault();
        this.toggleSidebar();
        return;
      }
      if (key === 'f' && event.shiftKey) {
        event.preventDefault();
        void this.openFolder();
        return;
      }
      if (key === 's') {
        event.preventDefault();
        void this.saveDocument();
        return;
      }
      if (key === 'o') {
        event.preventDefault();
        void this.openDocument();
        return;
      }
      if (key === 'n') {
        event.preventDefault();
        void this.newDocument();
        return;
      }
      if (key === 'k') {
        event.preventDefault();
        this.insertLink();
        return;
      }
      if (key === '/') {
        event.preventDefault();
        void this.toggleMode();
      }
    });
  }

  /**
   * Warn on close when the document is dirty.
   *
   * Tauri's `onCloseRequested` lets the app veto the close; without this the
   * window would disappear and take unsaved work with it.
   */
  private bindCloseGuard(): void {
    void guardWindowClose(async () => {
      if (!this.dirty) return true;
      return askDiscard('有未保存的更改，确定要退出吗？', '未保存的更改');
    });
  }
}

// Markdown files can also arrive as a `?file=` query parameter, which is how a
// Finder double-click reaches the webview.
export async function launch(): Promise<void> {
  const app = new ModaApp();
  await app.start();

  const launchedWith = new URLSearchParams(window.location.search).get('file');
  if (launchedWith !== null) {
    try {
      if (await fileExists(launchedWith)) await app.openPath(launchedWith);
    } catch {
      // A path that cannot be read is not worth interrupting startup for.
    }
  }
}
