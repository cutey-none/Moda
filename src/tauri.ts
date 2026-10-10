/**
 * The bridge to the Rust side: native dialogs plus the file commands.
 *
 * Everything that touches the disk goes through here, so the rest of the
 * frontend never sees an `invoke` string and the command names live in one
 * place.
 */

import { invoke } from '@tauri-apps/api/core';
import { ask, open, save } from '@tauri-apps/plugin-dialog';

/** A markdown document as the backend reports it. */
export interface Document {
  path: string;
  name: string;
  contents: string;
  modifiedMs: number;
}

/** One file or directory in the sidebar's tree. */
export interface TreeEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  /** Whether the app can open this as a document. */
  isMarkdown: boolean;
  size: number;
  modifiedMs: number;
  children: TreeEntry[];
}

/** A folder's tree, as the backend reports it. */
export interface DirectoryTree {
  path: string;
  name: string;
  entries: TreeEntry[];
  /** Whether the entry cap was reached, so the sidebar can say so. */
  truncated: boolean;
}

/**
 * Why a file operation failed. Mirrors the tagged enum Rust serializes, so the
 * UI can branch on `kind` instead of matching message text.
 */
export type FileErrorKind = 'notFound' | 'io' | 'notUtf8' | 'notADirectory';

export interface FileError {
  kind: FileErrorKind;
  path: string;
  message?: string;
}

/** Marks the end of a markdown document, for the open dialog's filter. */
const MARKDOWN_FILTER = [
  {
    name: 'Markdown',
    extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'],
  },
];

/**
 * Narrow an unknown thrown value to a {@link FileError}.
 *
 * `invoke` rejects with whatever the command serialized, but a transport-level
 * failure surfaces as a plain string, so both shapes have to be handled.
 */
export function toFileError(error: unknown): FileError {
  if (typeof error === 'object' && error !== null && 'kind' in error) {
    return error as FileError;
  }
  return { kind: 'io', path: '', message: String(error) };
}

/** A human-readable explanation of a failed file operation. */
export function describeFileError(error: FileError): string {
  switch (error.kind) {
    case 'notFound':
      return `文件不存在：${error.path}`;
    case 'notUtf8':
      return `无法打开：不是有效的 UTF-8 文本文件`;
    case 'notADirectory':
      return `不是文件夹：${error.path}`;
    case 'io':
    default:
      return `操作失败：${error.message ?? error.path}`;
  }
}

/**
 * Ask the user for a folder to use as the sidebar's workspace.
 *
 * @returns the chosen absolute path, or undefined when cancelled.
 */
export async function pickFolder(): Promise<string | undefined> {
  const selected = await open({ directory: true, multiple: false });
  if (selected === null || selected === undefined) return undefined;
  const path = Array.isArray(selected) ? selected[0] : selected;
  return typeof path === 'string' ? path : undefined;
}

/** Read a folder's tree for the sidebar. */
export function readDirectoryTree(path: string): Promise<DirectoryTree> {
  return invoke<DirectoryTree>('read_directory_tree', { path });
}

/**
 * Take the documents that arrived before this call, clearing the queue.
 *
 * A cold launch — a Finder double-click while Moda is closed — can deliver the
 * path before the webview exists. Those paths wait in the backend until this
 * asks for them, which makes start-up deterministic instead of a race against a
 * timer.
 *
 * @returns the absolute paths to open, in arrival order.
 */
export function takePendingOpenFiles(): Promise<string[]> {
  return invoke<string[]>('take_pending_open_files');
}

/**
 * The commands the native menu can ask for.
 *
 * Mirrors the `MenuCommand` enum in `src-tauri/src/menu.rs`; both sides are
 * covered by a test that pins these strings, so a rename on one side cannot pass
 * unnoticed.
 */
export type MenuCommand =
  | 'new-document'
  | 'open-document'
  | 'open-folder'
  | 'save-document'
  | 'save-as'
  | 'refresh-tree'
  | 'toggle-source'
  | 'toggle-sidebar'
  | 'show-outline'
  | 'insert-link'
  | 'about';

/**
 * Subscribe to native menu choices.
 *
 * @param onCommand - called with the command a menu item stands for.
 * @returns whether the subscription was installed.
 */
