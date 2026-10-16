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
