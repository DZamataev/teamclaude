import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeployManager } from '../src/deploy/manager.js';

const packageName = '@karpeleslab/teamclaude';

function uninstallFixture({ version = '1.1.13', restoreOnUninstall = true, wasRunning = true } = {}) {
  const calls = [];
  const layout = {
    platform: 'linux', kind: 'systemd', root: '/opt/teamclaude', repo: '/opt/teamclaude/repo',
    releases: '/opt/teamclaude/releases', current: '/opt/teamclaude/current', previous: '/opt/teamclaude/previous',
    backups: '/opt/teamclaude/backups', metadataFile: '/opt/teamclaude/deployment.json',
    serviceFile: '/etc/systemd/system/teamclaude.service', defaultLauncher: '/usr/local/bin/teamclaude',
    configPath: '/root/.config/teamclaude.json',
  };
  const backup = {
    source: layout.serviceFile,
    backupPath: '/opt/teamclaude/backups/original/teamclaude.service',
    sha256: 'a'.repeat(64), wasRunning, restoreOnUninstall,
  };
  const metadata = {
    schemaVersion: 1, remoteUrl: 'https://github.com/dzamataev/teamclaude.git', requestedRef: 'master',
    nodePath: '/absolute/node', launcherPath: '/usr/local/bin/teamclaude', configPath: layout.configPath,
    serviceKind: 'systemd', installedAt: '2026-08-27T10:30:03.000Z', npmCleanupPending: false,
    npmRestore: { packageName, version, npmPath: '/absolute/npm' }, serviceBackup: backup,
  };
  const resolved = {
    packageSpec: `${packageName}@${version ?? 'latest'}`,
    npmPath: '/absolute/npm', commandPath: '/npm-prefix/bin/teamclaude',
  };
  const dependencies = {
    layout,
    uid: 0,
    readDeployment: async () => { calls.push('readMetadata'); return metadata; },
    validateUninstallLayout: async () => calls.push('validateLayout'),
    assertSafeRootRemoval: async () => {},
    store: {
      readSelection: async () => { calls.push('validateLinks'); return { current: '/opt/teamclaude/releases/current', previous: null }; },
    },
    readServiceDefinition: async () => { calls.push('validateOwnedService'); return '# TeamClaude-Owner: teamclaude-git-deploy-v1\n'; },
    validateLauncher: async () => ({ exists: true, owned: true, symlink: false }),
    service: {
      validateBackup: async value => { calls.push('validateBackup'); return { ...value, contents: '[Service]\nExecStart=/npm/teamclaude\n' }; },
      stop: async () => calls.push('stopDeploymentService'),
      removeOwnedDefinition: async () => { calls.push('removeDeploymentService'); return { removed: true }; },
      restore: async () => { calls.push('restorePriorService'); return { restored: true, running: wasRunning }; },
      status: async () => { calls.push('verifyPriorService'); return { installed: true, running: wasRunning }; },
      install: async () => calls.push('restoreDeploymentDefinition'),
      start: async () => calls.push('restartDeploymentService'),
    },
    resolveNpmRestore: async () => { calls.push('resolveNpmRestore'); return resolved; },
    stageLauncher: async () => { calls.push('stageOwnedLauncher'); return { path: '/tmp/staged-teamclaude' }; },
    restoreGlobalNpm: async () => { calls.push('restoreGlobalNpm'); return resolved; },
    removeOwnedLauncher: async () => { calls.push('removeOwnedLauncherIfStillPresent'); return { removed: false, preserved: true }; },
    removeDeploymentRoot: async () => calls.push('removeDeploymentRoot'),
    verifyRestoredCommand: async () => calls.push('verifyRestoredNpmCommand'),
    restoreStagedLauncher: async () => calls.push('restoreStagedLauncher'),
    cleanupStagedLauncher: async () => calls.push('cleanupStagedLauncher'),
    checkHealth: async () => { calls.push('verifyDeploymentHealth'); return true; },
    sleep: async () => {},
    run: () => ({ code: 0, stdout: '', stderr: '' }),
  };
  return { calls, dependencies, metadata, layout, backup, resolved };
}

