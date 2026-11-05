// summary: Real-Git regression coverage for warning-only install checks and doctor integration.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { packageInstallHealth } from './package-install-health.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const POSTS = ['post-checkout', 'post-merge', 'post-rewrite'];
const SOURCES = ['scripts/install-hooks.sh', 'scripts/validate-package-installs.mjs',
  'scripts/tracked-files.mjs', 'scripts/agent-doctor.mjs', 'scripts/package-install-health.mjs',
  'scripts/package-install-hook.sh', ...POSTS.map(name => `.githooks/${name}`)];
function write(root, name, text, mode) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, mode ? { mode } : undefined);
}
function json(root, name, value) { write(root, name, JSON.stringify(value)); }
function env(root) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (key.startsWith('GIT_')) delete clean[key];
  return { ...clean, HOME: path.join(root, 'home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
}
function run(root, command, args, options = {}) {
  return spawnSync(command, args, { cwd: root, env: env(root), encoding: 'utf8', ...options });
}
function git(root, ...args) {
  const result = run(root, 'git', args);
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result;
}
function bump(root, version = '2.0.0', pkg = 'packages/demo') {
  json(root, `${pkg}/package-lock.json`, { lockfileVersion: 3, packages: {
    '': { dependencies: { dep: '*' } }, 'node_modules/dep': { version },
  } });
}
function fixture(t, { chain = false, pkg = 'packages/demo' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install health $fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'home'));
  git(root, 'init', '-q', '-b', 'main');
  write(root, '.gitignore', 'node_modules/\nhome/\n');
  json(root, 'package.json', { name: 'fixture', type: 'module' });
  for (const source of SOURCES) {
    if (fs.existsSync(path.join(ROOT, source))) {
      write(root, source, fs.readFileSync(path.join(ROOT, source)), fs.statSync(path.join(ROOT, source)).mode & 0o777);
    }
  }
  for (const name of ['pre-commit', 'pre-push']) write(root, `.githooks/${name}`, '#!/bin/sh\nexit 0\n', 0o755);
  json(root, `${pkg}/package.json`, { name: 'demo', dependencies: { dep: '*' } });
  bump(root, '1.0.0', pkg);
  json(root, `${pkg}/node_modules/dep/package.json`, { name: 'dep', version: '1.0.0' });
  json(root, `${pkg}/node_modules/.package-lock.json`, { lockfileVersion: 3, packages: {
    'node_modules/dep': { version: '1.0.0' },
  } });
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'baseline');
  if (chain) {
    write(root, '.git/ubs-chain-hooks/pre-commit', '#!/bin/sh\nprintf "ubs\\n" >> .git/ubs-proof\nexec .githooks/pre-commit "$@"\n', 0o755);
    fs.symlinkSync(path.join(root, '.githooks/pre-push'), path.join(root, '.git/ubs-chain-hooks/pre-push'));
    git(root, 'config', 'core.hooksPath', '.git/ubs-chain-hooks');
  }
  return root;
}
function install(root) {
  const result = run(root, 'bash', ['scripts/install-hooks.sh']);
  assert.equal(result.status, 0, result.stderr);
}
function warned(result, event) {
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /package-install-health.*WARNING/s);
  assert.match(result.stderr, new RegExp(event));
  assert.match(result.stderr, /packages\/demo.*installed 1\.0\.0; expected 2\.0\.0/s);
  assert.match(result.stderr, /npm ci/);
}
function changedBranch(root) {
  git(root, 'checkout', '-qb', 'changed');
  bump(root);
  git(root, 'add', 'packages/demo/package-lock.json');
  git(root, 'commit', '-qm', 'new lock');
  git(root, 'checkout', '-q', 'main');
}

