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
 * continuous devices essentially never produce. But only a slow notch looks like
 * that: spin the wheel faster and macOS accelerates it, sending events of 150,
 * 250, 350px with fractional sizes. Those follow a plain notch within a few tens
 * of milliseconds, so a large event close behind a wheel event is treated as
 * part of the same spin. Missing them is what made fast scrolling lurch — every
 * accelerated event jumped its whole distance in one frame.
 */

import { SCROLL_SHIFT_EVENT, type ScrollShiftDetail } from './scroll-anchor';

/**
 * The response time of the spring that carries the scroll, in milliseconds.
 *
 * The scroll is a critically damped spring pulled toward wherever the wheel
 * has asked to be: a lone notch eases in and out over roughly five times this,
 * and a fast spin settles into a steady glide. A spring rather than a plain
 * ease-out because its *speed* is continuous — an ease-out jumps back to full
 * speed every time an event lands, and during a spin that pulses
 * fast-slow-fast, which reads as stutter just as surely as jumping does.
 */
const RESPONSE_MS = 60;

/** The size WebKit gives a single notch in the legacy `wheelDelta` units. */
const NOTCH = 120;

/**
 * How long after a wheel event an accelerated one can still belong to the same
 * spin. Measured on an MX Anywhere 3S: accelerated events arrive 20–80ms apart.
 */
const SPIN_WINDOW_MS = 250;

/**
 * The smallest accelerated event taken as part of a spin. One notch is 40px and
 * acceleration only ever adds to it, while a trackpad's stream is mostly far
 * smaller — so this keeps a trackpad gesture from being swept up.
 */
const MIN_SPIN_DELTA = 40;

/** A legacy WebKit property the standard `WheelEvent` type does not declare. */
type LegacyWheelEvent = WheelEvent & { wheelDeltaY?: number };

/** Recognises the events of a mouse wheel, slow notches and fast spins alike. */
class WheelClassifier {
  private lastWheelAt = -Infinity;

  isWheel(event: LegacyWheelEvent): boolean {
    if (
      event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL ||
      event.deltaY === 0 ||
      event.deltaX !== 0
    ) {
      return false;
    }
    const legacy = event.wheelDeltaY;
    const notch = typeof legacy === 'number' && legacy !== 0 && legacy % NOTCH === 0;
    const accelerated =
      event.timeStamp - this.lastWheelAt < SPIN_WINDOW_MS &&
      Math.abs(event.deltaY) >= MIN_SPIN_DELTA;
    if (!notch && !accelerated) return false;
    this.lastWheelAt = event.timeStamp;
    return true;
  }
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
  /** Pixels per millisecond. */
  private velocity = 0;
  private target = 0;
  private frame: number | undefined;
  private lastTime = 0;

  /** Add one notch's distance to the scroll in flight, or start a new one. */
  push(element: Element, deltaY: number): void {
    if (this.element !== element || this.frame === undefined) {
      this.stop();
      this.element = element;
      this.position = element.scrollTop;
      this.velocity = 0;
      this.target = element.scrollTop;
    }
    this.target = Math.min(Math.max(this.target + deltaY, 0), maxScroll(element));
    if (this.frame === undefined) {
      this.lastTime = performance.now();
      this.frame = requestAnimationFrame((time) => this.step(time));
    }
  }

  /** Follow a jump made to the scroller by someone else, mid-glide. */
  shift(element: Element, delta: number): void {
    if (element !== this.element || this.frame === undefined) return;
    this.position += delta;
    this.target += delta;
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

    // The closed-form critically damped spring, so a long frame cannot make
    // the step overshoot the way a naive integration would.
    const omega = 1 / RESPONSE_MS;
    const offset = this.position - this.target;
    const decay = Math.exp(-omega * elapsed);
    const carry = this.velocity + omega * offset;
    const nextOffset = (offset + carry * elapsed) * decay;
    this.velocity = (this.velocity - omega * carry * elapsed) * decay;

    if (Math.abs(nextOffset) < 0.5 && Math.abs(this.velocity) < 0.02) {
      element.scrollTop = this.target;
      this.position = this.target;
      this.frame = undefined;
      return;
    }
    this.position = this.target + nextOffset;
    element.scrollTop = this.position;
    this.frame = requestAnimationFrame((next) => this.step(next));
  }
}

/** Animate mouse-wheel notches anywhere in the window. */
export function installSmoothWheel(): void {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const glide = new Glide();
  const classifier = new WheelClassifier();

  // Scroll anchoring moves the scroller when content above the view changes
  // height; the glide has to move with it or it would read that as the user
  // scrolling elsewhere and stop dead.
  window.addEventListener(SCROLL_SHIFT_EVENT, (event) => {
    const { detail } = event as CustomEvent<ScrollShiftDetail>;
    if (event.target instanceof Element) glide.shift(event.target, detail.delta);
  });

  window.addEventListener(
    'wheel',
    (event: LegacyWheelEvent) => {
      if (event.defaultPrevented || event.ctrlKey || reducedMotion.matches) return;
      if (!classifier.isWheel(event)) {
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
    // Capture, so the wheel is claimed before anything inside the page sees it
    // and lets it through to a native scroll.
    { passive: false, capture: true },
  );
}
