/**
 * Scroll anchoring for the editor.
 *
 * Crepe only keeps a live CodeMirror editor in code blocks near the viewport:
 * a block scrolled out of view is torn down a few seconds later and replaced by
 * a lighter placeholder of a different height, and rebuilt when it comes back.
 * Every swap above the viewport moves everything below it, so the document
 * appeared to scroll by itself a few seconds after the user stopped.
 *
 * Chromium hides this with CSS scroll anchoring; WebKit does not anchor. This
 * does the same thing by hand: it remembers the element at the top of the view
 * and where it should be, and puts it back whenever it is found elsewhere.
 *
 * The check runs as soon as the DOM changes (a MutationObserver callback runs
 * right after the task that swapped a block, before anything else and before
 * the next frame), when the content changes size for other reasons such as an
 * image loading (a ResizeObserver, which also runs before paint), and on every
 * scroll — a check there that only re-chose the anchor would take a pending
 * shift as the new normal.
 */

/**
 * Fired on the scroller when an anchoring correction moves it, so an animation
 * driving the same scroller can move its own idea of the position along with
 * it rather than mistaking the jump for the user scrolling elsewhere.
 */
export const SCROLL_SHIFT_EVENT = 'moda:scroll-shift';

export interface ScrollShiftDetail {
  /** Pixels added to `scrollTop`. */
  delta: number;
}

/**
 * Code blocks are never chosen as the anchor, nor anything inside them: their
 * contents are exactly what gets destroyed and rebuilt.
 */
const UNSTABLE = '.milkdown-code-block';

/** How far down into nested blocks the anchor is looked for. */
const MAX_DEPTH = 8;

export class ScrollAnchor {
  private anchor: Element | undefined;
  /** The anchor's top, relative to the scroller's top, when it was chosen. */
  private anchorOffset = 0;
  /** `scrollTop` when the anchor was chosen. */
  private anchorScrollTop = 0;
  private readonly resizeObserver: ResizeObserver;
  private readonly mutationObserver: MutationObserver;
  private readonly onScroll = () => this.restore();

  constructor(
    private readonly scroller: HTMLElement,
    private readonly content: HTMLElement,
  ) {
    this.resizeObserver = new ResizeObserver(() => this.restore());
    this.resizeObserver.observe(content);
    this.mutationObserver = new MutationObserver(() => this.restore());
    this.mutationObserver.observe(content, { childList: true, subtree: true });
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
    this.pick();
  }

  disconnect(): void {
    this.resizeObserver.disconnect();
    this.mutationObserver.disconnect();
    this.scroller.removeEventListener('scroll', this.onScroll);
    this.anchor = undefined;
  }

  /**
   * Choose the innermost stable element crossing the top edge of the view.
   * Innermost matters: a list holding code blocks keeps its own top fixed while
   * blocks inside it change height, so anchoring on the list would miss them.
   */
  private pick(): void {
    const viewTop = this.scroller.getBoundingClientRect().top;
    let container: Element = this.content;
    let chosen: Element | undefined;
    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
      const next = [...container.children].find(
        (child) => child.getBoundingClientRect().bottom > viewTop,
      );
      if (next === undefined) break;
      if (next.matches(UNSTABLE)) {
        // Inside a code block nothing is stable, and the block itself only ever
        // changes height, which never moves its own top — but it does move
        // everything after it, which is what is on screen. So anchor on
        // whatever follows it.
        chosen = next.nextElementSibling ?? next;
        break;
      }
      chosen = next;
      container = next;
    }
    this.anchor = chosen;
    this.anchorOffset = chosen === undefined ? 0 : chosen.getBoundingClientRect().top - viewTop;
    this.anchorScrollTop = this.scroller.scrollTop;
  }

  /**
   * Put the anchor back where scrolling alone would have left it. Scrolling
   * moves it up by exactly as much as `scrollTop` grew; anything beyond that
   * is content above it changing height.
   */
  private restore(): void {
    const anchor = this.anchor;
    if (anchor === undefined || !anchor.isConnected) {
      this.pick();
      return;
    }
    const viewTop = this.scroller.getBoundingClientRect().top;
    const expected = this.anchorOffset - (this.scroller.scrollTop - this.anchorScrollTop);
    const delta = anchor.getBoundingClientRect().top - viewTop - expected;
    if (Math.abs(delta) >= 1) {
      this.scroller.scrollTop += delta;
      this.scroller.dispatchEvent(
        new CustomEvent<ScrollShiftDetail>(SCROLL_SHIFT_EVENT, {
          bubbles: true,
          detail: { delta },
        }),
      );
    }
    this.pick();
  }
}
