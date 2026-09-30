/**
 * Packaging-contract tests.
 *
 * These pin the three declarations that make the package installable from a
 * GitHub link by the DeepSeek Harness Desktop and Web Plugins panels:
 *
 * - `dsh.bundle.patch` — without it the panel still runs `pnpm add`, but the
 *   profile's `dsh.profile.bundles` never gains the package, so nothing mounts
 *   (the plugin installs and silently does nothing);
 * - a `cordis.patch.yml` that inserts exactly one row named after the package,
 *   which is the layer that actually mounts the routes;
 * - `dsh.client.platform: "web"` plus a `./client` export, because the Desktop
 *   application renders the same web client bundle graph as `dsh web`.
 *
 * @module dsh-session-export/test/package.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLUGIN_VERSION } from '../lib/config.js';

/** Package root, resolved from this test file. */
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The parsed package manifest. */
const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'));

/**
 * Reduce the bundle patch to its significant lines.
 * @param text - the patch file content.
 * @returns trimmed, non-comment, non-blank lines.
 */
function significantLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

test('package ships a dsh.bundle patch that exists on disk', () => {
  const patch = manifest.dsh?.bundle?.patch;
  assert.equal(typeof patch, 'string', 'dsh.bundle.patch must be a string');
  assert.ok(existsSync(join(PACKAGE_DIR, patch)), `${patch} must exist`);
});

test('the bundle patch stays a top-level insert of exactly one row', () => {
  const lines = significantLines(readFileSync(join(PACKAGE_DIR, manifest.dsh.bundle.patch), 'utf8'));
  assert.deepEqual(lines, [
    '- insert:',
    '- id: session-transcript-export',
    `name: '${manifest.name}'`,
  ]);
});

test('files ships the bundle patch to a git or npm install', () => {
  assert.ok(manifest.files.includes('cordis.patch.yml'), 'cordis.patch.yml must be listed in files');
  assert.ok(manifest.files.includes('lib'), 'lib must be listed in files');
});

test('package is installable: not private, with a GitHub repository', () => {
  assert.notEqual(manifest.private, true, 'a GitHub-installable package must not be private');
  assert.match(manifest.repository?.url ?? '', /github\.com\/[^/]+\/[^/]+/u);
});

test('the client half stays a web-platform bundle with a ./client export', () => {
  assert.equal(manifest.dsh?.client?.platform, 'web');
  assert.ok(Array.isArray(manifest.dsh.client.inject) && manifest.dsh.client.inject.length > 0);
  assert.equal(manifest.type, 'module', 'the client bundle must stay ESM');
  assert.ok(existsSync(join(PACKAGE_DIR, 'lib/client.js')), 'the ./client export must exist');
});

test('compatibility is declared against the harness runtime, not hoisted onto it', () => {
  assert.equal(typeof manifest.peerDependencies?.['@deepseek-ai/dsh'], 'string');
  // The harness reads peerDependencies as its compatibility gate, while pnpm
  // reads peerDependenciesMeta: without `optional: true` an install into a
  // profile that does not set autoInstallPeers=false drags the whole harness
  // (hundreds of packages) into the profile as a "missing peer".
  assert.equal(manifest.peerDependenciesMeta?.['@deepseek-ai/dsh']?.optional, true);
  assert.equal(manifest.dependencies, undefined, 'the plugin keeps zero runtime dependencies');
});

test('the artifact version stays in step with the manifest version', () => {
  assert.equal(PLUGIN_VERSION, manifest.version);
});
