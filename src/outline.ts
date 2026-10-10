/**
 * The document outline: the current document's headings, as navigation.
 *
 * Renders into a host element the app provides and reports clicks back through a
 * single callback, so it holds no document state of its own — the app hands it a
 * fresh list whenever the document changes.
 *
 * Headings are indented by level but drawn as a flat list rather than nested
 * groups. A document may legally go from `h1` straight to `h4`, and nesting
 * would either misrepresent that or insert levels that are not in the document;
 * indentation shows the shape without inventing structure.
 */

import type { OutlineEntry } from './editor';

/** What the outline reports back to the app. */
export interface OutlineHandlers {
  /** The user picked a heading to jump to. */
  onGoTo: (pos: number) => void;
}

export class Outline {
  private readonly host: HTMLElement;
  private readonly handlers: OutlineHandlers;
  private entries: OutlineEntry[] = [];
  /** The heading the caret is currently in, if the app has said. */
  private activePos: number | undefined;
  /**
   * Whether jumping is possible.
   *
   * Source mode has no rendered document to scroll, so the list still describes
   * the document but its entries do nothing. Disabling them says so; leaving
   * them live would offer a click that silently does nothing, and hiding the
   * panel would take away a useful overview.
   */
  private enabled = true;
  /** Why the outline is disabled, shown to the user. */
  private disabledNote: string | undefined;

  constructor(host: HTMLElement, handlers: OutlineHandlers) {
    this.host = host;
    this.handlers = handlers;
  }

  /**
   * Enable or disable navigation.
   *
   * @param enabled - whether clicking a heading can scroll to it.
   * @param note - why not, when disabled.
   */
  setEnabled(enabled: boolean, note?: string): void {
    this.enabled = enabled;
    this.disabledNote = enabled ? undefined : note;
    this.render();
  }

  /**
   * Replace the displayed headings.
   *
   * @param entries - the document's headings, in document order.
   */
  setEntries(entries: OutlineEntry[]): void {
    this.entries = entries;
    // A position that is no longer present (the heading was deleted) must not
    // keep a stale highlight.
    if (this.activePos !== undefined && !entries.some((e) => e.pos === this.activePos)) {
      this.activePos = undefined;
    }
    this.render();
  }

  /** Mark one heading as the current position. */
  setActive(pos: number | undefined): void {
    if (this.activePos === pos) return;
    this.activePos = pos;
    this.render();
  }

  /** How many headings are shown, for the automated checks. */
  get count(): number {
    return this.entries.length;
  }

  private render(): void {
    this.host.replaceChildren();

    if (!this.enabled && this.disabledNote !== undefined) {
      const note = document.createElement('p');
      note.className = 'outline__empty';
      note.textContent = this.disabledNote;
      this.host.append(note);
    }

    if (this.entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'outline__empty';
      empty.textContent = '当前文档没有标题';
      this.host.append(empty);
      return;
    }

    const list = document.createElement('ul');
    list.className = 'outline';
    list.setAttribute('role', 'tree');

    for (const entry of this.entries) {
      const item = document.createElement('li');
      item.className = 'outline__item';
      item.setAttribute('role', 'treeitem');

      const row = document.createElement('button');
      row.type = 'button';
      row.className = `outline__row outline__row--h${entry.level}`;
      if (entry.pos === this.activePos) row.classList.add('outline__row--active');
      if (!this.enabled) row.classList.add('outline__row--disabled');
      row.disabled = !this.enabled;
      // Level 1 sits flush; each deeper level steps in.
      row.style.paddingLeft = `${8 + (entry.level - 1) * 12}px`;
      row.title = entry.text;
      row.textContent = entry.text.length > 0 ? entry.text : '（空标题）';
      row.addEventListener('click', () => {
        if (!this.enabled) return;
        this.handlers.onGoTo(entry.pos);
      });

      item.append(row);
      list.append(item);
    }

    this.host.append(list);
  }
}
