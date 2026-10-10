/**
 * The sidebar: a file tree for one workspace folder.
 *
 * Owns its own DOM inside a host element the app provides, plus the expanded and
 * selected state that makes the tree feel like a file browser. The app talks to
 * it through four methods — open a folder, refresh, mark the active file, and
 * toggle visibility — so the sidebar never reaches into document state.
 */

import {
  describeFileError,
  pickFolder,
  readDirectoryTree,
  toFileError,
  type DirectoryTree,
  type TreeEntry,
} from './tauri';

/** What the sidebar reports back to the app. */
export interface SidebarHandlers {
  /** The user picked a file to open. */
  onOpenFile: (path: string) => void;
  /** Something changed that the status bar should show. */
  onStatus: (message: string) => void;
}

/** A folder that came back with more content than the backend was willing to read. */
const TRUNCATION_NOTICE = '文件夹内容过多，只显示了前一部分';

export class Sidebar {
  /**
   * The element whose `hidden` attribute shows or hides the whole sidebar.
   *
   * Kept separate from {@link treeHost} on purpose: the tree is rendered into an
   * inner container, so using that one for visibility would leave the outer
   * panel — which is the element that actually starts hidden — hidden forever.
   */
  private readonly panel: HTMLElement;
  /** The element the tree is rendered into. */
  private readonly treeHost: HTMLElement;
  private readonly handlers: SidebarHandlers;

  /** The workspace root, once one has been chosen. */
  private root: DirectoryTree | undefined;
  /** Paths of the directories currently expanded. */
  private readonly expanded = new Set<string>();
  /** Path of the document to mark as current. */
  private activePath: string | undefined;

  constructor(
    panel: HTMLElement,
    treeHost: HTMLElement,
    handlers: SidebarHandlers,
  ) {
    this.panel = panel;
    this.treeHost = treeHost;
    this.handlers = handlers;
  }

  /** Whether a workspace folder is loaded. */
  get hasFolder(): boolean {
    return this.root !== undefined;
  }

  /** Path of the workspace root, when one is loaded. */
  get rootPath(): string | undefined {
    return this.root?.path;
  }

  /**
   * Ask the user for a folder and load it.
   *
   * @returns whether a folder ended up loaded.
   */
  async chooseFolder(): Promise<boolean> {
    const chosen = await pickFolder();
    if (chosen === undefined) return false;
    return this.loadFolder(chosen);
  }

  /**
   * Load a folder as the workspace.
   *
   * @param path - absolute path of the folder.
   * @returns whether it loaded.
   */
  async loadFolder(path: string): Promise<boolean> {
    try {
      const tree = await readDirectoryTree(path);
      this.root = tree;
      // Expand the root's immediate children so a shallow workspace is usable
      // without a click, but leave deeper levels collapsed.
      this.expanded.clear();
      for (const entry of tree.entries) {
        if (entry.isDirectory && entry.children.length > 0) {
          this.expanded.add(entry.path);
        }
      }
      this.render();
      this.handlers.onStatus(
        tree.truncated
          ? `已打开 ${tree.name}（${TRUNCATION_NOTICE}）`
          : `已打开 ${tree.name}`,
      );
      return true;
    } catch (error) {
      this.handlers.onStatus(describeFileError(toFileError(error)));
      return false;
    }
  }

  /** Re-read the workspace folder, keeping the expanded set. */
  async refresh(): Promise<void> {
    if (this.root === undefined) return;
    try {
      this.root = await readDirectoryTree(this.root.path);
      this.render();
      this.handlers.onStatus('已刷新文件树');
    } catch (error) {
      this.handlers.onStatus(describeFileError(toFileError(error)));
    }
  }

  /**
   * Mark one file as the current document.
   *
   * Also expands its ancestors, so navigating to a nested file from elsewhere
   * does not leave it hidden inside a collapsed folder.
   */
  setActivePath(path: string | undefined): void {
    this.activePath = path;
    if (path !== undefined) this.expandAncestors(path);
    this.render();
  }

