#!/usr/bin/env node
/**
 * Install (or uninstall) the session transcript export plugin in a DSH profile.
 *
 * The plugin ships as a DSH *bundle*: `package.json` declares
 * `dsh.bundle.patch`, and `cordis.patch.yml` holds the single Loader row the
 * package contributes. That declaration is what makes the package installable
 * from a GitHub link through the Desktop/Web Plugins panel — the panel runs
 * `pnpm add` and then records the package in the profile's
 * `dsh.profile.bundles`, so the bundle's own patch layer mounts the routes.
 *
 * This script performs the same two steps without a running harness, for local
 * development and for scripted installs:
 *
 *   1. materialize the package under the profile's `node_modules` — a symlink
 *      for a working copy (the default), or a real `pnpm add` for `--github`;
 *   2. record the package in the profile's `dsh.profile.bundles`.
 *
 * Both steps are idempotent and fully reversible. A profile that still carries
 * the pre-bundle layout (a hand-inserted row named {@link ROW_ID} in its own
 * `cordis.patch.yml`) is migrated onto the bundle layer on the way through, so
 * the row is never inserted twice.
 *
 * Usage:
 *   node scripts/install.mjs [--profile <name>] [--home <dir>] [--dry-run]
 *   node scripts/install.mjs --github [<spec>] [--profile <name>] [--pnpm <path>]
 *   node scripts/install.mjs --uninstall [--profile <name>] [--home <dir>]
 *
 * @module dsh-session-export/scripts/install
 */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Package name of this plugin; also the linker row name and browser bundle id. */
const PACKAGE_NAME = 'dsh-session-export';

/** Loader row id the bundle patch inserts and the legacy profile patch used. */
const ROW_ID = 'session-transcript-export';

/** Profile patch filename. */
const PATCH_FILENAME = 'cordis.patch.yml';

/** Profile manifest filename. */
const MANIFEST_FILENAME = 'package.json';

/**
 * Profiles an unspecified invocation is picked from, in order.
 *
 * `desktop` leads because that is the profile the Desktop application owns: a
 * bare `node scripts/install.mjs` in a stock installation should adapt the app
 * the person is looking at rather than the standalone web profile.
 */
const PROFILE_PREFERENCE = ['desktop', 'web'];

/** Absolute path of this plugin's package root. */
const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** This module's own absolute path, for the direct-invocation guard. */
const SELF_PATH = fileURLToPath(import.meta.url);

/**
 * Report whether this module is the process entry point.
 * @returns true when the script was invoked directly rather than imported.
 */
function isDirectInvocation() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) return false;
  try {
    return realpathSync(entry) === realpathSync(SELF_PATH);
  } catch {
    return resolve(entry) === resolve(SELF_PATH);
  }
}

/**
 * Parse the command line.
 *
 * `--github` takes an optional value: a following argument that does not start
 * with `-` is read as the spec, otherwise the spec is derived from this
 * package's own `repository` field.
 * @param argv - process arguments after the script path.
 * @returns the parsed options.
 */
function parseArgs(argv) {
  const options = {
    profile: null,
    home: null,
    github: null,
    pnpm: null,
    dsh: null,
    uninstall: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--uninstall') options.uninstall = true;
    else if (value === '--dry-run') options.dryRun = true;
    else if (value === '--profile') options.profile = argv[index += 1];
    else if (value === '--home') options.home = argv[index += 1];
    else if (value === '--pnpm') options.pnpm = argv[index += 1];
    else if (value === '--dsh') options.dsh = argv[index += 1];
    else if (value === '--github') {
      const next = argv[index + 1];
      if (typeof next === 'string' && next.length > 0 && !next.startsWith('-')) {
        options.github = next;
        index += 1;
      } else {
        options.github = true;
      }
    } else if (value === '--help' || value === '-h') {
      process.stdout.write(usage());
      process.exit(0);
    } else {
      process.stderr.write(`install.mjs: unknown argument ${JSON.stringify(value)}\n`);
      process.exit(2);
    }
  }
  if (options.profile !== null && (typeof options.profile !== 'string' || options.profile.length === 0)) {
    process.stderr.write('install.mjs: --profile requires a value\n');
    process.exit(2);
  }
  if (options.pnpm !== null && (typeof options.pnpm !== 'string' || options.pnpm.length === 0)) {
    process.stderr.write('install.mjs: --pnpm requires a value\n');
    process.exit(2);
  }
  if (options.dsh !== null && (typeof options.dsh !== 'string' || options.dsh.length === 0)) {
    process.stderr.write('install.mjs: --dsh requires a value\n');
    process.exit(2);
  }
  return options;
}

