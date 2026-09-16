import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chooseLauncherPath,
  discoverBootstrap,
  handoffLauncher,
  removeOwnedLauncher,
  renderLauncher,
  resolveNpmRestore,
  restoreGlobalNpm,
} from '../src/deploy/launcher.js';

const packageName = '@karpeleslab/teamclaude';

function result(code = 0, stdout = '', stderr = '') {
  return { code, stdout, stderr };
}

test('bootstrap discovery keeps the executable matching the running Node across Homebrew and NVM', () => {
  const fixture = nodePath => ({
    execPath: nodePath,
    nodeVersion: '24.19.0',
    pathEnv: `${nodePath.slice(0, nodePath.lastIndexOf('/'))}:/usr/bin`,
    findExecutable: command => command === 'node' ? nodePath : `${nodePath.slice(0, nodePath.lastIndexOf('/'))}/npm`,
    realpath: value => value,
    isExecutable: () => true,
    installKind: 'global',
    packageVersion: '1.1.13',
    invokedCommandPath: '/usr/local/bin/teamclaude',
  });

  assert.equal(discoverBootstrap(fixture('/opt/homebrew/bin/node')).nodePath, '/opt/homebrew/bin/node');
  assert.equal(
    discoverBootstrap(fixture('/Users/a/.nvm/versions/node/v24.19.0/bin/node')).nodePath,
    '/Users/a/.nvm/versions/node/v24.19.0/bin/node',
  );
});

test('bootstrap discovery rejects old Node and ignores a PATH node from another installation', () => {
  assert.throws(() => discoverBootstrap({ execPath: '/node', nodeVersion: '18.20.0' }), /Node.js 20/);
  const bootstrap = discoverBootstrap({
    execPath: '/opt/homebrew/bin/node',
    nodeVersion: '24.19.0',
    findExecutable: command => command === 'node' ? '/usr/local/bin/node' : '/opt/homebrew/bin/npm',
    realpath: value => value,
    isExecutable: value => value !== '/usr/local/bin/node',
    installKind: 'git',
    packageVersion: '1.1.13',
    invokedCommandPath: '/checkout/src/index.js',
  });
  assert.equal(bootstrap.nodePath, '/opt/homebrew/bin/node');
  assert.equal(bootstrap.npmPath, '/opt/homebrew/bin/npm');
});

test('bootstrap discovery finds npm beside NVM Node when non-interactive PATH omits NVM', () => {
  const nodePath = '/root/.nvm/versions/node/v24.19.0/bin/node';
  const npmPath = '/root/.nvm/versions/node/v24.19.0/bin/npm';
  const bootstrap = discoverBootstrap({
    execPath: nodePath,
    nodeVersion: '24.19.0',
    pathEnv: '/usr/local/bin:/usr/bin:/bin',
    findExecutable: command => command === 'node' ? '/usr/bin/node' : null,
    realpath: value => value === '/usr/bin/node' ? '/usr/bin/node-v18' : value,
    isExecutable: value => value === nodePath || value === npmPath,
    installKind: 'git',
    packageVersion: '1.1.13',
    invokedCommandPath: '/usr/local/bin/teamclaude',
  });
  assert.equal(bootstrap.nodePath, nodePath);
  assert.equal(bootstrap.npmPath, npmPath);
});

test('bootstrap discovery classifies global npm with the selected Node when PATH omits NVM', () => {
  const nodePath = '/root/.nvm/versions/node/v24.19.0/bin/node';
  const npmPath = '/root/.nvm/versions/node/v24.19.0/bin/npm';
  const bootstrap = discoverBootstrap({
    execPath: nodePath,
    nodeVersion: '24.19.0',
    pathEnv: '/usr/local/bin:/usr/bin:/bin',
    findExecutable: () => null,
    realpath: value => value,
    isExecutable: value => value === nodePath || value === npmPath,
    classifyInstall: ({ globalRoot }) => globalRoot === '/root/.nvm/versions/node/v24.19.0/lib/node_modules'
      ? 'global'
      : 'local',
    run: (command, argv) => command === nodePath
      && argv.join(' ') === `${npmPath} root --global`
      ? result(0, '/root/.nvm/versions/node/v24.19.0/lib/node_modules\n')
      : result(127, '', 'not found'),
    packageVersion: '1.1.13',
    invokedCommandPath: npmPath,
  });

  assert.equal(bootstrap.installKind, 'global');
  assert.equal(bootstrap.packageVersion, '1.1.13');
});

