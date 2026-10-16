#!/usr/bin/env node
/**
 * Write the `latest.json` an installed Moda reads to learn about a new release.
 *
 * Tauri's updater fetches this file from the endpoint in `tauri.conf.json`,
 * compares `version` with its own, and — if it is newer — downloads the
 * `url` for its platform and refuses it unless it verifies against `signature`.
 * The release workflow runs this once both architectures are built, so one
 * manifest describes the whole release.
 *
 * Usage:
 *   node scripts/make-update-manifest.mjs --version 0.0.3 --dir dist \
 *     --base-url https://github.com/<owner>/<repo>/releases/download/v0.0.3 \
 *     --out dist/latest.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** Tauri's platform key for each architecture the release builds. */
const PLATFORMS = {
  aarch64: 'darwin-aarch64',
  x64: 'darwin-x86_64',
};

/** The update package's file name for one architecture. */
export function assetName(arch) {
  return `Moda_${arch}.app.tar.gz`;
}

/**
 * Build the manifest.
 *
 * @param {{ version: string, signatures: Record<'aarch64' | 'x64', string>,
 *           baseUrl: string, pubDate: string }} options
 */
export function makeManifest({ version, signatures, baseUrl, pubDate }) {
  const base = baseUrl.replace(/\/+$/, '');
  const platforms = {};
  for (const [arch, key] of Object.entries(PLATFORMS)) {
    platforms[key] = { signature: signatures[arch], url: `${base}/${assetName(arch)}` };
  }
  return { version, notes: '', pub_date: pubDate, platforms };
}

function main() {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      dir: { type: 'string' },
      'base-url': { type: 'string' },
      out: { type: 'string' },
    },
  });
  for (const name of ['version', 'dir', 'base-url', 'out']) {
    if (values[name] === undefined) throw new Error(`missing --${name}`);
  }

  const signatures = {};
  for (const arch of Object.keys(PLATFORMS)) {
    const file = join(values.dir, `${assetName(arch)}.sig`);
    try {
      signatures[arch] = readFileSync(file, 'utf8').trim();
    } catch {
      throw new Error(`missing signature ${file}; was the update package built and signed?`);
    }
  }

  const manifest = makeManifest({
    version: values.version,
    signatures,
    baseUrl: values['base-url'],
    pubDate: new Date().toISOString(),
  });
  writeFileSync(values.out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${values.out} for ${values.version}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}
