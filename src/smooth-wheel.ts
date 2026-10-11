/**
 * Smooth scrolling for mouse wheels.
 *
 * WebKit moves a scroller the whole distance of a wheel notch in one frame, so
 * a mouse wheel steps through the document in 40px jumps — the "stuttery" feel
 * Chromium-based editors avoid by animating each notch. Trackpads and Magic
 * Mice already send a continuous stream of small deltas with the system's own
 * momentum, and smoothing those again would make them feel laggy, so only notch
 * events are taken over here.
 *
 * WebKit reports a notch as `wheelDeltaY` in whole multiples of 120, which
 * continuous devices essentially never produce. That is the whole test.
 */

/**
 * How quickly the animation closes the gap to its target, in milliseconds.
 *
 * The distance left shrinks by a factor of e every this-many ms, so a notch
 * settles in roughly four times this. Short enough to feel attached to the
 * wheel, long enough that consecutive frames overlap into one glide.
 */
const TIME_CONSTANT_MS = 45;

/** The size WebKit gives a single notch in the legacy `wheelDelta` units. */
const NOTCH = 120;

/** A legacy WebKit property the standard `WheelEvent` type does not declare. */
type LegacyWheelEvent = WheelEvent & { wheelDeltaY?: number };

function isNotch(event: LegacyWheelEvent): boolean {
  const legacy = event.wheelDeltaY;
  return (
    event.deltaMode === WheelEvent.DOM_DELTA_PIXEL &&
    event.deltaY !== 0 &&
    event.deltaX === 0 &&
    typeof legacy === 'number' &&
    legacy !== 0 &&
    legacy % NOTCH === 0
  );
}

function maxScroll(element: Element): number {
  return element.scrollHeight - element.clientHeight;
}

/**
 * The element a wheel over `target` would scroll in the direction of `deltaY`:
 * the nearest vertical scroller that still has room to move that way. This is
 * how the browser itself picks, so nested lists (a dropdown inside the editor,
 * the sidebar tree) keep scrolling themselves rather than the page behind them.
 */
function scrollerFor(target: EventTarget | null, deltaY: number): Element | undefined {
  let element = target instanceof Element ? target : null;
  while (element !== null) {
    const { overflowY } = getComputedStyle(element);
    if ((overflowY === 'auto' || overflowY === 'scroll') && maxScroll(element) > 1) {
      const room = deltaY > 0 ? maxScroll(element) - element.scrollTop : element.scrollTop;
      if (room > 1) return element;
    }
    element = element.parentElement;
  }
  return undefined;
}

class Glide {
  private element: Element | undefined;
  /** Where the animation is, unrounded; `scrollTop` may round what is written. */
  private position = 0;
  private target = 0;
  private frame: number | undefined;
  private lastTime = 0;

  /** Add one notch's distance to the scroll in flight, or start a new one. */
  push(element: Element, deltaY: number): void {
    if (this.element !== element || this.frame === undefined) {
      this.stop();
      this.element = element;
      this.position = element.scrollTop;
      this.target = element.scrollTop;
    }
    this.target = Math.min(Math.max(this.target + deltaY, 0), maxScroll(element));
    if (this.frame === undefined) {
      this.lastTime = performance.now();
      this.frame = requestAnimationFrame((time) => this.step(time));
    }
  }

  stop(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
  }

  private step(time: number): void {
    const element = this.element;
    if (element === undefined) return;
    // Something else moved the scroller — a key press, the scrollbar, an
    // outline jump. Fighting it would yank the view back, so give way.
    if (Math.abs(element.scrollTop - this.position) > 1.5) {
      this.frame = undefined;
      return;
    }
    const elapsed = Math.max(time - this.lastTime, 0);
    this.lastTime = time;
    const remaining = this.target - this.position;
    if (Math.abs(remaining) < 0.5) {
      element.scrollTop = this.target;
      this.frame = undefined;
      return;
    }
    this.position += remaining * (1 - Math.exp(-elapsed / TIME_CONSTANT_MS));
    element.scrollTop = this.position;
    this.frame = requestAnimationFrame((next) => this.step(next));
  }
}

/** Animate mouse-wheel notches anywhere in the window. */
export function installSmoothWheel(): void {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const glide = new Glide();

  window.addEventListener(
    'wheel',
    (event: LegacyWheelEvent) => {
      if (event.defaultPrevented || event.ctrlKey || reducedMotion.matches) return;
      if (!isNotch(event)) {
        // A trackpad taking over mid-glide scrolls natively from wherever the
        // glide had got to.
        glide.stop();
        return;
      }
      const scroller = scrollerFor(event.target, event.deltaY);
      if (scroller === undefined) return;
      event.preventDefault();
      glide.push(scroller, event.deltaY);
    },
    { passive: false },
  );
}