test('launcher selection is fixed on Linux and stable on macOS', () => {
  const linux = { platform: 'linux', defaultLauncher: '/usr/local/bin/teamclaude' };
  assert.deepEqual(chooseLauncherPath({ layout: linux }), {
    path: '/usr/local/bin/teamclaude', pathInstruction: null,
  });

  const mac = {
    platform: 'darwin', home: '/Users/a', root: '/Users/a/Library/Application Support/TeamClaude/deploy',
    binDir: '/Users/a/Library/Application Support/TeamClaude/deploy/bin',
  };
  const selected = chooseLauncherPath({
    layout: mac,
    pathEnv: '/Users/a/.nvm/versions/node/v24/bin:/opt/homebrew/bin:/usr/bin',
    access: path => path === '/opt/homebrew/bin',
  });
  assert.deepEqual(selected, { path: '/opt/homebrew/bin/teamclaude', pathInstruction: null });

  const fallback = chooseLauncherPath({ layout: mac, pathEnv: '/usr/bin', access: () => false });
  assert.deepEqual(fallback, {
    path: '/Users/a/Library/Application Support/TeamClaude/deploy/bin/teamclaude',
    pathInstruction: 'path=("$HOME/Library/Application Support/TeamClaude/deploy/bin" $path)\nexport PATH',
  });
});

test('macOS launcher selection excludes version-owned runtime directories', () => {
  const layout = { platform: 'darwin', home: '/Users/a', binDir: '/deploy/bin' };
  for (const directory of [
    '/Users/a/.nvm/versions/node/v24/bin',
    '/Users/a/.asdf/installs/nodejs/24/bin',
    '/Users/a/.volta/tools/image/node/24/bin',
    '/opt/homebrew/Cellar/node/24/bin',
  ]) {
    assert.equal(chooseLauncherPath({ layout, pathEnv: directory, access: () => true }).path, '/deploy/bin/teamclaude');
  }
});

test('rendered launcher safely quotes paths and forwards all arguments', () => {
  assert.equal(renderLauncher({ nodePath: "/opt/O'Brien/node", entryPath: "/deploy/current/src/index.js" }),
    "#!/bin/sh\n# TeamClaude-Owner: teamclaude-git-deploy-v1\nexec '/opt/O'\"'\"'Brien/node' '/deploy/current/src/index.js' \"$@\"\n");
});

test('global npm handoff smoke-tests, uninstalls, publishes atomically, and verifies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tc-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launcherPath = join(root, 'bin', 'teamclaude');
  const events = [];
  const run = (command, argv) => {
    events.push(['run', command, ...argv]);
    return result();
  };
  const outcome = await handoffLauncher({
    bootstrap: {
      nodePath: '/absolute/node', npmPath: '/absolute/npm', installKind: 'global', packageVersion: '1.1.13',
    },
    launcherPath,
    entryPath: '/deploy/current/src/index.js',
    nonce: 'fixed',
    pid: 42,
    run,
    onEvent: (...event) => events.push(event),
  });

  assert.deepEqual(events, [
    ['write', `${launcherPath}.next-42-fixed`],
    ['chmod', `${launcherPath}.next-42-fixed`, 0o755],
    ['run', `${launcherPath}.next-42-fixed`, 'version'],
    ['run', '/absolute/node', '/absolute/npm', 'uninstall', '-g', packageName],
    ['rename', `${launcherPath}.next-42-fixed`, launcherPath],
    ['run', launcherPath, 'version'],
  ]);
  assert.deepEqual(outcome, {
    launcherPath,
    npmCleanupPending: false,
    npmRestore: { packageName, version: '1.1.13', npmPath: '/absolute/npm' },
  });
  assert.match(await readFile(launcherPath, 'utf8'), /TeamClaude-Owner: teamclaude-git-deploy-v1/);
});

test('source handoff keeps npm installed and records latest as the future restore target', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tc-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const outcome = await handoffLauncher({
    bootstrap: { nodePath: '/node', npmPath: '/npm', installKind: 'git', packageVersion: '1.1.13' },
    launcherPath: join(root, 'teamclaude'), entryPath: '/deploy/current/src/index.js',
    run: (command, argv) => { calls.push([command, ...argv]); return result(); },
  });
  assert.equal(calls.some(call => call.includes('uninstall')), false);
  assert.deepEqual(outcome.npmRestore, { packageName, version: null, npmPath: '/npm' });
});

test('global npm handoff refuses to invent a restore version', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tc-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(handoffLauncher({
    bootstrap: { nodePath: '/node', npmPath: '/npm', installKind: 'global', packageVersion: null },
    launcherPath: join(root, 'teamclaude'), entryPath: '/deploy/current/src/index.js',
    run: () => result(),
  }), /exact npm package version/i);
});

test('npm cleanup failure still publishes the launcher with actionable partial state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tc-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launcherPath = join(root, 'teamclaude');
  const outcome = await handoffLauncher({
    bootstrap: { nodePath: '/node', npmPath: '/npm', installKind: 'global', packageVersion: '1.1.13' },
    launcherPath, entryPath: '/deploy/current/src/index.js',
    run: (command, argv) => argv[1] === 'uninstall' ? result(1, '', 'permission denied') : result(),
  });
  assert.equal(outcome.npmCleanupPending, true);
  assert.match(outcome.warning, /npm uninstall -g @karpeleslab\/teamclaude/);
  assert.match(await readFile(launcherPath, 'utf8'), /TeamClaude-Owner/);
});