export async function onMenuCommand(
  onCommand: (command: MenuCommand) => void,
): Promise<boolean> {
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen<{ command: MenuCommand }>('moda://menu', (event) => {
      onCommand(event.payload.command);
    });
    return true;
  } catch {
    // No Tauri host (browser-only `vite dev`); there is no menu to listen to.
    return false;
  }
}

/**
 * Subscribe to documents that arrive from outside the app — a Finder
 * double-click, or a path given on the command line.
 *
 * @param onPaths - called with the absolute paths to open.
 * @returns whether the subscription was installed. False in a plain browser,
 *   where there is no host to emit the event.
 */
export async function onOpenFilesRequested(
  onPaths: (paths: string[]) => void,
): Promise<boolean> {
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen<{ paths: string[] }>('moda://open-files', (event) => {
      onPaths(event.payload.paths);
    });
    return true;
  } catch {
    // No Tauri host (browser-only `vite dev`); there is nothing to listen to.
    return false;
  }
}

/**
 * Ask the user for a markdown file and read it.
 *
 * @returns the document, or undefined when the user cancelled.
 */
export async function pickAndReadDocument(): Promise<Document | undefined> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: MARKDOWN_FILTER,
  });
  if (selected === null || selected === undefined) return undefined;

  // `open` returns a string for a single selection. The array branch keeps the
  // types honest if `multiple` is ever flipped.
  const path = Array.isArray(selected) ? selected[0] : selected;
  if (typeof path !== 'string') return undefined;

  return readDocument(path);
}

/**
 * Ask the user where to save, suggesting the current name.
 *
 * @param suggestedName - the file name to pre-fill.
 * @returns the chosen absolute path, or undefined when the user cancelled.
 */
export async function pickSavePath(
  suggestedName: string,
): Promise<string | undefined> {
  const chosen = await save({
    defaultPath: suggestedName,
    filters: MARKDOWN_FILTER,
  });
  return chosen ?? undefined;
}

/** Read a markdown file by absolute path. */
export function readDocument(path: string): Promise<Document> {
  return invoke<Document>('read_document', { path });
}

/** Write markdown to an absolute path, creating parent directories. */
export function writeDocument(
  path: string,
  contents: string,
): Promise<Document> {
  return invoke<Document>('save_document', { path, contents });
}

/** Whether a path still exists as a regular file. */
export function fileExists(path: string): Promise<boolean> {
  return invoke<boolean>('file_exists', { path });
}

/**
 * Ask the user to confirm something that cannot be undone, such as discarding
 * unsaved changes.
 *
 * @param message - the question to put to the user.
 * @param title - the dialog's title bar text.
 * @returns true when the user confirmed.
 */
export function confirmDiscard(
  message: string,
  title: string,
): Promise<boolean> {
  return ask(message, { title, kind: 'warning' });
}

/**
 * Ask the user for a single line of text.
 *
 * The dialog plugin has no text prompt, so the webview's own `prompt` is used.
 * It blocks the render loop, which is why callers only reach it from an explicit
 * user action such as pressing `⌘K`.
 *
 * @param message - what to ask for.
 * @param defaultValue - the value to pre-fill.
 * @returns the entered text, or undefined when cancelled or left blank.
 */
export function promptForText(
  message: string,
  defaultValue = '',
): string | undefined {
  const answer = window.prompt(message, defaultValue);
  if (answer === null) return undefined;
  const trimmed = answer.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Set the native window title.
 *
 * Resolves to false when there is no Tauri host (a plain `vite dev` session in
 * a browser), so callers can fall back to `document.title`.
 */
export async function setWindowTitle(title: string): Promise<boolean> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setTitle(title);
    return true;
  } catch {
    return false;
  }
}

/**
 * Register a handler that runs when the user tries to close the window.
 *
 * @param onCloseRequested - called on every close attempt; the window closes
 *   unless the callback resolves false.
 * @returns whether the guard was installed.
 */
export async function guardWindowClose(
  onCloseRequested: () => Promise<boolean>,
): Promise<boolean> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().onCloseRequested(async (event) => {
      if (!(await onCloseRequested())) event.preventDefault();
    });
    return true;
  } catch {
    return false;
  }
}
