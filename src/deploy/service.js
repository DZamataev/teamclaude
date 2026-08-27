import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const DEPLOYMENT_OWNER = 'teamclaude-git-deploy-v1';
export const SERVICE_LABEL = 'com.karpeleslab.teamclaude';
export const UNIT_NAME = 'teamclaude.service';

function defaultRun(command, argv, { stdio = 'pipe', timeoutMs = 30_000 } = {}) {
  const result = spawnSync(command, argv, { encoding: 'utf8', stdio, timeout: timeoutMs });
  return {
    code: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
  };
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function servicePath(nodePath) {
  return [...new Set([
    dirname(nodePath), '/usr/local/bin', '/opt/homebrew/bin',
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ])].join(':');
}

export function isDeploymentOwnedDefinition(text = '') {
  return text.includes(`TeamClaude-Owner: ${DEPLOYMENT_OWNER}`)
    || new RegExp(`<key>TeamClaudeOwner</key>\\s*<string>${DEPLOYMENT_OWNER}</string>`).test(text);
}

export function renderSystemdService({ layout, nodePath }) {
  return `# TeamClaude-Owner: ${DEPLOYMENT_OWNER}
[Unit]
Description=TeamClaude multi-account Claude proxy from Git
Documentation=https://github.com/KarpelesLab/teamclaude
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${layout.current}
ExecStart=${nodePath} ${join(layout.current, 'src', 'index.js')} server --headless
Restart=always
RestartSec=5
Environment=PATH=${servicePath(nodePath)}
Environment=TEAMCLAUDE_CONFIG=${layout.configPath}
Environment=TEAMCLAUDE_DISABLE_AUTOUPDATE=1

[Install]
WantedBy=multi-user.target
`;
}

export function renderLaunchAgent({ layout, nodePath }) {
  const args = [nodePath, join(layout.current, 'src', 'index.js'), 'server', '--headless'];
  const env = {
    PATH: servicePath(nodePath),
    TEAMCLAUDE_CONFIG: layout.configPath,
    TEAMCLAUDE_DISABLE_AUTOUPDATE: '1',
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>TeamClaudeOwner</key>
  <string>${DEPLOYMENT_OWNER}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg => `    <string>${xmlEscape(arg)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(layout.current)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(layout.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(layout.logFile)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([key, value]) => `    <key>${key}</key>\n    <string>${xmlEscape(value)}</string>`).join('\n')}
  </dict>
</dict>
</plist>
`;
}

function timestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function below(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

export function createDeployServiceAdapter({
  layout,
  run = defaultRun,
  fs = fsPromises,
  uid = process.getuid?.() ?? 0,
  now = () => new Date(),
} = {}) {
  if (!layout) throw new Error('A deployment layout is required');
  const domain = `gui/${uid}`;
  const serviceTarget = `${domain}/${SERVICE_LABEL}`;

  const checked = (command, argv, options = {}) => {
    const result = run(command, argv, options);
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
      throw new Error(`${command} ${argv.join(' ')} failed (${result.code}): ${detail}`);
    }
    return result;
  };

  async function exists(path) {
    try {
      await fs.lstat(path);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async function atomicWrite(path, contents, mode = 0o644) {
    await fs.mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.next-${process.pid}-${randomUUID()}`;
    try {
      await fs.writeFile(temporary, contents, { mode, flag: 'wx' });
      await fs.rename(temporary, path);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function validateDefinition(contents) {
    const directory = await fs.mkdtemp(join(tmpdir(), 'teamclaude-service-'));
    const file = join(directory, layout.kind === 'systemd' ? UNIT_NAME : `${SERVICE_LABEL}.plist`);
    try {
      await fs.writeFile(file, contents, { mode: 0o600 });
      if (layout.kind === 'systemd') checked('systemd-analyze', ['verify', file]);
      else checked('plutil', ['-lint', file]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  async function status() {
    const installed = await exists(layout.serviceFile);
    if (layout.kind === 'systemd') {
      const enabledResult = run('systemctl', ['is-enabled', UNIT_NAME]);
      const activeResult = run('systemctl', ['is-active', UNIT_NAME]);
      const detail = activeResult.stdout.trim() || activeResult.stderr.trim() || 'inactive';
      return {
        kind: 'systemd',
        installed,
        enabled: enabledResult.code === 0 && enabledResult.stdout.trim() === 'enabled',
        running: activeResult.code === 0 && activeResult.stdout.trim() === 'active',
        detail,
      };
    }
    const result = run('launchctl', ['print', serviceTarget]);
    const pid = /\bpid = (\d+)/.exec(result.stdout)?.[1] || null;
    return {
      kind: 'launchd',
      installed,
      enabled: installed,
      running: result.code === 0 && !!pid,
      ...(pid ? { pid } : {}),
      detail: result.code === 0 ? 'loaded' : 'not loaded',
    };
  }

  async function backupExisting() {
    if (!await exists(layout.serviceFile)) return null;
    const contents = await fs.readFile(layout.serviceFile, 'utf8');
    const state = await status();
    const base = join(layout.backups, timestamp(now()));
    let directory = base;
    let suffix = 1;
    while (await exists(directory)) directory = `${base}-${suffix++}`;
    const backupPath = join(directory, layout.kind === 'systemd' ? UNIT_NAME : `${SERVICE_LABEL}.plist`);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(backupPath, contents, { mode: 0o600, flag: 'wx' });
    const mentionsDeployRoot = [layout.root, layout.repo, layout.current, layout.releases]
      .filter(Boolean).some(path => contents.includes(path));
    const looksNpmBacked = /(?:node_modules\/@karpeleslab\/teamclaude|\/bin\/teamclaude)\b/.test(contents);
    return {
      source: layout.serviceFile,
      backupPath,
      contents,
      sha256: sha256(contents),
      wasRunning: state.running,
      restoreOnUninstall: looksNpmBacked && !mentionsDeployRoot,
    };
  }

  async function validateBackup(backup) {
    if (!backup) return null;
    if (backup.source !== layout.serviceFile || !below(layout.backups, backup.backupPath)) {
      throw new Error('Service backup path or source is outside the deployment layout');
    }
    const stat = await fs.lstat(backup.backupPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Service backup must be a regular file');
    const contents = await fs.readFile(backup.backupPath, 'utf8');
    if (sha256(contents) !== backup.sha256) throw new Error('Service backup SHA-256 does not match metadata');
    return { ...backup, contents };
  }

  async function stop() {
    if (layout.kind === 'systemd') {
      checked('systemctl', ['stop', UNIT_NAME]);
      return;
    }
    const result = run('launchctl', ['bootout', serviceTarget]);
    if (result.code !== 0 && !/could not find|no such process|not loaded/i.test(result.stderr)) {
      const detail = result.stderr.trim() || `exit ${result.code}`;
      throw new Error(`launchctl bootout failed (${result.code}): ${detail}`);
    }
  }

  async function install(contents) {
    if (!isDeploymentOwnedDefinition(contents)) throw new Error('Refusing to install an unowned deployment service definition');
    await atomicWrite(layout.serviceFile, contents, 0o644);
    if (layout.kind === 'systemd') {
      checked('systemctl', ['daemon-reload']);
      checked('systemctl', ['enable', UNIT_NAME]);
    }
  }

  async function start() {
    if (layout.kind === 'systemd') checked('systemctl', ['start', UNIT_NAME]);
    else checked('launchctl', ['bootstrap', domain, layout.serviceFile]);
  }

  async function restart() {
    if (layout.kind === 'systemd') checked('systemctl', ['restart', UNIT_NAME]);
    else checked('launchctl', ['kickstart', '-k', serviceTarget]);
  }

  async function removeOwnedDefinition() {
    if (!await exists(layout.serviceFile)) return { removed: false };
    const contents = await fs.readFile(layout.serviceFile, 'utf8');
    if (!isDeploymentOwnedDefinition(contents)) {
      throw new Error(`Service definition is not deployment-owned: ${layout.serviceFile}`);
    }
    if (layout.kind === 'systemd') checked('systemctl', ['disable', UNIT_NAME]);
    await fs.rm(layout.serviceFile);
    if (layout.kind === 'systemd') checked('systemctl', ['daemon-reload']);
    return { removed: true };
  }

  async function restore(backup) {
    if (!backup) {
      if (await exists(layout.serviceFile)) await fs.rm(layout.serviceFile);
      if (layout.kind === 'systemd') checked('systemctl', ['daemon-reload']);
      return { restored: false };
    }
    const valid = backup.contents && sha256(backup.contents) === backup.sha256
      ? backup
      : await validateBackup(backup);
    await atomicWrite(valid.source, valid.contents, 0o644);
    if (layout.kind === 'systemd') checked('systemctl', ['daemon-reload']);
    if (valid.wasRunning) {
      if (layout.kind === 'systemd') checked('systemctl', ['start', UNIT_NAME]);
      else checked('launchctl', ['bootstrap', domain, valid.source]);
    }
    return { restored: true, running: valid.wasRunning };
  }

  function logs({ lines = 100, follow = true } = {}) {
    const args = layout.kind === 'systemd'
      ? ['--unit', UNIT_NAME, '--lines', String(lines), follow ? '--follow' : '--no-pager']
      : ['-n', String(lines), ...(follow ? ['-f'] : []), layout.logFile];
    const command = layout.kind === 'systemd' ? 'journalctl' : 'tail';
    const result = run(command, args, { stdio: 'inherit' });
    return { code: result.code };
  }

  return {
    validateDefinition,
    backupExisting,
    validateBackup,
    stop,
    install,
    removeOwnedDefinition,
    restore,
    start,
    restart,
    status,
    logs,
  };
}