test('failed publication reports the preserved staged launcher without leaking config', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tc-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launcherPath = join(root, 'teamclaude');
  await assert.rejects(handoffLauncher({
    bootstrap: { nodePath: '/node', npmPath: '/npm', installKind: 'git', packageVersion: null },
    launcherPath, entryPath: '/deploy/current/src/index.js', nonce: 'kept', pid: 7,
    run: () => result(),
    rename: async () => { throw new Error('read-only filesystem'); },
    config: { apiKey: 'super-secret-value' },
  }), error => {
    assert.match(error.message, new RegExp(`${launcherPath}\\.next-7-kept`));
    assert.doesNotMatch(error.message, /super-secret-value/);
    return true;
  });
});

test('npm restoration resolves exact command path, installs requested version, and verifies it', async () => {
  const calls = [];
  const run = (command, argv, options = {}) => {
    calls.push({ command, argv, options });
    if (argv[1] === 'prefix') return result(0, '/opt/npm-global\n');
    return result();
  };
  const resolved = await resolveNpmRestore({
    npmRestore: { packageName, version: '1.1.13', npmPath: '/absolute/npm' },
    nodePath: '/absolute/node', run, exists: async path => path === '/absolute/npm',
  });
  assert.deepEqual(resolved, {
    packageSpec: '@karpeleslab/teamclaude@1.1.13', nodePath: '/absolute/node', npmPath: '/absolute/npm',
    commandPath: '/opt/npm-global/bin/teamclaude',
  });
  await restoreGlobalNpm(resolved, { run });
  assert.deepEqual(calls, [
    {
      command: '/absolute/node',
      argv: ['/absolute/npm', 'prefix', '--global'],
      options: {},
    },
    {
      command: '/absolute/node',
      argv: ['/absolute/npm', 'install', '--global', '@karpeleslab/teamclaude@1.1.13'],
      options: { stdio: 'inherit' },
    },
    {
      command: '/absolute/node',
      argv: ['/opt/npm-global/bin/teamclaude', 'version'],
      options: {},
    },
  ]);
});

test('npm restoration uses latest only for a null recorded version and falls back beside Node', async () => {
  const resolved = await resolveNpmRestore({
    npmRestore: { packageName, version: null, npmPath: '/missing/npm' },
    nodePath: '/opt/homebrew/bin/node',
    exists: async path => path === '/opt/homebrew/bin/npm',
    run: (command, argv) => argv[1] === 'prefix' ? result(0, '/prefix') : result(),
  });
  assert.equal(resolved.packageSpec, '@karpeleslab/teamclaude@latest');
  assert.equal(resolved.nodePath, '/opt/homebrew/bin/node');
  assert.equal(resolved.npmPath, '/opt/homebrew/bin/npm');
  assert.equal(resolved.commandPath, '/prefix/bin/teamclaude');
});

test('failed npm restore does not touch the active Git launcher', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tc-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launcher = join(root, 'teamclaude');
  await writeFile(launcher, '# TeamClaude-Owner: teamclaude-git-deploy-v1\n');
  await assert.rejects(restoreGlobalNpm({
    packageSpec: '@karpeleslab/teamclaude@1.1.13', nodePath: '/node', npmPath: '/npm',
    commandPath: '/prefix/bin/teamclaude',
  }, { run: () => result(1, '', 'registry unavailable') }), /registry unavailable/);
  assert.match(await readFile(launcher, 'utf8'), /TeamClaude-Owner/);
});

test('owned launcher removal preserves symlinks and unmarked or replaced files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tc-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owned = join(root, 'owned');
  const operator = join(root, 'operator');
  const link = join(root, 'link');
  await writeFile(owned, '#!/bin/sh\n# TeamClaude-Owner: teamclaude-git-deploy-v1\n');
  await writeFile(operator, '#!/bin/sh\n# operator file\n');
  await symlink(operator, link);

  assert.deepEqual(await removeOwnedLauncher({ launcherPath: owned }), { removed: true, preserved: false });
  assert.deepEqual(await removeOwnedLauncher({ launcherPath: operator }), { removed: false, preserved: true });
  assert.deepEqual(await removeOwnedLauncher({ launcherPath: link }), { removed: false, preserved: true });

  const changing = join(root, 'changing');
  await writeFile(changing, '# TeamClaude-Owner: teamclaude-git-deploy-v1\n');
  let reads = 0;
  const outcome = await removeOwnedLauncher({
    launcherPath: changing,
    readFile: async (...args) => {
      reads += 1;
      if (reads === 2) await writeFile(changing, '# operator replacement\n');
      return readFile(...args);
    },
  });
  assert.deepEqual(outcome, { removed: false, preserved: true });
  assert.equal(await readFile(changing, 'utf8'), '# operator replacement\n');
});
