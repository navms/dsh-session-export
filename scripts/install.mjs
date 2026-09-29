#!/usr/bin/env node
/**
 * Install (or uninstall) the session transcript export plugin in a DSH profile.
 *
 * The plugin declares no runtime dependencies, so installation is just a
 * symlink into the profile's `node_modules` plus one row in the profile's
 * `cordis.patch.yml`. Both steps are idempotent and fully reversible; no DSH
 * package and no npx installation directory is touched.
 *
 * Usage:
 *   node scripts/install.mjs [--profile web] [--home <dir>] [--dry-run]
 *   node scripts/install.mjs --uninstall [--profile web]
 *
 * @module dsh-session-export/scripts/install
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Package name of this plugin; also the linker row name and browser bundle id. */
const PACKAGE_NAME = 'dsh-session-export';

/** Loader row id used in the profile patch file. */
const ROW_ID = 'session-transcript-export';

/** Profile patch filename. */
const PATCH_FILENAME = 'cordis.patch.yml';

/** Absolute path of this plugin's package root. */
const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Parse the command line.
 * @param argv - process arguments after the script path.
 * @returns the parsed options.
 */
function parseArgs(argv) {
  const options = { profile: 'web', home: null, uninstall: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--uninstall') options.uninstall = true;
    else if (value === '--dry-run') options.dryRun = true;
    else if (value === '--profile') options.profile = argv[index += 1];
    else if (value === '--home') options.home = argv[index += 1];
    else if (value === '--help' || value === '-h') {
      process.stdout.write(`usage: node scripts/install.mjs [--profile <name>] [--home <dir>] [--dry-run]\n       node scripts/install.mjs --uninstall [--profile <name>] [--home <dir>]\n`);
      process.exit(0);
    } else {
      process.stderr.write(`install.mjs: unknown argument ${JSON.stringify(value)}\n`);
      process.exit(2);
    }
  }
  if (typeof options.profile !== 'string' || options.profile.length === 0) {
    process.stderr.write('install.mjs: --profile requires a value\n');
    process.exit(2);
  }
  return options;
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
 * Report whether the profile patch file already carries this plugin's row.
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
 * Add this plugin's row to a top-level YAML patch array.
 *
 * A profile patch file is a list of *patches*: a bare `- id:`/`name:` row only
 * overrides an entry an earlier layer already declared, so a brand-new row must
 * ride an `insert:` list (exactly how the shipped bundles add their own rows).
 * @param text - the patch file content.
 * @returns the content carrying the row.
 */
function insertRow(text) {
  const block = `- insert:\n    - id: ${ROW_ID}\n      name: '${PACKAGE_NAME}'`;
  const semantic = semanticContent(text);
  if (semantic.length === 0 || semantic === '[]') {
    const lines = text.split('\n');
    const index = lines.findIndex((line) => line.trim() === '[]');
    if (index >= 0) {
      lines[index] = block;
      return withTrailingNewline(lines.join('\n'));
    }
    return `${text.length === 0 ? '' : withTrailingNewline(text)}${block}\n`;
  }
  if (semantic.startsWith('[') && semantic.endsWith(']')) {
    const position = text.lastIndexOf(']');
    const head = text.slice(0, position).replace(/\s*$/u, '');
    return `${head}, { insert: [{ id: '${ROW_ID}', name: '${PACKAGE_NAME}' }] }${text.slice(position)}`;
  }
  return `${withTrailingNewline(text)}\n${block}\n`;
}

/**
 * Remove this plugin's row (block form, or flow form when present) and any
 * `insert:` block it leaves empty.
 * @param text - the patch file content.
 * @returns the content without the row.
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
 * Report the current symlink state.
 * @param linkPath - the link to inspect.
 * @returns `missing`, `linked`, or `other`.
 */
function linkState(linkPath) {
  if (!existsSync(linkPath)) return 'missing';
  const stats = lstatSync(linkPath);
  if (!stats.isSymbolicLink()) return 'other';
  return resolve(dirname(linkPath), readlinkSync(linkPath)) === PLUGIN_DIR ? 'linked' : 'other';
}

/**
 * Run the install or uninstall.
 */
function main() {
  const options = parseArgs(process.argv.slice(2));
  const home = resolveHome(options.home);
  const profileDir = join(home, 'profiles', options.profile);
  const modulesDir = join(profileDir, 'node_modules');
  const linkPath = join(modulesDir, PACKAGE_NAME);
  const patchPath = join(profileDir, PATCH_FILENAME);
  const say = (message) => process.stdout.write(`${message}\n`);
  const log = (message) => say(`${options.dryRun ? '[dry-run] ' : ''}${message}`);

  say(`plugin:  ${PLUGIN_DIR}`);
  say(`home:    ${home}`);
  say(`profile: ${profileDir}`);

  if (!existsSync(profileDir)) {
    process.stderr.write(`\ninstall.mjs: the profile directory does not exist yet.\nBoot it once (\`dsh --profile ${options.profile} --help\` or \`dsh ${options.profile}\`) and re-run this installer.\n`);
    process.exit(1);
  }

  if (options.uninstall) {
    if (existsSync(linkPath)) {
      log(`remove link ${linkPath}`);
      if (!options.dryRun) rmSync(linkPath, { recursive: false, force: true });
    } else {
      log(`no link at ${linkPath}`);
    }
    if (existsSync(patchPath)) {
      const text = readFileSync(patchPath, 'utf8');
      if (hasRow(text)) {
        log(`remove row "${ROW_ID}" from ${patchPath}`);
        if (!options.dryRun) writeFileSync(patchPath, stripRow(text));
      } else {
        log(`no row "${ROW_ID}" in ${patchPath}`);
      }
    }
    log('uninstalled; refresh the browser page to drop the header action.');
    return;
  }

  if (!existsSync(modulesDir)) {
    log(`create ${modulesDir}`);
    if (!options.dryRun) mkdirSync(modulesDir, { recursive: true });
  }
  const state = linkState(linkPath);
  if (state === 'other') {
    log(`replace non-matching entry at ${linkPath}`);
    if (!options.dryRun) rmSync(linkPath, { recursive: true, force: true });
  }
  if (state !== 'linked') {
    log(`link ${linkPath} -> ${PLUGIN_DIR}`);
    if (!options.dryRun) symlinkSync(PLUGIN_DIR, linkPath, 'dir');
  } else {
    log(`link already present: ${linkPath}`);
  }

  if (!existsSync(patchPath)) {
    log(`create ${patchPath}`);
    if (!options.dryRun) writeFileSync(patchPath, `# Your patch layer for this dsh profile.\n[]\n`);
  }
  const patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  if (hasRow(patchText)) {
    log(`row "${ROW_ID}" already present in ${patchPath}`);
  } else {
    const backup = `${patchPath}.${PACKAGE_NAME}.bak`;
    if (existsSync(patchPath) && !existsSync(backup)) {
      log(`back up ${patchPath} -> ${backup}`);
      if (!options.dryRun) writeFileSync(backup, patchText);
    }
    log(`append row "${ROW_ID}" to ${patchPath}`);
    if (!options.dryRun) writeFileSync(patchPath, insertRow(patchText));
  }

  say('');
  say('Installed. Next steps:');
  say('  1. The running `dsh web` reloads the profile tree automatically (dsh-hmr watches the patch file).');
  say('  2. Refresh the browser page so the new client bundle enters window.__DSH_BOOT__.');
  say('  3. Use the download button in the session header, or verify the host half with:');
  say(`       dsh --profile ${options.profile} --dump-config-schema > /dev/null`);
  if (options.dryRun) say('');
  if (options.dryRun) say('Nothing was written (--dry-run).');
}

main();