test('real fast-forward merge warns without installing or failing Git', t => {
  const root = fixture(t);
  changedBranch(root);
  install(root);
  const before = fs.readFileSync(path.join(root, 'packages/demo/node_modules/dep/package.json'));
  warned(git(root, 'merge', '--ff-only', 'changed'), 'post-merge');
  assert.deepEqual(fs.readFileSync(path.join(root, 'packages/demo/node_modules/dep/package.json')), before);
});
test('real branch and file-only checkout warn; clean checkout is quiet', t => {
  const root = fixture(t);
  changedBranch(root);
  install(root);
  assert.doesNotMatch(git(root, 'checkout', '-q', 'main').stderr, /package-install-health/);
  warned(git(root, 'checkout', '-q', 'changed'), 'post-checkout');
  bump(root, '1.0.0');
  warned(git(root, 'checkout', 'HEAD', '--', 'packages/demo/package-lock.json'), 'post-checkout');
});
test('real amend and rebase fire post-rewrite without installing', t => {
  const root = fixture(t);
  install(root);
  bump(root);
  git(root, 'add', 'packages/demo/package-lock.json');
  warned(git(root, 'commit', '--amend', '--no-edit'), 'post-rewrite');
  git(root, 'checkout', '-qb', 'topic');
  write(root, 'topic.txt', 'topic'); git(root, 'add', 'topic.txt'); git(root, 'commit', '-qm', 'topic');
  git(root, 'checkout', '-q', 'main');
  write(root, 'main.txt', 'main'); git(root, 'add', 'main.txt'); git(root, 'commit', '-qm', 'main');
  git(root, 'checkout', '-q', 'topic');
  warned(git(root, 'rebase', 'main'), 'post-rewrite');
});
test('installer preserves the enabled UBS chain and is idempotent', t => {
  const root = fixture(t, { chain: true });
  const pre = fs.readFileSync(path.join(root, '.git/ubs-chain-hooks/pre-commit'));
  const push = fs.readlinkSync(path.join(root, '.git/ubs-chain-hooks/pre-push'));
  install(root); install(root);
  assert.equal(git(root, 'config', '--get', 'core.hooksPath').stdout.trim(), '.git/ubs-chain-hooks');
  assert.deepEqual(fs.readFileSync(path.join(root, '.git/ubs-chain-hooks/pre-commit')), pre);
  assert.equal(fs.readlinkSync(path.join(root, '.git/ubs-chain-hooks/pre-push')), push);
  changedBranch(root);
  warned(git(root, 'merge', '--ff-only', 'changed'), 'post-merge');
  assert.equal(fs.readFileSync(path.join(root, '.git/ubs-proof'), 'utf8'), 'ubs\n');
});
test('installer refuses unknown hook owners before any wiring changes', t => {
  // An explicit custom path is an owner boundary even before its hooks exist.
  const root = fixture(t);
  git(root, 'config', 'core.hooksPath', 'custom-hooks');
  const result = run(root, 'bash', ['scripts/install-hooks.sh']);
  assert.notEqual(result.status, 0);
  assert.equal(git(root, 'config', '--get', 'core.hooksPath').stdout.trim(), 'custom-hooks');
});
test('unset hooksPath cannot silently bypass active default hooks', t => {
  const root = fixture(t);
  write(root, '.git/hooks/post-checkout', '#!/bin/sh\necho OWNER_HOOK >&2\n', 0o755);
  const before = fs.readFileSync(path.join(root, '.git/hooks/post-checkout'));
  assert.notEqual(run(root, 'bash', ['scripts/install-hooks.sh']).status, 0);
  assert.equal(run(root, 'git', ['config', '--get', 'core.hooksPath']).status, 1);
  assert.deepEqual(fs.readFileSync(path.join(root, '.git/hooks/post-checkout')), before);
  assert.match(git(root, 'checkout', '-q', 'main').stderr, /OWNER_HOOK/);
});
test('installer does not overwrite existing chain post hooks or partially install others', t => {
  const root = fixture(t, { chain: true });
  write(root, '.git/ubs-chain-hooks/post-merge', '#!/bin/sh\necho custom\n', 0o755);
  const before = fs.readFileSync(path.join(root, '.git/ubs-chain-hooks/post-merge'));
  assert.notEqual(run(root, 'bash', ['scripts/install-hooks.sh']).status, 0);
  assert.deepEqual(fs.readFileSync(path.join(root, '.git/ubs-chain-hooks/post-merge')), before);
  assert.equal(fs.existsSync(path.join(root, '.git/ubs-chain-hooks/post-checkout')), false);
});
test('doctor exposes consistency separately, including with --no-drift', t => {
  const root = fixture(t);
  const doctor = () => run(root, process.execPath, ['scripts/agent-doctor.mjs', '--json', '--no-drift']);
  const clean = doctor();
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(JSON.parse(clean.stdout).info.installConsistency.ok, true);
  bump(root);
  const stale = doctor();
  assert.equal(stale.status, 1, stale.stderr);
  const report = JSON.parse(stale.stdout);
  assert.equal(report.info.drift, 'skipped');
  assert.equal(report.info.installConsistency.ok, false);
  assert.ok(report.info.installConsistency.issues.some(issue => issue.package === 'packages/demo'));
});
test('doctor reports checker failure rather than healthy status', t => {
  const root = fixture(t);
  fs.rmSync(path.join(root, '.git'), { recursive: true });
  const result = run(root, process.execPath, ['scripts/agent-doctor.mjs', '--json', '--no-drift']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).info.installConsistency.ok, false);
});
test('linked worktree post hooks inspect that worktree, not canonical installs', t => {
  const root = fixture(t, { chain: true });
  install(root);
  const linked = path.join(root, 'linked');
  git(root, '-c', 'core.hooksPath=.githooks', 'worktree', 'add', '--detach', linked, 'HEAD');
  // The linked tree owns its own install, and that install is what its hook must judge. Absence there
  // is reported as "not installed here" rather than warned about, so the finding has to be real drift.
  json(linked, 'packages/demo/node_modules/.package-lock.json', { lockfileVersion: 3, packages: {
    'node_modules/dep': { version: '0.9.0' },
  } });
  json(linked, 'packages/demo/node_modules/dep/package.json', { name: 'dep', version: '0.9.0' });
  const result = git(linked, '-c', 'core.hooksPath=.githooks', 'checkout', '-q', '-b', 'linked-own');
  assert.match(result.stderr, /package-install-health.*WARNING/s);
  assert.match(result.stderr, /packages\/demo/);
  assert.match(result.stderr, /installed 0\.9\.0; expected 1\.0\.0/);
});
test('group package paths with shell metacharacters get a quoted manual repair', t => {
  const pkg = "packages/group/demo $cash's";
  const root = fixture(t, { pkg });
  install(root);
  bump(root, '2.0.0', pkg);
  const result = git(root, 'checkout', '-q', 'main');
  assert.match(result.stderr, /WARNING/);
  assert.ok(result.stderr.includes("npm ci --prefix 'packages/group/demo $cash'\\''s'"), result.stderr);
  assert.equal(fs.existsSync(path.join(root, 'cash')), false);
});

