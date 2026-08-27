import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEPLOYMENT_OWNER,
  createDeployServiceAdapter,
  isDeploymentOwnedDefinition,
  renderLaunchAgent,
  renderSystemdService,
} from '../src/deploy/service.js';

function layout(home, platform) {
  const root = join(home, 'deploy');
  return {
    platform,
    kind: platform === 'linux' ? 'systemd' : 'launchd',
    root,
    repo: join(root, 'repo'),
    releases: join(root, 'releases'),
    current: join(root, 'current'),
    backups: join(root, 'backups'),
    configPath: join(home, '.config', 'teamclaude.json'),
    serviceFile: platform === 'linux'
      ? join(home, 'teamclaude.service')
      : join(home, 'Library', 'LaunchAgents', 'com.karpeleslab.teamclaude.plist'),
    logFile: platform === 'darwin' ? join(home, 'Library', 'Logs', 'teamclaude.log') : null,
  };
}

function recorder(responses = {}) {
  const calls = [];
  const run = (command, argv, options = {}) => {
    const call = [command, ...argv].join(' ');
    calls.push({ call, options });
    const key = Object.keys(responses).find(candidate => call.includes(candidate));
    return responses[key] || { code: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}

test('systemd definition is boot-persistent and deployment-owned', () => {
  const l = layout('/root', 'linux');
  const unit = renderSystemdService({ layout: l, nodePath: '/absolute/node' });
  assert.match(unit, new RegExp(`TeamClaude-Owner: ${DEPLOYMENT_OWNER}`));
  assert.match(unit, /WorkingDirectory=\/root\/deploy\/current/);
  assert.match(unit, /ExecStart=\/absolute\/node \/root\/deploy\/current\/src\/index\.js server --headless/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /Environment=TEAMCLAUDE_DISABLE_AUTOUPDATE=1/);
  assert.match(unit, /WantedBy=multi-user\.target/);
  assert.equal(isDeploymentOwnedDefinition(unit), true);
});

test('LaunchAgent is owner-marked, escaped, and starts at login', () => {
  const l = layout('/Users/a&b', 'darwin');
  const plist = renderLaunchAgent({ layout: l, nodePath: '/opt/homebrew/bin/node' });
  assert.match(plist, new RegExp(`<key>TeamClaudeOwner</key>\\s*<string>${DEPLOYMENT_OWNER}</string>`));
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /\/opt\/homebrew\/bin\/node/);
  assert.match(plist, /current\/src\/index\.js/);
  assert.match(plist, /a&amp;b/);
  assert.match(plist, /TEAMCLAUDE_DISABLE_AUTOUPDATE/);
  assert.equal(isDeploymentOwnedDefinition(plist), true);
});

test('definition validation delegates to platform validators', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'tc-deploy-service-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const linuxRun = recorder();
  const linux = createDeployServiceAdapter({ layout: layout(home, 'linux'), run: linuxRun.run });
  await linux.validateDefinition(renderSystemdService({ layout: layout(home, 'linux'), nodePath: '/node' }));
  assert.match(linuxRun.calls[0].call, /^systemd-analyze verify /);

  const macRun = recorder();
  const mac = createDeployServiceAdapter({ layout: layout(home, 'darwin'), run: macRun.run, uid: 501 });
  await mac.validateDefinition(renderLaunchAgent({ layout: layout(home, 'darwin'), nodePath: '/node' }));
  assert.match(macRun.calls[0].call, /^plutil -lint /);
});

test('systemd install separates enable from start and reports state', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'tc-deploy-service-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const l = layout(home, 'linux');
  const rec = recorder({
    'is-enabled': { code: 0, stdout: 'enabled\n', stderr: '' },
    'is-active': { code: 0, stdout: 'active\n', stderr: '' },
  });
  const adapter = createDeployServiceAdapter({ layout: l, run: rec.run });
  const unit = renderSystemdService({ layout: l, nodePath: '/node' });
  await adapter.install(unit);
  await adapter.start();
  assert.deepEqual(rec.calls.map(c => c.call), [
    'systemctl daemon-reload',
    'systemctl enable teamclaude.service',
    'systemctl start teamclaude.service',
  ]);
  assert.equal(await readFile(l.serviceFile, 'utf8'), unit);
  assert.deepEqual(await adapter.status(), {
    kind: 'systemd', installed: true, enabled: true, running: true, detail: 'active',
  });
});

