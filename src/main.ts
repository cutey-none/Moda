/**
 * Moda — entry point.
 *
 * Kept to a single call so `app.ts` stays importable (and testable) without
 * starting the application as a side effect.
 */

import { launch } from './app';

void launch();
