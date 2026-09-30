/**
 * Installer tests.
 *
 * `scripts/install.mjs` is the local, scripted twin of the Desktop/Web Plugins
 * panel: it materializes the package under the profile and records it in
 * `dsh.profile.bundles`. These tests cover the pure helpers that decide the
 * profile, the manifest edit, and the migration off the pre-bundle layout —
 * the parts that can be wrong without a harness to observe them.
 *
 * @module dsh-session-export/test/install.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ROW_ID,
  bundleNames,
  githubShorthand,
  hasRow,
  linkState,
  parseArgs,
  resolveDsh,
  resolvePnpm,
  resolveProfile,
  serializeManifest,
  stripRow,
  withBundle,
  withoutBundle,
} from '../scripts/install.mjs';

/**
 * Run a body with `DSH_PROFILE`/`DSH_HOME` set for its duration.
 * @param env - values to set; a null value unsets the variable.
 * @param body - the work to run.
 * @returns whatever the body returns.
 */
function withEnv(env, body) {
  const saved = { DSH_PROFILE: process.env.DSH_PROFILE, DSH_HOME: process.env.DSH_HOME };
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === null) delete process.env[key];
      else process.env[key] = value;
    }
    return body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Create a throwaway harness home, optionally holding named profiles.
 * @param profiles - profile directory names to create.
 * @returns `{ home, cleanup }`.
 */
function tempHome(profiles) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-export-home-'));
  for (const name of profiles) mkdirSync(join(home, 'profiles', name), { recursive: true });
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('resolveProfile prefers the flag, then the environment, then an existing profile', () => {
  const { home, cleanup } = tempHome(['web']);
  try {
    withEnv({ DSH_PROFILE: null }, () => {
      assert.equal(resolveProfile('rescue', home), 'rescue');
      assert.equal(resolveProfile(null, home), 'web', 'falls back to the only existing profile');
    });
    withEnv({ DSH_PROFILE: 'my-profile' }, () => {
      assert.equal(resolveProfile(null, home), 'my-profile', 'the environment outranks discovery');
    });
  } finally {
    cleanup();
  }
});

test('resolveProfile prefers the desktop profile because Desktop owns it', () => {
  const { home, cleanup } = tempHome(['web', 'desktop']);
  try {
    withEnv({ DSH_PROFILE: null }, () => {
      assert.equal(resolveProfile(null, home), 'desktop');
    });
  } finally {
    cleanup();
  }
});

test('resolveProfile falls back to the desktop profile when none exists yet', () => {
  const { home, cleanup } = tempHome([]);
  try {
    withEnv({ DSH_PROFILE: null }, () => {
      assert.equal(resolveProfile(null, home), 'desktop');
    });
  } finally {
    cleanup();
  }
});

test('resolvePnpm takes the flag, then $DSH_PNPM, then plain pnpm', () => {
  assert.equal(resolvePnpm('/opt/pnpm', {}), '/opt/pnpm');
  assert.equal(resolvePnpm(null, { DSH_PNPM: '/env/pnpm' }), '/env/pnpm');
  assert.equal(resolvePnpm(null, {}), 'pnpm');
});

test('resolveDsh takes the flag, then $DSH_BIN, then a dsh on PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-export-path-'));
  try {
    assert.equal(resolveDsh('/opt/dsh', {}), '/opt/dsh');
    assert.equal(resolveDsh(null, { DSH_BIN: '/env/dsh' }), '/env/dsh');
    assert.equal(resolveDsh(null, { PATH: dir }), null, 'an empty shim directory holds no launcher');
    writeFileSync(join(dir, 'dsh'), '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(resolveDsh(null, { PATH: `${dir}:/usr/bin` }), join(dir, 'dsh'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withBundle appends once and preserves every unrelated manifest field', () => {
  const base = {
    name: 'dsh-profile-desktop',
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  };
  const first = withBundle(base, 'dsh-session-export');
  assert.equal(first.changed, true);
  assert.deepEqual(bundleNames(first.manifest), ['@deepseek-ai/dsh-base', 'dsh-session-export']);
  assert.deepEqual(first.manifest.dependencies, {});
  assert.equal(base.dsh.profile.bundles.length, 1, 'the input manifest is not mutated');

  const second = withBundle(first.manifest, 'dsh-session-export');
  assert.equal(second.changed, false);
  assert.equal(second.manifest, first.manifest);
});

test('withBundle creates the dsh.profile path on a manifest that has none', () => {
  const { manifest } = withBundle({ name: 'dsh-profile-desktop' }, 'dsh-session-export');
  assert.deepEqual(bundleNames(manifest), ['dsh-session-export']);
  assert.deepEqual(manifest, {
    name: 'dsh-profile-desktop',
    dsh: { profile: { bundles: ['dsh-session-export'] } },
  });
});

test('withoutBundle reverses withBundle and drops the emptied containers', () => {
  const base = { name: 'dsh-profile-desktop', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } };
  const roundTrip = withoutBundle(withBundle(base, 'dsh-session-export').manifest, 'dsh-session-export');
  assert.equal(roundTrip.changed, true);
  assert.deepEqual(roundTrip.manifest, base);

  const only = withoutBundle(withBundle({ name: 'x' }, 'dsh-session-export').manifest, 'dsh-session-export');
  assert.deepEqual(only.manifest, { name: 'x' }, 'an empty dsh.profile is removed, not left behind');
  assert.equal(withoutBundle(base, 'absent').changed, false);
});

