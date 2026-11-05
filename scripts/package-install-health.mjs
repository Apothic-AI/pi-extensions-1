#!/usr/bin/env node
// summary: Shared read-only install health for Git warnings and doctor; never repairs live installations, and can admit one explicit owner selection.
// read_when:
//   - "A landing or gate must admit specific package owners instead of the whole checkout."
//   - "Changing how scripts/land-canonical.sh admits installs before moving the live runtime."
// Why (AK6069 follow-up): the fleet-wide admission is the right default and stays the default, but it
// cannot distinguish "this package was never installed here" from "this package's install is stale".
// A landing that touches one package therefore fails on every uninstalled sibling. An explicit
// selection says which owners the caller is responsible for; it is never inferred from nothing, and an
// empty or unknown selection is refused rather than silently admitting nothing or the whole fleet.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackedPackageDirs, validatePackageInstalls } from './validate-package-installs.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), '..');
const EVENTS = new Set(['post-checkout', 'post-merge', 'post-rewrite']);
const USAGE = 'Usage: package-install-health.mjs [--hook post-checkout|post-merge|post-rewrite] [--package-root PATH]...';
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;

/** Fleet-wide by default; an explicit `packageRoots` narrows to the owners the caller names. */
export function packageInstallHealth(root = ROOT, { packageRoots } = {}) {
  try { return validatePackageInstalls(root, packageRoots === undefined ? undefined : { packageRoots }); }
  catch (error) {
    return { ok: false, packageCount: null, issues: [{ package: '.', message: `check unavailable: ${error.message}` }] };
  }
}

/**
 * Resolve an explicit owner selection to repo-relative package labels.
 * Only tracked packages that install from a tracked lock are admission subjects, so anything else is
 * an unknown owner: a typo, a directory that is not a package, or a dependency-free root. Refusing is
 * the point — a selection that resolves to nothing would report "consistent" without checking anything.
 */
export function resolveOwnerSelection(root, selections) {
  const resolved = path.resolve(root);
  const known = new Map(trackedPackageDirs(resolved).map(dir => [path.relative(resolved, dir) || '.', dir]));
  const labels = [...new Set(selections.map(selection => {
    const label = path.relative(resolved, path.resolve(resolved, selection)) || '.';
    if (!known.has(label)) throw new Error(`unknown package owner: ${selection} (select a tracked package with a tracked package-lock.json)`);
    return label;
  }))].sort();
  if (labels.length === 0) throw new Error('empty package selection: name at least one owner, or omit --package-root for the fleet-wide check');
  return labels;
}

export function formatInstallHealth(result, selection = []) {
  const scope = selection.length ? `; scoped to: ${selection.join(', ')}` : '';
  if (result.ok) return [`consistent (${result.packageCount} package(s)${scope}; metadata/versions, not code integrity)`];
  const lines = [`stale/inconsistent installs or unavailable check${scope}; no installs/builds performed.`];
  for (const label of new Set(result.issues.map(issue => issue.package))) {
    const issues = result.issues.filter(issue => issue.package === label);
    lines.push(`- ${label}: ${issues.length} issue(s)`);
    for (const issue of issues.slice(0, 8)) lines.push(`  ${issue.message}`);
    if (issues.length > 8) lines.push(`  ... ${issues.length - 8} more`);
    lines.push(`  After reconciling authored locks and coordinating with live readers: npm ci --prefix ${quote(label)}`);
  }
  lines.push('Run repairs from this checkout with the pinned toolchain; npm ci removes node_modules and may rebuild dist.');
  lines.push('Reload/restart affected Pi sessions after an explicitly coordinated sync. See docs/project/pre-push-inputs.md.');
  return lines;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  const usage = message => {
    if (message) console.error(`package-install-health: ${message}`);
    console.error(USAGE);
    process.exit(2);
  };
  const args = process.argv.slice(2);
  let hook = null;
  const selections = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--hook') {
      hook = args[index + 1];
      index += 1;
      if (!EVENTS.has(hook)) usage(`unknown Git hook: ${hook ?? '(missing)'}`);
    } else if (value === '--package-root') {
      const selection = args[index + 1];
      index += 1;
      if (selection === undefined || selection.startsWith('--')) usage('--package-root needs a package path');
      selections.push(selection);
    } else usage(`unknown argument: ${value}`);
  }
  // A post-Git warning reports on the whole checkout; narrowing it would hide the drift it exists for.
  if (hook && selections.length) usage('a Git hook warns about the whole checkout; --package-root would narrow it');

  let selection = [];
  if (selections.length) {
    try { selection = resolveOwnerSelection(ROOT, selections); }
    catch (error) { usage(error.message); }
  }

  if (hook) {
    const result = packageInstallHealth(ROOT);
    if (!result.ok) console.error(`package-install-health (${hook}): WARNING\n${formatInstallHealth(result).join('\n')}\nExisting drift may predate this Git operation; Git was not blocked.`);
  } else {
    const result = packageInstallHealth(ROOT, selection.length ? { packageRoots: selection } : {});
    console.log(`package-install-health: ${formatInstallHealth(result, selection).join('\n')}`);
    process.exitCode = result.ok ? 0 : 1;
  }
}