/**
 * Render the command-line help.
 * @returns the help text.
 */
function usage() {
  return [
    'usage: node scripts/install.mjs [--profile <name>] [--home <dir>] [--dry-run]',
    '       node scripts/install.mjs --github [<spec>] [--profile <name>] [--dsh <path>|--pnpm <path>] [--dry-run]',
    '       node scripts/install.mjs --uninstall [--profile <name>] [--home <dir>] [--dry-run]',
    '',
    'The default install symlinks this working copy into the profile and records it',
    'in the profile manifest\'s dsh.profile.bundles. --github installs the published',
    'package instead, exactly like the Desktop/Web Plugins panel.',
    '',
    `--profile <name>  profile to change; defaults to $DSH_PROFILE, then to the first`,
    `                  existing profile of: ${PROFILE_PREFERENCE.join(', ')}`,
    '--home <dir>      harness home; defaults to $DSH_HOME, then ~/.dsh',
    '--github [spec]   install from a git spec (github:owner/repo, a GitHub URL, ...);',
    '                  without a value the spec comes from package.json repository',
    '--dsh <path>      harness CLI used by --github (it owns the bundled pnpm and the',
    '                  profile lock); defaults to $DSH_BIN, then dsh on PATH',
    '--pnpm <path>     install with pnpm directly instead of the harness CLI; defaults',
    '                  to $DSH_PNPM, then pnpm on PATH',
    '--uninstall       remove the symlink/dependency, the bundle entry, and the legacy row',
    '--dry-run         report every change without writing anything',
    '',
  ].join('\n');
}

/**
 * Resolve the harness home the way the CLI does.
 * @param explicit - `--home` value, if any.
 * @returns the absolute home path.
 */
function resolveHome(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return resolve(explicit);
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return resolve(fromEnv.trim());
  return join(homedir(), '.dsh');
}

/**
 * Resolve the profile an unspecified invocation targets.
 * @param explicit - `--profile` value, if any.
 * @param home - the resolved harness home.
 * @returns the profile name.
 */
function resolveProfile(explicit, home) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const fromEnv = process.env.DSH_PROFILE;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  for (const name of PROFILE_PREFERENCE) {
    if (existsSync(join(home, 'profiles', name))) return name;
  }
  return PROFILE_PREFERENCE[0];
}

/**
 * Read a profile manifest.
 * @param path - the manifest path.
 * @returns the parsed manifest object.
 * @throws {Error} when the file is not a JSON object.
 */
function readManifest(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`install.mjs: ${path} must hold a JSON object`);
  }
  return parsed;
}

/**
 * Write a profile manifest with the same 2-space/trailing-newline shape dsh uses.
 * @param path - the manifest path.
 * @param manifest - the manifest object.
 * @returns the serialized text.
 */