test('squash merge and removed lockfiles still report current-tree inconsistency', t => {
  const root = fixture(t);
  changedBranch(root); install(root);
  warned(git(root, 'merge', '--squash', 'changed'), 'post-merge');
  git(root, 'rm', '-f', 'packages/demo/package-lock.json');
  const result = git(root, 'checkout', '-q', 'main');
  assert.match(result.stderr, /requires a tracked package-lock/);
});
test('a tracked package that owns no install is reported, not failed', t => {
  const root = fixture(t);
  // Tracked, with a lock, but never installed in this checkout: nothing here can be stale.
  json(root, 'packages/never/package.json', { name: 'never', dependencies: { dep: '*' } });
  json(root, 'packages/never/package-lock.json', { lockfileVersion: 3, packages: {
    '': { name: 'never', dependencies: { dep: '*' } },
    'node_modules/dep': { version: '1.0.0', resolved: 'https://registry.example/dep-1.0.0.tgz', integrity: 'sha512-1.0.0' },
  } });
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'a package that is never installed here');
  // Isolated settings naming nothing: ownership is proven, so a plain absence can be excused.
  json(root, 'home/.pi/agent/settings.json', { packages: [] });
  const health = () => run(root, process.execPath, ['scripts/package-install-health.mjs']);

  // The build gate keeps the strict reading: there, absence means the tree was not prepared.
  const strict = run(root, process.execPath, ['scripts/validate-package-installs.mjs']);
  assert.equal(strict.status, 1, strict.stdout);
  assert.match(strict.stderr, /packages\/never/);

  const owned = health();
  assert.equal(owned.status, 0, owned.stdout + owned.stderr);
  assert.match(owned.stdout, /consistent \(2 package\(s\)/);
  assert.match(owned.stdout, /1 package\(s\) provably not installed here.*packages\/never/);

  // Ownership is presence, not the absence of a finding: an install that exists must agree with
  // its lock, so the gate cannot be satisfied by having nothing installed.
  bump(root);
  const stale = health();
  assert.equal(stale.status, 1, stale.stdout);
  assert.match(stale.stdout, /node_modules\/dep: installed 1\.0\.0; expected 2\.0\.0/);
});