test('uninstall preflight rejects unsafe states before teardown mutation', async () => {
  const cases = [
    ['restoreNpm type', { restoreNpm: 'yes' }, {}, /boolean/i],
    ['missing metadata', { restoreNpm: true }, { readDeployment: async () => null }, /not installed/i],
    ['non-root Linux', { restoreNpm: true }, { uid: 501 }, /require root/i],
    ['unsafe root', { restoreNpm: true }, { validateUninstallLayout: async () => { throw new Error('unsafe deployment root'); } }, /unsafe deployment root/],
    ['unsafe links', { restoreNpm: true }, { store: { readSelection: async () => { throw new Error('current outside releases'); } } }, /outside releases/],
    ['unowned service', { restoreNpm: true }, { readServiceDefinition: async () => '# operator service\n' }, /not deployment-owned/i],
    ['bad backup', { restoreNpm: true }, { service: { validateBackup: async () => { throw new Error('backup hash mismatch'); } } }, /hash mismatch/],
  ];
  const mutationCalls = new Set([
    'resolveNpmRestore', 'stageOwnedLauncher', 'restoreGlobalNpm', 'stopDeploymentService',
    'removeDeploymentService', 'restorePriorService', 'removeOwnedLauncherIfStillPresent', 'removeDeploymentRoot',
  ]);
  for (const [name, options, override, pattern] of cases) {
    const fx = uninstallFixture();
    Object.assign(fx.dependencies, override);
    await assert.rejects(createDeployManager(fx.dependencies).uninstall(options), pattern, name);
    assert.deepEqual(fx.calls.filter(call => mutationCalls.has(call)), [], name);
  }
});

test('restore-first uninstall supports exact and latest npm package restoration', async () => {
  for (const version of ['1.1.13', null]) {
    const fx = uninstallFixture({ version });
    const result = await createDeployManager(fx.dependencies).uninstall({ restoreNpm: true });
    assert.deepEqual(fx.calls.slice(0, -1), [
      'readMetadata', 'validateLayout', 'validateLinks', 'validateOwnedService',
      'validateBackup', 'resolveNpmRestore', 'stageOwnedLauncher', 'restoreGlobalNpm',
      'stopDeploymentService', 'removeDeploymentService', 'restorePriorService',
      'verifyPriorService', 'removeOwnedLauncherIfStillPresent', 'removeDeploymentRoot',
      'verifyRestoredNpmCommand',
    ]);
    assert.equal(fx.calls.at(-1), 'cleanupStagedLauncher');
    assert.deepEqual(result, {
      ok: true, partial: false, restoredNpm: true,
      packageSpec: `${packageName}@${version ?? 'latest'}`,
      commandPath: '/npm-prefix/bin/teamclaude', restoredService: true,
      launcherRemoved: false, removedRoot: true, remainingPaths: [],
    });
  }
});

test('uninstall does not restore a legacy Git service rooted in the removed deployment', async () => {
  const fx = uninstallFixture({ restoreOnUninstall: false });
  const result = await createDeployManager(fx.dependencies).uninstall({ restoreNpm: true });
  assert.equal(fx.calls.includes('restorePriorService'), false);
  assert.equal(fx.calls.includes('verifyPriorService'), false);
  assert.equal(result.restoredService, false);
});