test('serializeManifest keeps the two-space/trailing-newline shape dsh writes', () => {
  assert.equal(serializeManifest({ name: 'x' }), '{\n  "name": "x"\n}\n');
});

test('githubShorthand reads the repository URL pnpm accepts', () => {
  assert.equal(githubShorthand({ repository: { url: 'git+https://github.com/navms/dsh-session-export.git' } }), 'github:navms/dsh-session-export');
  assert.equal(githubShorthand({ repository: { url: 'https://github.com/navms/dsh-session-export' } }), 'github:navms/dsh-session-export');
  assert.equal(githubShorthand({ repository: { url: 'git@github.com:navms/dsh-session-export.git' } }), 'github:navms/dsh-session-export');
  assert.equal(githubShorthand({ repository: 'git+https://gitlab.com/navms/dsh-session-export.git' }), null);
  assert.equal(githubShorthand({}), null);
});

test('hasRow sees both the block and the flow spelling of the legacy row', () => {
  assert.equal(hasRow(`- insert:\n    - id: ${ROW_ID}\n      name: 'dsh-session-export'\n`), true);
  assert.equal(hasRow(`[{ insert: [{ id: '${ROW_ID}', name: 'dsh-session-export' }] }]`), true);
  assert.equal(hasRow('- id: ui-theme\n'), false);
});

test('stripRow removes the legacy block row and collapses its empty insert', () => {
  const text = [
    '# profile patch layer',
    '- id: ui-theme',
    '  name: "@deepseek-ai/dsh-client-ui-theme"',
    '',
    '- insert:',
    `    - id: ${ROW_ID}`,
    "      name: 'dsh-session-export'",
    '',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '',
  ].join('\n');
  const stripped = stripRow(text);
  assert.equal(hasRow(stripped), false);
  assert.doesNotMatch(stripped, /insert:/u, 'the emptied insert block is dropped too');
  assert.match(stripped, /ui-theme/u);
  assert.match(stripped, /agent-default-model/u);
});

test('stripRow keeps unrelated insert rows in the same block', () => {
  const text = [
    '- insert:',
    `    - id: ${ROW_ID}`,
    "      name: 'dsh-session-export'",
    '    - id: other-plugin',
    "      name: 'other-plugin'",
    '',
  ].join('\n');
  const stripped = stripRow(text);
  assert.equal(hasRow(stripped), false);
  assert.match(stripped, /insert:/u);
  assert.match(stripped, /other-plugin/u);
});

test('stripRow returns an emptied patch file to the top-level empty array', () => {
  const stripped = stripRow(`- insert:\n    - id: ${ROW_ID}\n      name: 'dsh-session-export'\n`);
  assert.match(stripped, /\[\]/u, 'a comment-only document would read as null, not an empty array');
  assert.equal(hasRow(stripped), false);
});

test('stripRow removes the flow spelling of the legacy row', () => {
  const text = `[{ id: 'ui-theme' }, { insert: [{ id: '${ROW_ID}', name: 'dsh-session-export' }] }]`;
  const stripped = stripRow(text);
  assert.equal(hasRow(stripped), false);
  assert.match(stripped, /ui-theme/u);
});

test('linkState distinguishes our link, a foreign link, a directory, and absence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-export-link-'));
  try {
    const link = join(dir, 'dsh-session-export');
    assert.equal(linkState(link), 'missing');
    mkdirSync(link);
    assert.equal(linkState(link), 'directory');
    rmSync(link, { recursive: true });
    symlinkSync(tmpdir(), link, 'dir');
    assert.equal(linkState(link), 'foreign');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseArgs reads --github with and without an inline value', () => {
  assert.deepEqual(parseArgs(['--github', '--profile', 'desktop']), {
    profile: 'desktop', home: null, github: true, pnpm: null, dsh: null, uninstall: false, dryRun: false,
  });
  assert.equal(parseArgs(['--github', 'https://github.com/navms/dsh-session-export']).github, 'https://github.com/navms/dsh-session-export');
  assert.equal(parseArgs(['--github', 'github:navms/dsh-session-export', '--pnpm', '/opt/pnpm']).pnpm, '/opt/pnpm');
  assert.equal(parseArgs(['--uninstall', '--dry-run']).uninstall, true);
});