function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, undefined, 2)}\n`;
}

/**
 * List the bundle names a profile manifest selects.
 * @param manifest - the parsed manifest.
 * @returns the bundle names in manifest order.
 */
function bundleNames(manifest) {
  const bundles = manifest?.dsh?.profile?.bundles;
  return Array.isArray(bundles) ? bundles.filter((name) => typeof name === 'string') : [];
}

/**
 * Add a bundle name to a manifest without mutating it.
 * @param manifest - the parsed manifest.
 * @param name - the bundle package name.
 * @returns `{ manifest, changed }` with the name appended when it was absent.
 */
function withBundle(manifest, name) {
  const bundles = bundleNames(manifest);
  if (bundles.includes(name)) return { manifest, changed: false };
  return {
    manifest: {
      ...manifest,
      dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, name] } },
    },
    changed: true,
  };
}

/**
 * Remove a bundle name from a manifest without mutating it.
 *
 * `dsh.profile` is dropped entirely once nothing else lives in it, so
 * uninstalling a plugin cannot leave an empty object behind that a later reader
 * has to interpret.
 * @param manifest - the parsed manifest.
 * @param name - the bundle package name.
 * @returns `{ manifest, changed }` with the name removed when it was present.
 */
function withoutBundle(manifest, name) {
  const bundles = bundleNames(manifest);
  if (!bundles.includes(name)) return { manifest, changed: false };
  const remaining = bundles.filter((entry) => entry !== name);
  const profile = { ...manifest.dsh?.profile };
  if (remaining.length === 0) delete profile.bundles;
  else profile.bundles = remaining;
  const dsh = { ...manifest.dsh };
  if (Object.keys(profile).length === 0) delete dsh.profile;
  else dsh.profile = profile;
  const next = { ...manifest };
  if (Object.keys(dsh).length === 0) delete next.dsh;
  else next.dsh = dsh;
  return { manifest: next, changed: true };
}

/**
 * Report whether the patch file already carries this plugin's legacy row.
 * @param text - the patch file content.
 * @returns true when the row is present.
 */
function hasRow(text) {
  return new RegExp(`^\\s*-\\s*id:\\s*${ROW_ID}\\s*$`, 'mu').test(text) || text.includes(`id: '${ROW_ID}'`) || text.includes(`id: "${ROW_ID}"`);
}

/**
 * Read the patch file's content with comments and blank lines removed.
 * @param text - the patch file content.
 * @returns the semantic content.
 */
function semanticContent(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .join('\n')
    .trim();
}

/**
 * Ensure the text ends with exactly one trailing newline.
 * @param text - the content.
 * @returns the normalized content.
 */
function withTrailingNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * Remove this plugin's legacy row (block form, or flow form when present) and
 * any `insert:` block it leaves empty.
 *
 * The row used to be inserted into the profile's own patch file before the
 * package became a bundle. The bundle layer now contributes the same row id, so
 * a leftover copy would be inserted twice and Cordis would reject the tree.
 * @param text - the patch file content.
 * @returns the content without the legacy row.
 */
function stripRow(text) {
  const idLine = new RegExp(`^\\s*-\\s*id:\\s*${ROW_ID}\\s*$`, 'u');
  const lines = text.split('\n');
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (idLine.test(line)) {
      const indent = (line.match(/^\s*/u)?.[0] ?? '').length;
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        if (next.trim() === '') break;
        const nextIndent = (next.match(/^\s*/u)?.[0] ?? '').length;
        if (nextIndent <= indent) break;
        index += 1;
      }
      continue;
    }
    kept.push(line);
  }
  const out = [];
  for (let index = 0; index < kept.length; index += 1) {
    const line = kept[index];
    const insert = /^(\s*)-\s*insert:\s*$/u.exec(line);
    if (insert !== null) {
      const indent = insert[1].length;
      let probe = index + 1;
      while (probe < kept.length && kept[probe].trim() === '') probe += 1;
      const child = kept[probe];
      const childIndent = child === undefined ? 0 : (child.match(/^\s*/u)?.[0] ?? '').length;
      if (child === undefined || childIndent <= indent) continue;
    }
    out.push(line);
  }
  const flow = out.join('\n')
    .replace(new RegExp(`\\s*\\{\\s*insert:\\s*\\[\\s*\\{\\s*id:\\s*['"]?${ROW_ID}['"]?[^}]*\\}\\s*\\]\\s*\\}\\s*,?`, 'u'), '')
    .replace(new RegExp(`\\s*\\{\\s*id:\\s*['"]?${ROW_ID}['"]?[^}]*\\}\\s*,?`, 'u'), '')
    .replace(/,\s*\]/u, ']')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/\n{2,}$/u, '\n');
  // A profile patch file must stay a top-level array; an emptied one goes back to `[]`
  // rather than becoming a comment-only document that YAML reads as null.
  if (semanticContent(flow).length === 0) return `${flow.replace(/\s*$/u, '')}\n[]\n`;
  return withTrailingNewline(flow);
}

/**
 * Report the current symlink state of the profile's package entry.
 * @param linkPath - the entry to inspect.
 * @returns `missing`, `linked` (a symlink into this working copy), `foreign`
 *          (a symlink elsewhere), or `directory`.
 */
function linkState(linkPath) {
  if (!existsSync(linkPath)) return 'missing';
  const stats = lstatSync(linkPath);
  if (!stats.isSymbolicLink()) return 'directory';
  return resolve(dirname(linkPath), readlinkSync(linkPath)) === PLUGIN_DIR ? 'linked' : 'foreign';
}

/**
 * Derive a pnpm GitHub shorthand from this package's `repository` field.
 * @param manifest - this package's manifest.
 * @returns the `github:owner/repo` spec, or `null` when it is not a GitHub URL.
 */
function githubShorthand(manifest) {
  const url = typeof manifest?.repository === 'string' ? manifest.repository : manifest?.repository?.url;
  if (typeof url !== 'string') return null;
  const match = /^(?:git\+)?(?:https?:\/\/|git@)github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/u.exec(url.trim());
  if (match === null) return null;
  return `github:${match[1]}/${match[2]}`;
}

/**
 * Read the `dsh.bundle` declaration a package installed under a profile ships.
 * @param modulesDir - the profile's `node_modules`.
 * @param name - the installed package name.
 * @returns the bundle declaration, or `undefined` when the package has none.
 */
function installedBundle(modulesDir, name) {
  const manifestPath = join(modulesDir, name, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) return undefined;
  try {
    return readManifest(manifestPath)?.dsh?.bundle;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the pnpm executable for a direct `--github` install.
 * @param explicit - `--pnpm` value, if any.
 * @param env - the process environment.
 * @returns the executable to spawn.
 */
function resolvePnpm(explicit, env = process.env) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const fromEnv = env.DSH_PNPM;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  return 'pnpm';
}

/**
 * Resolve a harness CLI that can install into the profile.
 *
 * Preferred over a bare pnpm because `dsh plugin --profile <name> add` runs the
 * pnpm the installation itself ships, takes the profile's write lock, rolls the
 * profile back on failure, and performs the bundle activation — none of which a
 * hand-rolled pnpm invocation gets. The Desktop app's own launcher is the only
 * one allowed to touch the reserved `desktop` profile.
 * @param explicit - `--dsh` value, if any.
 * @param env - the process environment.
 * @returns the launcher path, or `null` when none is found.
 */
function resolveDsh(explicit, env = process.env) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const fromEnv = env.DSH_BIN;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  for (const dir of String(env.PATH ?? '').split(':')) {
    if (dir.length === 0) continue;
    const candidate = join(dir, 'dsh');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Run one command inside the profile directory.
 * @param command - the executable.
 * @param args - the arguments after the executable.
 * @param cwd - the profile directory.
 * @returns `{ ok, code, missing }` describing the outcome.
 */
function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error !== undefined && result.error !== null) {
    return { ok: false, code: null, missing: result.error.code === 'ENOENT' };
  }
  return { ok: result.status === 0, code: result.status, missing: false };
}

/**
 * Run the install or uninstall.
 */
function main() {
  const options = parseArgs(process.argv.slice(2));
  const home = resolveHome(options.home);
  const profile = resolveProfile(options.profile, home);
  const profileDir = join(home, 'profiles', profile);
  const modulesDir = join(profileDir, 'node_modules');
  const linkPath = join(modulesDir, PACKAGE_NAME);
  const manifestPath = join(profileDir, MANIFEST_FILENAME);
  const patchPath = join(profileDir, PATCH_FILENAME);
  const prefix = options.dryRun ? '[dry-run] ' : '';
  const say = (message) => process.stdout.write(`${message}\n`);
  const log = (message) => say(`${prefix}${message}`);

  say(`plugin:  ${PLUGIN_DIR}`);
  say(`home:    ${home}`);
  say(`profile: ${profileDir} (${profile})`);

  if (!existsSync(profileDir)) {
    process.stderr.write(`\ninstall.mjs: the profile directory does not exist yet.\nBoot it once (the Desktop app for "desktop", or \`dsh ${profile}\`) and re-run this installer.\n`);
    process.exit(1);
  }
  if (!existsSync(manifestPath)) {
    process.stderr.write(`\ninstall.mjs: ${manifestPath} is missing; the profile is not initialized.\n`);
    process.exit(1);
  }

  /** Collected bundle names to register or drop, applied in one manifest write. */
  const pending = { register: [], drop: [] };
  /**
   * Record a manifest edit for the single write at the end.
   * @param name - the bundle package name.
   * @param action - `register` or `drop`.
   */
  const queue = (name, action) => {
    if (!pending[action].includes(name)) pending[action].push(name);
  };

  /** Strip the pre-bundle row from the profile's own patch file, once. */
  const migrateLegacyRow = () => {
    if (!existsSync(patchPath)) return;
    const text = readFileSync(patchPath, 'utf8');
    if (!hasRow(text)) return;
    log(`remove legacy row "${ROW_ID}" from ${patchPath} (now provided by the bundle patch)`);
    if (!options.dryRun) writeFileSync(patchPath, stripRow(text));
  };

  if (options.uninstall) {
    const state = linkState(linkPath);
    if (state === 'linked') {
      log(`remove link ${linkPath}`);
      if (!options.dryRun) rmSync(linkPath, { recursive: false, force: true });
    } else if (state !== 'missing') {
      log(`leave ${linkPath} alone (${state === 'directory' ? 'a real directory' : 'a foreign link'}, not installed by this script)`);
    } else {
      log(`no link at ${linkPath}`);
    }
    queue(PACKAGE_NAME, 'drop');
    migrateLegacyRow();

    const manifest = readManifest(manifestPath);
    const dependency = Object.hasOwn(manifest.dependencies ?? {}, PACKAGE_NAME);
    if (dependency) {
      // Mirrors the install choice: the harness CLI removes through the pnpm the
      // installation ships, so the profile lockfile stays consistent with it.
      const pnpm = resolvePnpm(options.pnpm);
      const dsh = options.pnpm !== null ? null : resolveDsh(options.dsh);
      const how = dsh === null
        ? [pnpm, ['remove', PACKAGE_NAME], `${pnpm} remove ${PACKAGE_NAME}`]
        : [dsh, ['plugin', '--profile', profile, 'remove', PACKAGE_NAME], `${dsh} plugin --profile ${profile} remove ${PACKAGE_NAME}`];
      log(`remove profile dependency "${PACKAGE_NAME}" with ${how[2]}`);
      if (!options.dryRun) {
        let result = runCommand(how[0], how[1], profileDir);
        if (!result.ok && dsh !== null && options.dsh === null) {
          process.stderr.write(`install.mjs: "${how[2]}" failed; retrying with pnpm\n`);
          result = runCommand(pnpm, ['remove', PACKAGE_NAME], profileDir);
        }
        if (!result.ok) {
          process.stderr.write(result.missing
            ? `install.mjs: ${how[0]} was not found; remove the dependency from ${manifestPath} by hand\n`
            : `install.mjs: "${how[2]}" failed (exit ${result.code}); the manifest entry is left in place\n`);
        }
      }
    }
  } else if (options.github !== null) {
    const selfManifest = readManifest(join(PLUGIN_DIR, MANIFEST_FILENAME));
    const spec = options.github === true ? githubShorthand(selfManifest) : options.github;
    if (typeof spec !== 'string' || spec.length === 0) {
      process.stderr.write('install.mjs: --github needs a spec, and this package.json carries no GitHub repository URL to derive one from\n');
      process.exit(2);
    }
    // A working-copy symlink would shadow the managed copy the package manager is about to write.
    const state = linkState(linkPath);
    if (state === 'linked') {
      log(`remove local symlink ${linkPath} so the package manager can own ${PACKAGE_NAME}`);
      if (!options.dryRun) rmSync(linkPath, { recursive: false, force: true });
    }
    const before = new Set(Object.keys(readManifest(manifestPath).dependencies ?? {}));
    // Prefer the harness CLI: `dsh plugin --profile <name> add` brings the
    // installation's own pnpm, the profile write lock, rollback, and bundle
    // activation — and its launcher is the only one allowed to touch the
    // reserved `desktop` profile. `--pnpm` opts out of it entirely.
    const pnpm = resolvePnpm(options.pnpm);
    const dsh = options.pnpm !== null ? null : resolveDsh(options.dsh);
    if (options.dryRun) {
      log(dsh === null ? `run ${pnpm} add ${spec} in ${profileDir}` : `run ${dsh} plugin --profile ${profile} add ${spec}`);
      log(`then add every newly installed dependency that declares dsh.bundle to dsh.profile.bundles in ${manifestPath}`);
    } else {
      let outcome = null;
      if (dsh !== null) {
        const how = `${dsh} plugin --profile ${profile} add ${spec}`;
        log(`run ${how}`);
        outcome = runCommand(dsh, ['plugin', '--profile', profile, 'add', spec], profileDir);
        if (outcome.ok) {
          outcome = null;
        } else if (options.dsh !== null) {
          process.stderr.write(`install.mjs: "${how}" failed${outcome.missing ? ' (launcher not found)' : ` (exit ${outcome.code})`}\n`);
          process.exit(1);
        } else {
          // A discovered launcher can be a stale shim, so an explicit --dsh is the
          // only case that gives up here; otherwise pnpm gets a turn.
          process.stderr.write(`install.mjs: "${how}" failed${outcome.missing ? ' (launcher not found)' : ` (exit ${outcome.code})`}; retrying with pnpm\n`);
        }
      }
      if (outcome !== null) {
        const how = `${pnpm} add ${spec}`;
        log(`run ${how} in ${profileDir}`);
        outcome = runCommand(pnpm, ['add', spec], profileDir);
        if (!outcome.ok) {
          process.stderr.write(outcome.missing
            ? `install.mjs: ${pnpm} was not found. Pass --pnpm <path> or --dsh <path>, set $DSH_PNPM/$DSH_BIN, or use the Desktop/Web Plugins panel, which brings its own pnpm.\n`
            : `install.mjs: "${how}" failed (exit ${outcome.code})\n`);
          process.exit(1);
        }
      }
      const added = Object.keys(readManifest(manifestPath).dependencies ?? {}).filter((name) => !before.has(name));
      if (added.length === 0) log(`no new dependency recorded in ${manifestPath}`);
      for (const name of added) {
        if (installedBundle(modulesDir, name) === undefined) {
          log(`warning: ${name} declares no dsh.bundle — installed as a plain dependency, not a profile layer`);
          continue;
        }
        queue(name, 'register');
      }
    }
    migrateLegacyRow();
  } else {
    // The default path: this working copy, linked into the profile.
    if (!existsSync(modulesDir)) {
      log(`create ${modulesDir}`);
      if (!options.dryRun) mkdirSync(modulesDir, { recursive: true });
    }
    const state = linkState(linkPath);
    if (state === 'directory') {
      log(`replace existing directory at ${linkPath}`);
      if (!options.dryRun) rmSync(linkPath, { recursive: true, force: true });
    } else if (state === 'foreign') {
      log(`replace foreign link at ${linkPath}`);
      if (!options.dryRun) rmSync(linkPath, { recursive: false, force: true });
    }
    if (linkState(linkPath) !== 'linked') {
      log(`link ${linkPath} -> ${PLUGIN_DIR}`);
      if (!options.dryRun) symlinkSync(PLUGIN_DIR, linkPath, 'dir');
    } else {
      log(`link already present: ${linkPath}`);
    }
    queue(PACKAGE_NAME, 'register');
    migrateLegacyRow();
  }

  let manifest = readManifest(manifestPath);
  for (const name of pending.drop) {
    const next = withoutBundle(manifest, name);
    if (next.changed) {
      log(`remove "${name}" from dsh.profile.bundles in ${manifestPath}`);
      manifest = next.manifest;
    } else {
      log(`no "${name}" in dsh.profile.bundles`);
    }
  }
  for (const name of pending.register) {
    const next = withBundle(manifest, name);
    if (next.changed) {
      log(`add "${name}" to dsh.profile.bundles in ${manifestPath}`);
      manifest = next.manifest;
    } else {
      log(`"${name}" already a profile bundle`);
    }
  }
  if (!options.dryRun) writeFileSync(manifestPath, serializeManifest(manifest));

  say('');
  if (options.uninstall) {
    say('Uninstalled. Reload the app window (Cmd/Ctrl+R) to drop the header action.');
    return;
  }
  say('Installed. Next steps:');
  say('  1. A running harness reloads the profile tree automatically (dsh-hmr watches the patch files).');
  say('  2. Reload the app window — Cmd/Ctrl+R in Desktop, or refresh the browser page — so the new');
  say('     client bundle enters window.__DSH_BOOT__ and the session-header button appears.');
  say('  3. Confirm the host half came up with:');
  say(`       dsh --profile ${profile} --dump-config-schema > /dev/null`);
  if (options.dryRun) {
    say('');
    say('Nothing was written (--dry-run).');
  }
}

if (isDirectInvocation()) main();

export {
  PACKAGE_NAME,
  PROFILE_PREFERENCE,
  ROW_ID,
  bundleNames,
  githubShorthand,
  hasRow,
  linkState,
  parseArgs,
  resolveDsh,
  resolveHome,
  resolvePnpm,
  resolveProfile,
  serializeManifest,
  stripRow,
  withBundle,
  withoutBundle,
};
