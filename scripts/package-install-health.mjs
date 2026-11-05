#!/usr/bin/env node
// summary: Shared read-only install health for Git warnings, doctor and the canonical landing; excuses only a proven absence whose ownership is proven, and fails closed otherwise.
// read_when:
//   - "A landing is blocked by packages this checkout never installed."
//   - "Changing how scripts/land-canonical.sh admits installs before moving the live runtime."
// Why (AK6069 follow-up): the admission read "this package was never installed here" as an
// inconsistency, so a landing failed on every uninstalled sibling. The only finding that may be
// excused is a *proven* absence: no node_modules directory at all, on a package whose authored lock is
// valid, whose only install finding is that absence, and which the live Pi does not load from here.
// Everything else stays fatal — an authored manifest/lock disagreement, a malformed or missing lock, a
// bad registry identity, a permission error, a dangling symlink, or a package Pi actually loads. The
// build gate keeps the strict reading in scripts/validate-package-installs.mjs, where an uninstalled
// tree is a failure; this file decides what a *landing* is responsible for, not what CI requires.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackedFiles } from './tracked-files.mjs';
import { validateAuthoredLocks, validatePackageInstalls } from './validate-package-installs.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), '..');
const EVENTS = new Set(['post-checkout', 'post-merge', 'post-rewrite']);
const DEFAULT_SETTINGS = path.join(os.homedir(), '.pi', 'agent', 'settings.json');
const NAMED_NOT_INSTALLED = 5;
// Pi's isLocalPath(): only these prefixes are package sources. Bare names, relative paths, `~` and
// `file:` URLs are all local, so treating a scheme-shaped string as remote is how a live owner hides.
const NON_LOCAL_SOURCE = /^(?:npm|git|github|http|https|ssh|builtin):/;
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