  /** Show or hide the sidebar. */
  setVisible(visible: boolean): void {
    this.panel.hidden = !visible;
  }

  /** Whether the sidebar is currently shown. */
  get visible(): boolean {
    return !this.panel.hidden;
  }

  // ------------------------------------------------------------------ internal

  /** Expand every directory on the way to `path`, within the loaded tree. */
  private expandAncestors(path: string): void {
    if (this.root === undefined) return;
    const walk = (entries: TreeEntry[], trail: string[]): boolean => {
      for (const entry of entries) {
        if (entry.path === path) {
          for (const ancestor of trail) this.expanded.add(ancestor);
          return true;
        }
        if (entry.isDirectory && walk(entry.children, [...trail, entry.path])) {
          return true;
        }
      }
      return false;
    };
    walk(this.root.entries, [this.root.path]);
  }

  /** Toggle a directory open or closed. */
  private toggle(path: string): void {
    if (this.expanded.has(path)) this.expanded.delete(path);
    else this.expanded.add(path);
    this.render();
  }

  private render(): void {
    this.treeHost.replaceChildren();

    if (this.root === undefined) {
      this.treeHost.append(this.renderEmpty());
      return;
    }

    const list = document.createElement('ul');
    list.className = 'tree';
    list.setAttribute('role', 'tree');

    if (this.root.truncated) {
      const notice = document.createElement('li');
      notice.className = 'tree__notice';
      notice.textContent = TRUNCATION_NOTICE;
      list.append(notice);
    }

    for (const entry of this.root.entries) {
      list.append(this.renderEntry(entry, 0));
    }

    this.treeHost.append(list);
  }

  /** The "no folder yet" state. */
  private renderEmpty(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'tree__empty';

    const hint = document.createElement('p');
    hint.className = 'tree__empty-hint';
    hint.textContent = '未打开文件夹';

    const button = document.createElement('button');
    button.className = 'btn btn--primary';
    button.textContent = '打开文件夹…';
    button.addEventListener('click', () => {
      void this.chooseFolder();
    });

    wrapper.append(hint, button);
    return wrapper;
  }

  /** One row, plus its children when it is an expanded directory. */
  private renderEntry(entry: TreeEntry, depth: number): HTMLElement {
    const item = document.createElement('li');
    item.className = 'tree__item';
    item.setAttribute('role', 'treeitem');
    if (entry.isDirectory) item.setAttribute('aria-expanded', String(this.expanded.has(entry.path)));

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'tree__row';
    if (!entry.isDirectory) row.classList.add('tree__row--file');
    if (!entry.isDirectory && !entry.isMarkdown) row.classList.add('tree__row--inert');
    if (entry.path === this.activePath) row.classList.add('tree__row--active');
    // Indentation is a visual concern; the flat structure keeps CSS simple.
    row.style.paddingLeft = `${8 + depth * 14}px`;
    if (entry.isDirectory) row.title = `${entry.name}（展开或折叠）`;
    else row.title = entry.path;

    const twisty = document.createElement('span');
    twisty.className = 'tree__twisty';
    twisty.textContent = entry.isDirectory ? (this.expanded.has(entry.path) ? '▾' : '▸') : '';
    // The twisty is decorative; the row itself carries the accessible state.
    twisty.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'tree__label';
    label.textContent = entry.name;

    row.append(twisty, label);
    row.addEventListener('click', () => {
      if (entry.isDirectory) {
        this.toggle(entry.path);
        return;
      }
      if (!entry.isMarkdown) {
        this.handlers.onStatus(`无法打开：${entry.name} 不是 Markdown 文件`);
        return;
      }
      this.handlers.onOpenFile(entry.path);
    });

    item.append(row);

    if (entry.isDirectory && this.expanded.has(entry.path) && entry.children.length > 0) {
      const children = document.createElement('ul');
      children.className = 'tree';
      children.setAttribute('role', 'group');
      for (const child of entry.children) {
        children.append(this.renderEntry(child, depth + 1));
      }
      item.append(children);
    }

    return item;
  }
}