test('no-restore uninstall removes only deployment-owned resources', async () => {
  const fx = uninstallFixture();
  fx.dependencies.removeOwnedLauncher = async () => {
    fx.calls.push('removeOwnedLauncherIfStillPresent');
    return { removed: true, preserved: false };
  };
  const result = await createDeployManager(fx.dependencies).uninstall({ restoreNpm: false });
  assert.equal(fx.calls.some(call => /Npm|PriorService/.test(call)), false);
  assert.deepEqual(fx.calls, [
    'readMetadata', 'validateLayout', 'validateLinks', 'validateOwnedService', 'validateBackup',
    'stageOwnedLauncher', 'stopDeploymentService', 'removeDeploymentService',
    'removeOwnedLauncherIfStillPresent', 'removeDeploymentRoot', 'cleanupStagedLauncher',
  ]);
  assert.deepEqual(result, {
    ok: true, partial: false, restoredNpm: false, packageSpec: null, commandPath: null,
    restoredService: false, launcherRemoved: true, removedRoot: true, remainingPaths: [],
    warning: 'TeamClaude was intentionally left uninstalled; the config, state, nginx, and retained logs were preserved.',
  });
  assert.deepEqual(fx.calls.filter(call => call.includes('/root/.config') || call.includes('nginx') || call.includes('Logs')), []);
});

test('teardown failures compensate deployment service and launcher in reverse order', async () => {
  for (const boundary of ['stop', 'removeOwnedDefinition', 'restore', 'status', 'removeOwnedLauncher']) {
    const fx = uninstallFixture();
    const original = fx.dependencies.service[boundary] || fx.dependencies[boundary];
    let failed = false;
    const replacement = async (...args) => {
      if (!failed) {
        failed = true;
        throw new Error(`failed ${boundary}`);
      }
      return original?.(...args);
    };
    if (Object.hasOwn(fx.dependencies.service, boundary)) fx.dependencies.service[boundary] = replacement;
    else fx.dependencies[boundary] = replacement;

    await assert.rejects(createDeployManager(fx.dependencies).uninstall({ restoreNpm: true }), new RegExp(`failed ${boundary}`));
    assert.equal(fx.calls.includes('removeDeploymentRoot'), false, boundary);
    assert.equal(fx.calls.includes('restoreDeploymentDefinition'), true, boundary);
    assert.equal(fx.calls.includes('restoreStagedLauncher'), true, boundary);
    assert.equal(fx.calls.includes('restartDeploymentService'), true, boundary);
    assert.equal(fx.calls.includes('verifyDeploymentHealth'), true, boundary);
  }
});

test('npm restore failure stops before service or root mutation with an exact recovery command', async () => {
  const fx = uninstallFixture();
  fx.dependencies.restoreGlobalNpm = async () => { fx.calls.push('restoreGlobalNpm'); throw new Error('registry unavailable'); };
  await assert.rejects(
    createDeployManager(fx.dependencies).uninstall({ restoreNpm: true }),
    /npm install --global @karpeleslab\/teamclaude@1\.1\.13/,
  );
  assert.equal(fx.calls.includes('stopDeploymentService'), false);
  assert.equal(fx.calls.includes('removeDeploymentRoot'), false);
});

test('root removal failure returns committed partial state without destructive compensation', async () => {
  const fx = uninstallFixture();
  fx.dependencies.removeDeploymentRoot = async () => {
    fx.calls.push('removeDeploymentRoot');
    throw new Error('filesystem busy');
  };
  const result = await createDeployManager(fx.dependencies).uninstall({ restoreNpm: true });
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.restoredNpm, true);
  assert.equal(result.restoredService, true);
  assert.equal(result.removedRoot, false);
  assert.deepEqual(result.remainingPaths, ['/opt/teamclaude']);
  assert.match(result.warning, /filesystem busy/);
  assert.equal(fx.calls.includes('restoreDeploymentDefinition'), false);
  assert.equal(fx.calls.includes('restoreStagedLauncher'), false);
});

test('final npm command verification failure is partial after root removal', async () => {
  const fx = uninstallFixture();
  fx.dependencies.verifyRestoredCommand = async () => {
    fx.calls.push('verifyRestoredNpmCommand');
    throw new Error('restored command is unavailable');
  };
  const result = await createDeployManager(fx.dependencies).uninstall({ restoreNpm: true });
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.removedRoot, true);
  assert.equal(result.restoredNpm, true);
  assert.deepEqual(result.remainingPaths, ['/npm-prefix/bin/teamclaude']);
  assert.match(result.warning, /restored command is unavailable/);
  assert.equal(fx.calls.includes('restoreDeploymentDefinition'), false);
});
