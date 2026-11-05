#!/usr/bin/env node
// summary: Shared read-only install health for Git warnings, doctor and the canonical landing; never repairs installs, and excuses only a proven absence of node_modules.
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
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;

/** Package labels the live Pi loads out of this checkout, from its own settings. */
export function liveRuntimeOwners(root, settingsPath = DEFAULT_SETTINGS) {
  const resolved = path.resolve(root);
  let settings;
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch { return { owners: [], readable: false }; }
  const owners = new Set();
  for (const entry of Array.isArray(settings?.packages) ? settings.packages : []) {
    const source = typeof entry === 'string' ? entry : entry?.source;
    if (typeof source !== 'string' || /^[a-z]+:/i.test(source)) continue;
    let real;
    try { real = fs.realpathSync(path.resolve(path.dirname(settingsPath), source)); } catch { continue; }
    const relative = path.relative(resolved, real);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    owners.add(relative || '.');
  }
  return { owners: [...owners].sort(), readable: true };
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
 * `notInstalled` names the packages excused, which is only ever the absence itself.
 */
export function packageInstallHealth(root = ROOT, { settingsPath = DEFAULT_SETTINGS } = {}) {
  const resolved = path.resolve(root);
  try {
    const authored = validateAuthoredLocks(resolved);
    const fleet = validatePackageInstalls(resolved);
    const live = liveRuntimeOwners(resolved, settingsPath);
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
    };
  } catch (error) {
    return {
      ok: false,
      packageCount: null,
      issues: [{ package: '.', message: `check unavailable: ${error.message}` }],
      notInstalled: [],
      liveOwners: [],
      settingsReadable: false,
    };
  }
}

function describeNotInstalled(labels) {
  if (labels.length === 0) return 'every tracked package owns an install';
  const named = labels.slice(0, NAMED_NOT_INSTALLED).join(', ');
  const more = labels.length > NAMED_NOT_INSTALLED ? `, +${labels.length - NAMED_NOT_INSTALLED} more` : '';
  return `${labels.length} package(s) provably not installed here: ${named}${more}`;
}

function describeLive(result) {
  if (!result.settingsReadable) return 'live Pi owners unknown (no readable settings); the smoke is the runtime gate';
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
