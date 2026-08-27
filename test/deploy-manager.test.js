import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeployManager } from '../src/deploy/manager.js';

const remoteUrl = 'https://github.com/dzamataev/teamclaude.git';
const oldRelease = '/opt/teamclaude/releases/old';
const candidate = {
  path: '/opt/teamclaude/releases/20260827T103003Z-1342e92b7207',
  commit: '1342e92b7207d5e3bb5af08402909810d7378019',
};

function validConfig() {
  return { accounts: [{ type: 'apikey', apiKey: 'secret' }] };
}

function fixture(overrides = {}) {
  const calls = [];
  const metadataWrites = [];
  const layout = {
    platform: 'linux', kind: 'systemd', root: '/opt/teamclaude', repo: '/opt/teamclaude/repo',
    releases: '/opt/teamclaude/releases', current: '/opt/teamclaude/current',
    previous: '/opt/teamclaude/previous', binDir: '/opt/teamclaude/bin', backups: '/opt/teamclaude/backups',
    metadataFile: '/opt/teamclaude/deployment.json', serviceFile: '/etc/systemd/system/teamclaude.service',
    defaultLauncher: '/usr/local/bin/teamclaude', configPath: '/root/.config/teamclaude.json',
  };
  const backup = {
    source: layout.serviceFile,
    backupPath: '/opt/teamclaude/backups/20260827T103003Z/teamclaude.service',
    contents: '[Service]\nExecStart=/npm/teamclaude\n',
    sha256: 'a'.repeat(64),
    wasRunning: true,
    restoreOnUninstall: true,
  };
  const dependencies = {
    layout,
    uid: 0,
    loadConfig: async () => validConfig(),
    readDeployment: async () => null,
    writeDeployment: async (_layout, value) => { calls.push('writeMetadataWithRestoreState'); metadataWrites.push(value); },
    run: (command, argv) => command === 'git' && argv[0] === '--version'
      ? { code: 0, stdout: 'git version 2.51.0\n', stderr: '' }
      : { code: 0, stdout: '', stderr: '' },
    discoverBootstrap: () => ({
      nodePath: '/absolute/node', npmPath: '/absolute/npm', invokedCommandPath: '/usr/local/bin/teamclaude',
      installKind: 'global', packageVersion: '1.1.13',
    }),
    chooseLauncherPath: () => ({ path: '/usr/local/bin/teamclaude', pathInstruction: null }),
    handoffLauncher: async () => {
      calls.push('handoffLauncher');
      return {
        launcherPath: '/usr/local/bin/teamclaude', npmCleanupPending: false,
        npmRestore: { packageName: '@karpeleslab/teamclaude', version: '1.1.13', npmPath: '/absolute/npm' },
      };
    },
    renderService: () => { calls.push('renderService'); return '# owned service'; },
    store: {
      ensureRepository: async () => { calls.push('ensureRepository'); return { cloned: true, remoteUrl }; },
      fetch: () => calls.push('fetch'),
      resolveRef: () => { calls.push('resolveRef'); return candidate.commit; },
      createCandidate: async () => { calls.push('createCandidate'); return candidate; },
      readSelection: async () => ({ current: oldRelease, previous: null }),
      activate: async () => { calls.push('activateCandidate'); return { current: candidate.path, previous: oldRelease }; },
      restoreSelection: async () => calls.push('restoreSelection'),
      describeRelease: async path => ({ path, commit: path === candidate.path ? candidate.commit : 'b'.repeat(40) }),
    },
    service: {
      validateDefinition: async () => calls.push('validateService'),
      backupExisting: async () => { calls.push('backupService'); return backup; },
      stop: async () => calls.push('stopOldService'),
      install: async () => calls.push('installService'),
      start: async () => calls.push('startService'),
      restart: async () => calls.push('restartService'),
      restore: async () => calls.push('restoreService'),
      status: async () => { calls.push('serviceHealth'); return { kind: 'systemd', running: true }; },
    },
    runCandidateTests: async () => calls.push('testCandidate'),
    checkHealth: async () => { calls.push('applicationHealth'); return true; },
    sleep: async () => {},
    now: () => new Date('2026-08-27T10:30:03.000Z'),
    onStage: stage => { if (stage === 'preflight') calls.push(stage); },
    ...overrides,
  };
  return { calls, metadataWrites, dependencies, layout, backup };
}

test('preflight failures never begin repository, service, or launcher mutation', async () => {
  const cases = [
    ['unsupported platform', { layout: { ...fixture().layout, platform: 'win32' } }, /supports Linux and macOS/i],
    ['non-root Linux', { uid: 501 }, /require root/i],
    ['old Node', { discoverBootstrap: () => { throw new Error('Node.js 20 or newer is required'); } }, /Node\.js 20/],
    ['missing Git', { run: () => ({ code: 127, stdout: '', stderr: 'not found' }) }, /Git is required/i],
    ['missing config', { loadConfig: async () => null }, /config/i],
    ['empty config', { loadConfig: async () => ({ accounts: [] }) }, /accounts|configured/i],
  ];
  for (const [name, override, pattern] of cases) {
    const { calls, dependencies } = fixture(override);
    const manager = createDeployManager(dependencies);
    await assert.rejects(manager.install({ remoteUrl, ref: 'master' }), pattern, name);
    assert.deepEqual(calls.filter(call => call !== 'preflight'), [], name);
  }

  for (const [name, input] of [
    ['bad URL', { remoteUrl: 'https://user:secret@example.test/repo.git', ref: 'master' }],
    ['bad ref', { remoteUrl, ref: '--upload-pack=evil' }],
  ]) {
    const { calls, dependencies } = fixture();
    await assert.rejects(createDeployManager(dependencies).install(input), /credential|ref/i, name);
    assert.deepEqual(calls.filter(call => call !== 'preflight'), [], name);
  }
});