test('LaunchAgent stop, start, restart, status, and logs use the user domain', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'tc-deploy-service-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const l = layout(home, 'darwin');
  const rec = recorder({
    'launchctl print': { code: 0, stdout: 'state = running\n\tpid = 4242\n', stderr: '' },
  });
  const adapter = createDeployServiceAdapter({ layout: l, run: rec.run, uid: 501 });
  await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  await writeFile(l.serviceFile, renderLaunchAgent({ layout: l, nodePath: '/node' }));
  await adapter.stop();
  await adapter.start();
  await adapter.restart();
  const status = await adapter.status();
  await adapter.logs({ lines: 25, follow: false });
  assert.deepEqual(status, {
    kind: 'launchd', installed: true, enabled: true, running: true, pid: '4242', detail: 'loaded',
  });
  assert.deepEqual(rec.calls.map(c => c.call), [
    'launchctl bootout gui/501/com.karpeleslab.teamclaude',
    `launchctl bootstrap gui/501 ${l.serviceFile}`,
    'launchctl kickstart -k gui/501/com.karpeleslab.teamclaude',
    'launchctl print gui/501/com.karpeleslab.teamclaude',
    `tail -n 25 ${l.logFile}`,
  ]);
});

test('backup records hash, running state, and whether uninstall may restore it', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'tc-deploy-service-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const l = layout(home, 'linux');
  const npmUnit = '[Service]\nExecStart=/node /usr/local/bin/teamclaude server --headless\n';
  await writeFile(l.serviceFile, npmUnit);
  const rec = recorder({ 'is-active': { code: 0, stdout: 'active\n', stderr: '' } });
  const adapter = createDeployServiceAdapter({
    layout: l, run: rec.run, now: () => new Date('2026-08-27T10:30:03.000Z'),
  });
  const backup = await adapter.backupExisting();
  assert.equal(backup.contents, npmUnit);
  assert.match(backup.sha256, /^[a-f0-9]{64}$/);
  assert.equal(backup.wasRunning, true);
  assert.equal(backup.restoreOnUninstall, true);
  assert.equal((await adapter.validateBackup(backup)).contents, npmUnit);

  await writeFile(l.serviceFile, `[Service]\nExecStart=/node ${l.current}/src/index.js server --headless\n`);
  const gitBackup = await adapter.backupExisting();
  assert.equal(gitBackup.restoreOnUninstall, false);
});

test('owned definition removal refuses an operator-owned file', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'tc-deploy-service-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const l = layout(home, 'linux');
  await writeFile(l.serviceFile, '[Service]\nExecStart=/operator/teamclaude\n');
  const rec = recorder();
  const adapter = createDeployServiceAdapter({ layout: l, run: rec.run });
  await assert.rejects(adapter.removeOwnedDefinition(), /not deployment-owned/i);
  assert.equal(await readFile(l.serviceFile, 'utf8'), '[Service]\nExecStart=/operator/teamclaude\n');
  assert.equal(rec.calls.length, 0);
});

test('systemd logs follow by default and use no-pager for finite output', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'tc-deploy-service-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const rec = recorder();
  const adapter = createDeployServiceAdapter({ layout: layout(home, 'linux'), run: rec.run });
  await adapter.logs({ lines: 100, follow: true });
  await adapter.logs({ lines: 20, follow: false });
  assert.deepEqual(rec.calls.map(c => c.call), [
    'journalctl --unit teamclaude.service --lines 100 --follow',
    'journalctl --unit teamclaude.service --lines 20 --no-pager',
  ]);
  assert.equal(rec.calls.every(c => c.options.stdio === 'inherit'), true);
});
