import { defineConfig } from 'vite';
// @ts-expect-error type error without @types/node package
import process from 'node:process';

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  // Vite options tailored for Tauri development and only applied in
  // `tauri dev` or `tauri build`.
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**'],
    },
  },
  resolve: {
    alias: {
      // Mermaid's optional ELK layout is EPL-2.0, which cannot ship in an
      // AGPL-3.0 app; see the stub for what replaces it.
      // An absolute path: the dev server's dependency pre-bundler resolves
      // this too, and it reads a root-relative `/src/…` as a filesystem path.
      'elkjs/lib/elk.bundled.js': decodeURIComponent(
        new URL('./src/elk-stub.ts', import.meta.url).pathname,
      ),
    },
  },
  // Env vars with these prefixes are exposed through `import.meta.env`.
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // Tauri uses WebKit on macOS, whose JavaScript baseline is older than
    // Chromium's. Without this, a modern-syntax bundle can fail to parse in
    // the webview even though it builds cleanly.
    target: 'safari15',
    // Don't minify debug builds, so the webview's inspector is readable.
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
}));