test('clean install takes over only after candidate and service validation', async () => {
  const { calls, dependencies, metadataWrites, backup } = fixture();
  const result = await createDeployManager(dependencies).install({ remoteUrl, ref: 'master' });

  assert.deepEqual(calls, [
    'preflight', 'ensureRepository', 'fetch', 'resolveRef', 'createCandidate',
    'testCandidate', 'renderService', 'validateService', 'backupService',
    'stopOldService', 'activateCandidate', 'installService', 'startService',
    'serviceHealth', 'applicationHealth', 'handoffLauncher', 'writeMetadataWithRestoreState',
  ]);
  assert.deepEqual(result, {
    ok: true, partial: false, requestedRef: 'master', commit: candidate.commit,
    releasePath: candidate.path, launcherPath: '/usr/local/bin/teamclaude',
    npmCleanupPending: false,
    npmRestore: { packageName: '@karpeleslab/teamclaude', version: '1.1.13', npmPath: '/absolute/npm' },
    serviceBackup: {
      source: backup.source, backupPath: backup.backupPath, sha256: backup.sha256,
      wasRunning: true, restoreOnUninstall: true,
    },
  });
  assert.equal(Object.hasOwn(metadataWrites[0].serviceBackup, 'contents'), false);
  assert.equal(metadataWrites[0].nodePath, '/absolute/node');
  assert.equal(metadataWrites[0].requestedRef, 'master');
});

test('install compensates every failed takeover boundary and rechecks restored health', async () => {
  const boundaries = [
    { name: 'stopOldService', target: 'service', method: 'stop', activationExpected: false, serviceRestoreExpected: true },
    { name: 'activateCandidate', target: 'store', method: 'activate', activationExpected: false, serviceRestoreExpected: true },
    { name: 'installService', target: 'service', method: 'install', activationExpected: true, serviceRestoreExpected: true },
    { name: 'startService', target: 'service', method: 'start', activationExpected: true, serviceRestoreExpected: true },
    { name: 'serviceHealth', target: 'service', method: 'status', activationExpected: true, serviceRestoreExpected: true },
    { name: 'applicationHealth', target: 'manager', method: 'checkHealth', activationExpected: true, serviceRestoreExpected: true },
    { name: 'handoffLauncher', target: 'manager', method: 'handoffLauncher', activationExpected: true, serviceRestoreExpected: true },
  ];

  for (const boundary of boundaries) {
    const fx = fixture();
    const failure = new Error(`candidate failed at ${boundary.name}`);
    if (boundary.target === 'service') {
      const original = fx.dependencies.service[boundary.method];
      let failed = false;
      fx.dependencies.service[boundary.method] = async (...args) => {
        if (!failed) {
          failed = true;
          fx.calls.push(boundary.name);
          throw failure;
        }
        return original(...args);
      };
    } else if (boundary.target === 'store') {
      fx.dependencies.store[boundary.method] = async () => {
        fx.calls.push(boundary.name);
        throw failure;
      };
    } else {
      const original = fx.dependencies[boundary.method];
      let failed = false;
      fx.dependencies[boundary.method] = async (...args) => {
        if (!failed) {
          failed = true;
          fx.calls.push(boundary.name);
          throw failure;
        }
        return original(...args);
      };
    }

    await assert.rejects(
      createDeployManager(fx.dependencies).install({ remoteUrl, ref: 'master' }),
      error => error === failure,
      boundary.name,
    );
    assert.equal(fx.metadataWrites.length, 0, boundary.name);
    assert.equal(fx.calls.includes('restoreSelection'), boundary.activationExpected, boundary.name);
    assert.equal(fx.calls.includes('restoreService'), boundary.serviceRestoreExpected, boundary.name);
    if (boundary.serviceRestoreExpected) {
      const restoreIndex = fx.calls.lastIndexOf('restoreService');
      const selectionIndex = fx.calls.lastIndexOf('restoreSelection');
      if (boundary.activationExpected) assert.ok(restoreIndex < selectionIndex, boundary.name);
      assert.ok(fx.calls.lastIndexOf('serviceHealth') > restoreIndex, boundary.name);
      assert.ok(fx.calls.lastIndexOf('applicationHealth') > restoreIndex, boundary.name);
    }
  }
});

