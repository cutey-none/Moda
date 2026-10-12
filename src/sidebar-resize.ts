/**
 * Dragging the sidebar's right edge to change its width.
 *
 * The width lives in the sidebar's own `--sidebar-w`, overriding the default
 * declared on `:root`, so removing it is all a reset takes. It is remembered in
 * `localStorage` — a per-window convenience, so a failed read or write only
 * means starting from the default next time.
 */

const MIN_WIDTH = 180;
const MAX_WIDTH = 480;
/** Room always left for the editor, however wide the sidebar is dragged. */
const MIN_EDITOR_WIDTH = 320;
/** How far one arrow-key press moves the edge. */
const KEY_STEP = 16;
const STORAGE_KEY = 'moda.sidebarWidth';

function clamp(width: number): number {
  const max = Math.min(MAX_WIDTH, window.innerWidth - MIN_EDITOR_WIDTH);
  return Math.round(Math.max(MIN_WIDTH, Math.min(width, max)));
}

function remembered(): number | undefined {
  try {
    const width = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(width) && width > 0 ? width : undefined;
  } catch {
    return undefined;
  }
}

function remember(width: number | undefined): void {
  try {
    if (width === undefined) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // Not remembered; the width still applies for this session.
  }
}

/**
 * Let `handle` resize `panel`: drag to change the width, double-click to go
 * back to the default, or focus it and use the arrow keys.
 */
export function installSidebarResize(panel: HTMLElement, handle: HTMLElement): void {
  const apply = (width: number): number => {
    const clamped = clamp(width);
    panel.style.setProperty('--sidebar-w', `${clamped}px`);
    handle.setAttribute('aria-valuenow', String(clamped));
    return clamped;
  };

  const initial = remembered();
  if (initial !== undefined) apply(initial);
  handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
  handle.setAttribute('aria-valuemax', String(MAX_WIDTH));

  let startX = 0;
  let startWidth = 0;

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    startX = event.clientX;
    startWidth = panel.getBoundingClientRect().width;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('is-resizing-sidebar');
  });

  handle.addEventListener('pointermove', (event) => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    apply(startWidth + event.clientX - startX);
  });

  const finish = (event: PointerEvent): void => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    handle.releasePointerCapture(event.pointerId);
    document.body.classList.remove('is-resizing-sidebar');
    remember(panel.getBoundingClientRect().width);
  };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);

  handle.addEventListener('dblclick', () => {
    panel.style.removeProperty('--sidebar-w');
    handle.removeAttribute('aria-valuenow');
    remember(undefined);
  });

  handle.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowLeft' ? -KEY_STEP : event.key === 'ArrowRight' ? KEY_STEP : 0;
    if (step === 0) return;
    event.preventDefault();
    remember(apply(panel.getBoundingClientRect().width + step));
  });
}
