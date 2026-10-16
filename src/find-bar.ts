/**
 * The find bar (⌘F).
 *
 * A small strip over the top-right of the editing surface: a field, a match
 * count, and previous / next / close. It does no searching itself — it hands
 * the query to a {@link Finder}, which is whichever surface is showing, so one
 * bar serves both the rendered document and the raw markdown.
 */

import type { FindResult } from './editor';

/** A surface that can be searched. */
export interface Finder {
  /** Find every match of `query`, make the first current, and report. */
  find(query: string): FindResult;
  /** Move to the next match, or the previous one, wrapping at the ends. */
  step(step: 1 | -1): FindResult;
}

export interface FindBarOptions {
  /** The surface to search, asked afresh on every search. */
  finder: () => Finder | undefined;
  /** Called after the bar closes, to give the keyboard back to the document. */
  onClose: () => void;
}

/** The find bar's behaviour, bound to its markup in `index.html`. */
export class FindBar {
  private readonly input: HTMLInputElement;
  private readonly count: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly options: FindBarOptions,
  ) {
    const part = <T extends HTMLElement>(selector: string): T => {
      const element = root.querySelector<T>(selector);
      if (element === null) throw new Error(`find bar is missing ${selector}`);
      return element;
    };
    this.input = part<HTMLInputElement>('.findbar__input');
    this.count = part<HTMLElement>('.findbar__count');

    this.input.addEventListener('input', () => {
      this.refresh();
    });
    this.input.addEventListener('keydown', (event) => {
      // An IME composing a word uses Enter to commit it; that is not a search.
      if (event.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        this.step(event.shiftKey ? -1 : 1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.close();
      }
    });
    part<HTMLButtonElement>('.findbar__prev').addEventListener('click', () => {
      this.step(-1);
    });
    part<HTMLButtonElement>('.findbar__next').addEventListener('click', () => {
      this.step(1);
    });
    part<HTMLButtonElement>('.findbar__close').addEventListener('click', () => {
      this.close();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /**
   * Show the bar with the keyboard in its field.
   *
   * The previous query is kept and selected, so ⌘F then Enter finds the same
   * thing again and ⌘F then typing replaces it.
   */
  open(): void {
    this.root.hidden = false;
    this.input.focus();
    this.input.select();
    this.refresh();
  }

  /** Hide the bar and clear the highlights; the last match stays selected. */
  close(): void {
    if (!this.isOpen) return;
    this.root.hidden = true;
    this.options.finder()?.find('');
    this.options.onClose();
  }

  /**
   * Run the query again, from the first match.
   *
   * For when the surface behind the bar changes — another document, the other
   * view mode — and the old matches no longer describe it.
   */
  refresh(): void {
    if (!this.isOpen) return;
    this.show(this.options.finder()?.find(this.input.value));
  }

  /** Move to the next match, or the previous one. */
  step(step: 1 | -1): void {
    if (!this.isOpen) {
      this.open();
      return;
    }
    this.show(this.options.finder()?.step(step));
  }

  private show(result: FindResult | undefined): void {
    if (this.input.value === '' || result === undefined) {
      this.count.textContent = '';
    } else if (result.count === 0) {
      this.count.textContent = '无结果';
    } else {
      this.count.textContent = `${result.current + 1}/${result.count}`;
    }
    this.root.classList.toggle(
      'findbar--missing',
      this.input.value !== '' && result?.count === 0,
    );
  }
}

/**
 * A {@link Finder} over the source-mode textarea.
 *
 * A textarea cannot paint highlights, so the current match is shown by
 * selecting it. The textarea has to hold focus for the selection to scroll into
 * view, so focus is lent to it for that moment and handed straight back to the
 * find field.
 */
export class TextareaFinder implements Finder {
  private query = '';
  private current = -1;

  constructor(private readonly area: HTMLTextAreaElement) {}

  find(query: string): FindResult {
    this.query = query;
    this.current = 0;
    return this.select();
  }

  step(step: 1 | -1): FindResult {
    this.current += step;
    return this.select();
  }

  private select(): FindResult {
    // Matched afresh each time: the user may have typed into the source since.
    const matches = this.matches();
    if (matches.length === 0) {
      this.current = -1;
      return { count: 0, current: -1 };
    }
    this.current = (this.current + matches.length) % matches.length;
    const from = matches[this.current] ?? 0;
    const returnTo = document.activeElement;
    this.area.focus();
    this.area.setSelectionRange(from, from + this.query.length);
    if (returnTo instanceof HTMLElement && returnTo !== this.area) returnTo.focus();
    return { count: matches.length, current: this.current };
  }

  private matches(): number[] {
    if (this.query === '') return [];
    const haystack = this.area.value.toLowerCase();
    const needle = this.query.toLowerCase();
    // As in the editor: a case mapping that changes length would misplace ranges.
    if (haystack.length !== this.area.value.length) return [];
    const found: number[] = [];
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      found.push(index);
      index = haystack.indexOf(needle, index + needle.length);
    }
    return found;
  }
}