test('rollback failure reports both candidate and compensation errors', async () => {
  const fx = fixture();
  fx.dependencies.service.start = async () => { fx.calls.push('startService'); throw new Error('candidate start exploded'); };
  fx.dependencies.service.restore = async () => { fx.calls.push('restoreService'); throw new Error('old service restore exploded'); };
  await assert.rejects(
    createDeployManager(fx.dependencies).install({ remoteUrl, ref: 'master' }),
    error => {
      assert.match(error.message, /candidate start exploded/);
      assert.match(error.message, /old service restore exploded/);
      assert.match(error.message, /logs/i);
      return true;
    },
  );
});

test('pending npm cleanup is recorded as the only partial install result', async () => {
  const fx = fixture({
    handoffLauncher: async () => {
      fx.calls.push('handoffLauncher');
      return {
        launcherPath: '/usr/local/bin/teamclaude', npmCleanupPending: true,
        npmRestore: { packageName: '@karpeleslab/teamclaude', version: '1.1.13', npmPath: '/absolute/npm' },
        warning: 'Run npm uninstall -g @karpeleslab/teamclaude',
      };
    },
  });
  const result = await createDeployManager(fx.dependencies).install({ remoteUrl, ref: 'master' });
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.npmCleanupPending, true);
  assert.match(result.warning, /npm uninstall -g/);
  assert.equal(fx.metadataWrites[0].npmCleanupPending, true);
  assert.equal(fx.calls.includes('restoreSelection'), false);
  assert.equal(fx.calls.includes('restoreService'), false);
});

test('idempotent install reuses a healthy current commit and preserves original restore metadata', async () => {
  const fx = fixture();
  const originalBackup = {
    source: fx.layout.serviceFile,
    backupPath: '/opt/teamclaude/backups/original/teamclaude.service',
    sha256: 'c'.repeat(64), wasRunning: true, restoreOnUninstall: true,
  };
  const existing = {
    schemaVersion: 1, remoteUrl, requestedRef: 'master', nodePath: '/old/node',
    launcherPath: '/usr/local/bin/teamclaude', configPath: fx.layout.configPath,
    serviceKind: 'systemd', installedAt: '2026-08-26T10:00:00.000Z', npmCleanupPending: false,
    npmRestore: { packageName: '@karpeleslab/teamclaude', version: '1.1.12', npmPath: '/old/npm' },
    serviceBackup: originalBackup,
  };
  fx.dependencies.readDeployment = async () => existing;
  fx.dependencies.store.ensureRepository = async () => { fx.calls.push('ensureRepository'); return { cloned: false, remoteUrl }; };
  fx.dependencies.store.readSelection = async () => ({ current: candidate.path, previous: oldRelease });
  fx.dependencies.store.describeRelease = async path => ({ path, commit: path === candidate.path ? candidate.commit : 'b'.repeat(40) });

  const result = await createDeployManager(fx.dependencies).install({ remoteUrl, ref: 'master' });
  assert.equal(fx.calls.includes('createCandidate'), false);
  assert.equal(result.releasePath, candidate.path);
  assert.deepEqual(result.npmRestore, existing.npmRestore);
  assert.deepEqual(result.serviceBackup, originalBackup);
  assert.equal(fx.metadataWrites[0].installedAt, existing.installedAt);
});

test('an installed deployment with another remote refuses before fetch or takeover', async () => {
  const fx = fixture({
    readDeployment: async () => ({ remoteUrl: 'https://example.test/other.git' }),
  });
  await assert.rejects(
    createDeployManager(fx.dependencies).install({ remoteUrl, ref: 'master' }),
    /different remote/i,
  );
  assert.equal(fx.calls.includes('ensureRepository'), false);
  assert.equal(fx.calls.includes('fetch'), false);
  assert.equal(fx.calls.includes('backupService'), false);
});

test('legacy Git layout is adopted without clone, release deletion, or npm-version invention', async () => {
  const fx = fixture();
  fx.dependencies.store.ensureRepository = async () => { fx.calls.push('ensureRepository'); return { cloned: false, remoteUrl }; };
  fx.dependencies.store.readSelection = async () => ({ current: candidate.path, previous: oldRelease });
  fx.dependencies.store.describeRelease = async path => ({ path, commit: path === candidate.path ? candidate.commit : 'b'.repeat(40) });
  let handoffBootstrap;
  fx.dependencies.handoffLauncher = async options => {
    fx.calls.push('handoffLauncher');
    handoffBootstrap = options.bootstrap;
    return {
      launcherPath: '/usr/local/bin/teamclaude', npmCleanupPending: false,
      npmRestore: { packageName: '@karpeleslab/teamclaude', version: null, npmPath: options.bootstrap.npmPath },
    };
  };

  const result = await createDeployManager(fx.dependencies).install({ remoteUrl, ref: 'master' });
  assert.equal(fx.calls.includes('createCandidate'), false);
  assert.equal(fx.calls.some(call => /clone|remove|nginx/i.test(call)), false);
  assert.equal(result.releasePath, candidate.path);
  assert.equal(handoffBootstrap.installKind, 'git');
  assert.equal(handoffBootstrap.packageVersion, null);
  assert.deepEqual(fx.metadataWrites[0].npmRestore, {
    packageName: '@karpeleslab/teamclaude', version: null, npmPath: '/absolute/npm',
  });
});