test('an install that exists but has no npm metadata is still fatal', t => {
  const root = fixture(t);
  fs.rmSync(path.join(root, 'packages/demo/node_modules/.package-lock.json'));
  const result = run(root, process.execPath, ['scripts/package-install-health.mjs']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /packages\/demo/);
  assert.match(result.stdout, /node_modules\/\.package-lock\.json/);
});

test('only a proven absence is excused: authored and structural failures stay fatal', t => {
  const cases = [
    {
      name: 'an authored manifest/lock disagreement',
      manifest: { name: 'never', dependencies: { dep: '*' } },
      lock: { lockfileVersion: 3, packages: { '': { name: 'never', dependencies: { other: '*' } } } },
      expected: /package\.json dependencies differs from package-lock\.json/,
    },
    {
      name: 'a lock that is not a v3 packages lock',
      manifest: { name: 'never', dependencies: { dep: '*' } },
      lock: { lockfileVersion: 2, packages: {} },
      expected: /v3 packages lock/,
    },
    {
      name: 'a dependency-bearing package with no tracked lock',
      manifest: { name: 'never', dependencies: { dep: '*' } },
      lock: undefined,
      expected: /requires a tracked package-lock\.json/,
    },
    {
      name: 'a false registry artifact identity',
      manifest: { name: 'never', dependencies: { dep: '*' } },
      lock: { lockfileVersion: 3, packages: {
        '': { name: 'never', dependencies: { dep: '*' } },
        'node_modules/dep': { version: '1.0.0', resolved: 'https://registry.npmjs.org/dep/-/dep-2.0.0.tgz', integrity: 'sha512-x' },
      } },
      expected: /locked version 1\.0\.0 disagrees with npm tarball URL/,
    },
  ];

  for (const scenario of cases) {
    const root = fixture(t);
    json(root, 'packages/never/package.json', scenario.manifest);
    if (scenario.lock) json(root, 'packages/never/package-lock.json', scenario.lock);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', scenario.name);
    assert.equal(fs.existsSync(path.join(root, 'packages/never/node_modules')), false, 'the absence is real');

    const result = run(root, process.execPath, ['scripts/package-install-health.mjs']);
    assert.equal(result.status, 1, `${scenario.name} must stay fatal:\n${result.stdout}`);
    assert.match(result.stdout + result.stderr, scenario.expected, scenario.name);
    assert.doesNotMatch(result.stdout, /provably not installed here: .*packages\/never/, scenario.name);
  }
});

test('a dangling node_modules symlink is not a proven absence', t => {
  const root = fixture(t);
  json(root, 'packages/never/package.json', { name: 'never', dependencies: { dep: '*' } });
  json(root, 'packages/never/package-lock.json', { lockfileVersion: 3, packages: {
    '': { name: 'never', dependencies: { dep: '*' } },
    'node_modules/dep': { version: '1.0.0', resolved: 'https://registry.example/dep-1.0.0.tgz', integrity: 'sha512-1.0.0' },
  } });
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'never installed');
  // The entry exists, so nothing here is provably absent: this is a broken install, not a missing one.
  fs.symlinkSync(path.join(root, 'gone'), path.join(root, 'packages/never/node_modules'));

  const result = run(root, process.execPath, ['scripts/package-install-health.mjs']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /packages\/never/);
  assert.doesNotMatch(result.stdout, /provably not installed here: .*packages\/never/);
});

