/**
 * Moda — entry point.
 *
 * Kept to a single call so `app.ts` stays importable (and testable) without
 * starting the application as a side effect.
 */

import { isTauri } from '@tauri-apps/api/core';

import { launch } from './app';
import { installSmoothWheel } from './smooth-wheel';

/**
 * Tell the stylesheet which shell it is running in.
 *
 * The chrome is translucent, so what shows through it depends entirely on what
 * is behind the window: under Tauri that is the desktop, blurred by the system
 * material, and the page must paint nothing at all there or it would cover the
 * material up. A browser has no desktop behind it, so `styles.css` stands a
 * gradient in for one — but only when this marker is absent, which is why it
 * has to be set before the first paint rather than after launch resolves.
 */
if (isTauri()) {
  document.documentElement.dataset.shell = 'tauri';
}

installSmoothWheel();
void launch();
