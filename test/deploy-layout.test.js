import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, lstat, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEPLOYMENT_SCHEMA_VERSION,
  assertMutationAllowed,
  assertSafeRootRemoval,
  readDeployment,
  resolveDeployLayout,
  validateInstallConfig,
  writeDeployment,
} from '../src/deploy/layout.js';

function metadata(layout, overrides = {}) {
  return {
    schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
    remoteUrl: 'https://github.com/dzamataev/teamclaude.git',
    serviceKind: layout.kind,
    nodePath: '/absolute/node',
    launcherPath: join(layout.binDir, 'teamclaude'),
    configPath: layout.configPath,
    installedAt: '2026-08-27T10:30:03.000Z',
    requestedRef: 'master',
    npmCleanupPending: false,
    npmRestore: {
      packageName: '@karpeleslab/teamclaude',
      version: null,
      npmPath: '/absolute/npm',
    },
    serviceBackup: null,
    ...overrides,
  };
}

test('Linux deployment is system-wide and root-only', () => {
  const layout = resolveDeployLayout({
    platform: 'linux', home: '/root', configPath: '/root/.config/teamclaude.json',
  });
  assert.equal(layout.root, '/opt/teamclaude');
  assert.equal(layout.serviceFile, '/etc/systemd/system/teamclaude.service');
  assert.equal(layout.defaultLauncher, '/usr/local/bin/teamclaude');
  assert.throws(() => assertMutationAllowed(layout, { uid: 1000 }), /root/);
  assert.doesNotThrow(() => assertMutationAllowed(layout, { uid: 0 }));
});

test('macOS deployment is per-user and does not require root', () => {
  const layout = resolveDeployLayout({
    platform: 'darwin', home: '/Users/a', configPath: '/Users/a/.config/teamclaude.json',
  });
  assert.equal(layout.root, '/Users/a/Library/Application Support/TeamClaude/deploy');
  assert.equal(layout.serviceFile, '/Users/a/Library/LaunchAgents/com.karpeleslab.teamclaude.plist');
  assert.equal(layout.logFile, '/Users/a/Library/Logs/teamclaude.log');
  assert.doesNotThrow(() => assertMutationAllowed(layout, { uid: 501 }));
});

test('unsupported platforms fail before a layout can be created', () => {
  assert.throws(
    () => resolveDeployLayout({ platform: 'win32', home: 'C:\\Users\\a' }),
    /Linux and macOS/,
  );
});

test('config cannot live inside the removable deployment root', () => {
  assert.throws(() => resolveDeployLayout({
    platform: 'darwin',
    home: '/Users/a',
    configPath: '/Users/a/Library/Application Support/TeamClaude/deploy/config.json',
  }), /config.*deployment root/i);
});

test('install config requires at least one enabled usable account', () => {
  assert.deepEqual(validateInstallConfig(null), { ok: false, reason: 'config not found' });
  assert.equal(validateInstallConfig({ accounts: [] }).ok, false);
  assert.equal(validateInstallConfig({ accounts: [{ type: 'apikey', apiKey: 'k' }] }).ok, true);
  assert.equal(validateInstallConfig({ accounts: [{ type: 'oauth', refreshToken: 'r' }] }).ok, true);
  assert.equal(validateInstallConfig({ accounts: [{ type: 'oauth', importFrom: '/credentials' }] }).ok, true);
  assert.equal(validateInstallConfig({ accounts: [{ type: 'apikey', apiKey: 'k', disabled: true }] }).ok, false);
});

test('deployment metadata round-trips atomically with private mode', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'tc-layout-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const layout = resolveDeployLayout({
    platform: 'darwin', home, configPath: join(home, '.config', 'teamclaude.json'),
  });
  const value = metadata(layout, {
    serviceBackup: {
      source: layout.serviceFile,
      backupPath: join(layout.backups, 'stamp', 'service.plist'),
      sha256: 'a'.repeat(64),
      wasRunning: true,
      restoreOnUninstall: false,
    },
  });
  await writeDeployment(layout, value);
  assert.deepEqual(await readDeployment(layout), value);
  assert.equal((await lstat(layout.metadataFile)).mode & 0o777, 0o600);
  assert.deepEqual((await readFile(layout.root, { encoding: 'utf8' }).catch(() => null)), null);
  const names = await import('node:fs/promises').then(fs => fs.readdir(layout.root));
  assert.equal(names.some(name => name.includes('.next-')), false);
});

test('metadata rejects unsafe or credential-bearing values', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'tc-layout-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const layout = resolveDeployLayout({
    platform: 'darwin', home, configPath: join(home, '.config', 'teamclaude.json'),
  });
  await assert.rejects(
    writeDeployment(layout, metadata(layout, { remoteUrl: 'https://token@github.com/o/r.git' })),
    /credentials/,
  );
  await assert.rejects(
    writeDeployment(layout, metadata(layout, {
      serviceBackup: {
        source: layout.serviceFile,
        backupPath: join(home, 'outside.service'),
        sha256: 'b'.repeat(64),
        wasRunning: false,
        restoreOnUninstall: true,
      },
    })),
    /backup/i,
  );
  await assert.rejects(
    writeDeployment(layout, metadata(layout, { schemaVersion: 99 })),
    /schema version/i,
  );
});

test('malformed metadata names its file', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'tc-layout-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const layout = resolveDeployLayout({
    platform: 'darwin', home, configPath: join(home, '.config', 'teamclaude.json'),
  });
  await mkdir(layout.root, { recursive: true });
  await writeFile(layout.metadataFile, '{broken');
  await assert.rejects(readDeployment(layout), new RegExp(layout.metadataFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('safe root removal rejects symlink roots and mismatched metadata', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'tc-layout-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const layout = resolveDeployLayout({
    platform: 'darwin', home, configPath: join(home, '.config', 'teamclaude.json'),
  });
  await mkdir(layout.root, { recursive: true });
  await assertSafeRootRemoval(layout, metadata(layout));
  await assert.rejects(
    assertSafeRootRemoval(layout, metadata(layout, { serviceKind: 'systemd' })),
    /service kind/i,
  );

  await rm(layout.root, { recursive: true, force: true });
  const target = join(home, 'not-the-deploy-root');
  await mkdir(target);
  await mkdir(join(home, 'Library', 'Application Support', 'TeamClaude'), { recursive: true });
  await symlink(target, layout.root);
  await assert.rejects(assertSafeRootRemoval(layout, metadata(layout)), /symlink/i);
});