test('a package the live Pi loads is never excused by absence', t => {
  const root = fixture(t);
  json(root, 'packages/never/package.json', { name: 'never', dependencies: { dep: '*' } });
  json(root, 'packages/never/package-lock.json', { lockfileVersion: 3, packages: {
    '': { name: 'never', dependencies: { dep: '*' } },
    'node_modules/dep': { version: '1.0.0', resolved: 'https://registry.example/dep-1.0.0.tgz', integrity: 'sha512-1.0.0' },
  } });
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'never installed');
  const settings = path.join(root, 'home', 'pi-settings.json');
  // Every form Pi's isLocalPath() accepts as local, including `file:`, `~` and a path relative to the
  // settings file. A scheme-shaped string must not be mistaken for a package source.
  const localForms = [
    ['an absolute path', () => path.join(root, 'packages/never')],
    ['a file: URL', () => `file://${path.join(root, 'packages/never')}`],
    ['a tilde path', () => '~/../packages/never'],
    ['a path relative to the settings file', () => '../packages/never'],
  ];
  for (const [name, source] of localForms) {
    json(root, 'home/pi-settings.json', { packages: [source()] });
    // The fixture's own home, so `~` lands inside it instead of the operator's real home directory.
    const live = packageInstallHealth(root, { settingsPath: settings, homeDir: path.join(root, 'home') });
    assert.deepEqual(live.liveOwners, ['packages/never'], `${name} is recognised as local`);
    assert.equal(live.ok, false, `${name}: absence is fatal for a package Pi loads from this checkout`);
    assert.ok(live.issues.some(issue => issue.package === 'packages/never'), name);
    assert.deepEqual(live.notInstalled, [], name);
  }

  // The same tree is admitted only when ownership is proven and names nothing: the rule is ownership,
  // not installation alone.
  json(root, 'home/pi-settings.json', { packages: [] });
  const unused = packageInstallHealth(root, { settingsPath: settings });
  assert.equal(unused.ownershipProven, true);
  assert.equal(unused.ok, true, JSON.stringify(unused.issues));
  assert.deepEqual(unused.notInstalled, ['packages/never']);
});

test('unreadable or malformed settings never excuse an absence', t => {
  const root = fixture(t);
  json(root, 'packages/never/package.json', { name: 'never', dependencies: { dep: '*' } });
  json(root, 'packages/never/package-lock.json', { lockfileVersion: 3, packages: {
    '': { name: 'never', dependencies: { dep: '*' } },
    'node_modules/dep': { version: '1.0.0', resolved: 'https://registry.example/dep-1.0.0.tgz', integrity: 'sha512-1.0.0' },
  } });
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'never installed');
  const settings = path.join(root, 'home', 'pi-settings.json');
  const cases = [
    ['missing settings', () => {}],
    ['unparseable settings', () => write(root, 'home/pi-settings.json', '{ not json')],
    ['settings without a packages array', () => json(root, 'home/pi-settings.json', { packages: 'nope' })],
    ['a local source it cannot resolve', () => json(root, 'home/pi-settings.json', { packages: ['file://%zz'] })],
  ];

  for (const [name, prepare] of cases) {
    fs.rmSync(settings, { force: true });
    prepare();
    const result = packageInstallHealth(root, { settingsPath: settings });
    assert.equal(result.ownershipProven, false, `${name} must not prove ownership`);
    assert.deepEqual(result.notInstalled, [], `${name} must not excuse anything`);
    assert.equal(result.ok, false, `${name} must fail closed`);
    assert.ok(result.issues.some(issue => issue.package === 'packages/never'), name);
  }
});

test('unavailable Node warns without failing the real Git operation', t => {
  const root = fixture(t); install(root);
  const bin = path.join(root, 'home/bin'); fs.mkdirSync(bin);
  for (const command of ['git', 'bash']) {
    const location = spawnSync('which', [command], { encoding: 'utf8' }).stdout.trim();
    fs.symlinkSync(location, path.join(bin, command));
  }
  const result = run(root, 'git', ['checkout', '-q', 'main'], { env: { ...env(root), PATH: bin } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Node unavailable/);
});
test('checker launch failures warn, and rewrite hook drains large stdin', t => {
  const root = fixture(t); install(root);
  fs.rmSync(path.join(root, 'scripts/package-install-health.mjs'));
  const result = run(root, 'bash', ['.githooks/post-rewrite', 'amend'], { input: 'a'.repeat(1024 * 1024) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /checker could not finish/);
});