/** Pi's normalizePath(): trim, `~` expansion, then `file://` through fileURLToPath. */
function normalizeLocalSource(source, homeDir) {
  const trimmed = source.trim();
  if (trimmed === '~') return homeDir;
  if (trimmed.startsWith('~/') || (process.platform === 'win32' && trimmed.startsWith('~\\'))) {
    return path.join(homeDir, trimmed.slice(2));
  }
  if (/^file:\/\//.test(trimmed)) return fileURLToPath(trimmed);
  return trimmed;
}

/**
 * Package labels the live Pi loads out of this checkout, from its own settings.
 *
 * `readable: false` means ownership could not be established at all (missing, unreadable or malformed
 * settings), and `unresolved` holds local sources this code cannot resolve — an unhandled local form is
 * not evidence of absence. Both states are returned rather than swallowed, so the caller fails closed
 * instead of excusing a package the runtime may load.
 *
 * Relative sources are resolved against the settings directory, and also against the checkout root:
 * Pi's base directory for a settings entry is not guaranteed to be the former, and an owner recognised
 * under either reading is still an owner. Extra recognition can only make admission stricter.
 */
export function liveRuntimeOwners(root, settingsPath = DEFAULT_SETTINGS, { homeDir = os.homedir() } = {}) {
  const resolved = path.resolve(root);
  let settings;
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch { return { owners: [], readable: false, unresolved: [] }; }
  if (!settings || typeof settings !== 'object' || (settings.packages !== undefined && !Array.isArray(settings.packages))) {
    return { owners: [], readable: false, unresolved: [] };
  }

  const baseDirs = [...new Set([path.dirname(path.resolve(settingsPath)), resolved])];
  const owners = new Set();
  const unresolved = [];
  for (const entry of settings.packages ?? []) {
    const source = typeof entry === 'string' ? entry : entry?.source;
    if (typeof source !== 'string') continue;
    if (NON_LOCAL_SOURCE.test(source.trim())) continue;
    let local;
    try { local = normalizeLocalSource(source, homeDir); }
    catch { unresolved.push(source); continue; }
    for (const base of baseDirs) {
      const candidate = path.isAbsolute(local) ? local : path.resolve(base, local);
      let real;
      try { real = fs.realpathSync(candidate); } catch { continue; }
      if (inside(resolved, real)) owners.add(path.relative(resolved, real) || '.');
    }
  }
  return { owners: [...owners].sort(), readable: true, unresolved };
}

/** Absence is provable only when the directory itself is missing; a dangling symlink is present. */
function provablyAbsent(dir) {
  try { fs.lstatSync(path.join(dir, 'node_modules')); return false; }
  catch (error) { return error.code === 'ENOENT'; }
}

const isAbsenceFinding = message =>
  message.includes('ENOENT') && message.includes('node_modules/.package-lock.json');

/**
 * What a landing is responsible for.
 *
 * `issues` is everything that must still block: authored manifest/lock disagreement, structural lock
 * defects, and any install finding on a package that owns an install or that Pi loads from here.
 * `notInstalled` names the packages excused, which is only ever the absence itself, and only while
 * ownership is proven.
 */
export function packageInstallHealth(root = ROOT, { settingsPath = DEFAULT_SETTINGS, homeDir = os.homedir() } = {}) {
  const resolved = path.resolve(root);
  try {
    const authored = validateAuthoredLocks(resolved);
    const fleet = validatePackageInstalls(resolved);
    const live = liveRuntimeOwners(resolved, settingsPath, { homeDir });
    // Without readable settings, or with a local source shape this code cannot resolve, nothing proves
    // that an absent package is not loaded by the runtime, so no absence may be excused.
    const ownershipProven = live.readable && live.unresolved.length === 0;
    const tracked = new Set(trackedFiles(resolved));
    const authoredOwners = new Set(authored.issues.map(issue => issue.package));

    const byOwner = new Map();
    for (const issue of fleet.issues) {
      const list = byOwner.get(issue.package) ?? [];
      list.push(issue);
      byOwner.set(issue.package, list);
    }

    const issues = [...authored.issues];
    const notInstalled = [];
    for (const [label, ownerIssues] of byOwner) {
      const excusable =
        ownershipProven &&
        ownerIssues.length === 1 &&
        isAbsenceFinding(ownerIssues[0].message) &&
        label !== '.' &&
        !authoredOwners.has(label) &&
        !live.owners.includes(label) &&
        tracked.has(path.join(resolved, label, 'package-lock.json')) &&
        provablyAbsent(path.join(resolved, label));
      if (excusable) notInstalled.push(label);
      else issues.push(...ownerIssues);
    }

    return {
      ok: issues.length === 0,
      packageCount: fleet.packageCount,
      issues,
      notInstalled: notInstalled.sort(),
      liveOwners: live.owners,
      settingsReadable: live.readable,
      unresolvedLiveSources: live.unresolved,
      ownershipProven,
    };
  } catch (error) {
    return {
      ok: false,
      packageCount: null,
      issues: [{ package: '.', message: `check unavailable: ${error.message}` }],
      notInstalled: [],
      liveOwners: [],
      settingsReadable: false,
      unresolvedLiveSources: [],
      ownershipProven: false,
    };
  }
}

function describeNotInstalled(labels) {
  if (labels.length === 0) return 'every tracked package owns an install or is not excused';
  const named = labels.slice(0, NAMED_NOT_INSTALLED).join(', ');
  const more = labels.length > NAMED_NOT_INSTALLED ? `, +${labels.length - NAMED_NOT_INSTALLED} more` : '';
  return `${labels.length} package(s) provably not installed here: ${named}${more}`;
}

function describeLive(result) {
  if (!result.settingsReadable) {
    return 'live Pi owners unknown (settings missing or unreadable); no absence is excused';
  }
  if (result.unresolvedLiveSources?.length) {
    return `live Pi owners unknown (unresolvable local source: ${result.unresolvedLiveSources.join(', ')}); no absence is excused`;
  }
  if (result.liveOwners.length === 0) return 'no package is loaded from this checkout';
  return `required by the live Pi: ${result.liveOwners.join(', ')}`;
}

export function formatInstallHealth(result) {
  const footer = [describeNotInstalled(result.notInstalled ?? []), describeLive(result)];
  if (result.ok) {
    return [
      `consistent (${result.packageCount} package(s); metadata/versions, not code integrity)`,
      ...footer,
    ];
  }
  const lines = ['stale/inconsistent installs or unavailable check; no installs/builds performed.'];
  for (const label of new Set(result.issues.map(issue => issue.package))) {
    const issues = result.issues.filter(issue => issue.package === label);
    lines.push(`- ${label}: ${issues.length} issue(s)`);
    for (const issue of issues.slice(0, 8)) lines.push(`  ${issue.message}`);
    if (issues.length > 8) lines.push(`  ... ${issues.length - 8} more`);
    lines.push(`  After reconciling authored locks and coordinating with live readers: npm ci --prefix ${quote(label)}`);
  }
  lines.push(`Run repairs from this checkout with the pinned toolchain; npm ci removes node_modules and may rebuild dist.`);
  lines.push(`Reload/restart affected Pi sessions after an explicitly coordinated sync. See docs/project/pre-push-inputs.md.`);
  lines.push(...footer);
  return lines;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  const args = process.argv.slice(2);
  const hook = args.length === 2 && args[0] === '--hook' && EVENTS.has(args[1]);
  if (args.length && !hook) {
    console.error('Usage: package-install-health.mjs [--hook post-checkout|post-merge|post-rewrite]');
    process.exitCode = 2;
  } else {
    const result = packageInstallHealth();
    if (hook) {
      if (!result.ok) console.error(`package-install-health (${args[1]}): WARNING\n${formatInstallHealth(result).join('\n')}\nExisting drift may predate this Git operation; Git was not blocked.`);
    } else {
      console.log(`package-install-health: ${formatInstallHealth(result).join('\n')}`);
      process.exitCode = result.ok ? 0 : 1;
    }
  }
}
