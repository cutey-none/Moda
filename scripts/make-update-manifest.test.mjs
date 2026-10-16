import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeManifest } from './make-update-manifest.mjs';

const SCRIPT = fileURLToPath(new URL('./make-update-manifest.mjs', import.meta.url));
const BASE = 'https://github.com/cutey-none/Moda/releases/download/v0.0.3';

test('lists both macOS architectures with their own signature and asset', () => {
  const manifest = makeManifest({
    version: '0.0.3',
    signatures: { aarch64: 'SIG-ARM', x64: 'SIG-INTEL' },
    baseUrl: BASE,
    pubDate: '2026-10-17T00:00:00Z',
  });
  assert.deepEqual(manifest, {
    version: '0.0.3',
    notes: '',
    pub_date: '2026-10-17T00:00:00Z',
    platforms: {
      'darwin-aarch64': { signature: 'SIG-ARM', url: `${BASE}/Moda_aarch64.app.tar.gz` },
      'darwin-x86_64': { signature: 'SIG-INTEL', url: `${BASE}/Moda_x64.app.tar.gz` },
    },
  });
});

test('a trailing slash on the base URL does not double up', () => {
  const manifest = makeManifest({
    version: '0.0.3',
    signatures: { aarch64: 'a', x64: 'b' },
    baseUrl: `${BASE}/`,
    pubDate: '2026-10-17T00:00:00Z',
  });
  assert.equal(manifest.platforms['darwin-aarch64'].url, `${BASE}/Moda_aarch64.app.tar.gz`);
});

test('the CLI writes the manifest from the .sig files, trimming whitespace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moda-manifest-'));
  writeFileSync(join(dir, 'Moda_aarch64.app.tar.gz.sig'), 'SIG-ARM\n');
  writeFileSync(join(dir, 'Moda_x64.app.tar.gz.sig'), 'SIG-INTEL\n');
  const out = join(dir, 'latest.json');
  execFileSync('node', [SCRIPT, '--version', '0.0.3', '--dir', dir, '--base-url', BASE, '--out', out]);
  const manifest = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(manifest.version, '0.0.3');
  assert.equal(manifest.platforms['darwin-aarch64'].signature, 'SIG-ARM');
  assert.equal(manifest.platforms['darwin-x86_64'].signature, 'SIG-INTEL');
  assert.ok(!Number.isNaN(Date.parse(manifest.pub_date)));
});

test('the CLI fails when a signature is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moda-manifest-'));
  writeFileSync(join(dir, 'Moda_aarch64.app.tar.gz.sig'), 'SIG-ARM\n');
  assert.throws(
    () =>
      execFileSync(
        'node',
        [SCRIPT, '--version', '0.0.3', '--dir', dir, '--base-url', BASE, '--out', join(dir, 'latest.json')],
        { stdio: 'pipe' },
      ),
    /Moda_x64\.app\.tar\.gz\.sig/,
  );
});
