import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { getConfigPath } from '../config.js';

export const DEPLOYMENT_SCHEMA_VERSION = 1;
const PACKAGE_NAME = '@karpeleslab/teamclaude';

function isAtOrBelow(parent, candidate) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel));
}

function platformRoot(platform, home) {
  return platform === 'linux'
    ? '/opt/teamclaude'
    : join(home, 'Library', 'Application Support', 'TeamClaude', 'deploy');
}

export function resolveDeployLayout({
  platform = process.platform,
  home = homedir(),
  configPath = getConfigPath(),
} = {}) {
  if (platform !== 'linux' && platform !== 'darwin') {
    throw new Error(`teamclaude deploy supports Linux and macOS, not ${platform}`);
  }
  const root = platformRoot(platform, home);
  if (isAtOrBelow(root, configPath)) {
    throw new Error(`TeamClaude config cannot be stored inside the deployment root: ${configPath}`);
  }
  const kind = platform === 'linux' ? 'systemd' : 'launchd';
  return Object.freeze({
    platform,
    home,
    kind,
    root,
    repo: join(root, 'repo'),
    releases: join(root, 'releases'),
    current: join(root, 'current'),
    previous: join(root, 'previous'),
    binDir: join(root, 'bin'),
    backups: join(root, 'backups'),
    metadataFile: join(root, 'deployment.json'),
    serviceFile: platform === 'linux'
      ? '/etc/systemd/system/teamclaude.service'
      : join(home, 'Library', 'LaunchAgents', 'com.karpeleslab.teamclaude.plist'),
    logFile: platform === 'darwin' ? join(home, 'Library', 'Logs', 'teamclaude.log') : null,
    defaultLauncher: platform === 'linux' ? '/usr/local/bin/teamclaude' : null,
    configPath,
  });
}

export function assertMutationAllowed(layout, { uid = process.getuid?.() } = {}) {
  if (layout.platform === 'linux' && uid !== 0) {
    throw new Error('teamclaude deploy mutations require root on Linux');
  }
}

export function validateInstallConfig(config) {
  if (!config) return { ok: false, reason: 'config not found' };
  if (!Array.isArray(config.accounts) || config.accounts.length === 0) {
    return { ok: false, reason: 'no accounts configured' };
  }
  const usable = config.accounts.some(account => {
    if (!account || account.disabled) return false;
    if (account.type === 'apikey') return !!account.apiKey;
    if (account.type === 'oauth') {
      return !!(account.accessToken || account.refreshToken || account.importFrom);
    }
    return false;
  });
  return usable
    ? { ok: true }
    : { ok: false, reason: 'no enabled account has usable credentials' };
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid deployment metadata field: ${field}`);
  }
}

function validateRemoteWithoutCredentials(remoteUrl) {
  requireString(remoteUrl, 'remoteUrl');
  try {
    const parsed = new URL(remoteUrl);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && (parsed.username || parsed.password)) {
      throw new Error('Deployment remote URL must not contain credentials');
    }
  } catch (error) {
    if (error.message.includes('credentials')) throw error;
    // SCP-style Git remotes are intentionally not URL-parsed here.
  }
}

function validateMetadata(layout, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid deployment metadata object');
  }
  if (value.schemaVersion !== DEPLOYMENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported deployment metadata schema version: ${value.schemaVersion}`);
  }
  validateRemoteWithoutCredentials(value.remoteUrl);
  if (value.serviceKind !== layout.kind) {
    throw new Error(`Deployment service kind ${value.serviceKind} does not match ${layout.kind}`);
  }
  for (const field of ['nodePath', 'launcherPath', 'configPath', 'installedAt', 'requestedRef']) {
    requireString(value[field], field);
  }
  if (resolve(value.configPath) !== resolve(layout.configPath)) {
    throw new Error('Deployment metadata configPath does not match this layout');
  }
  if (isAtOrBelow(layout.root, value.configPath)) {
    throw new Error('Deployment config cannot be inside the deployment root');
  }
  if (typeof value.npmCleanupPending !== 'boolean') {
    throw new Error('Invalid deployment metadata field: npmCleanupPending');
  }
  const npm = value.npmRestore;
  if (!npm || npm.packageName !== PACKAGE_NAME || (npm.version !== null && (typeof npm.version !== 'string' || !npm.version))) {
    throw new Error('Invalid deployment metadata field: npmRestore');
  }
  requireString(npm.npmPath, 'npmRestore.npmPath');
  if (!isAbsolute(npm.npmPath)) throw new Error('npmRestore.npmPath must be absolute');

  const backup = value.serviceBackup;
  if (backup !== null) {
    if (!backup || typeof backup !== 'object') throw new Error('Invalid service backup metadata');
    requireString(backup.source, 'serviceBackup.source');
    requireString(backup.backupPath, 'serviceBackup.backupPath');
    if (!isAtOrBelow(layout.backups, backup.backupPath)) {
      throw new Error('Service backup path must be below the deployment backups directory');
    }
    if (!/^[a-f0-9]{64}$/i.test(backup.sha256 || '')) {
      throw new Error('Invalid service backup SHA-256');
    }
    if (typeof backup.wasRunning !== 'boolean' || typeof backup.restoreOnUninstall !== 'boolean') {
      throw new Error('Invalid service backup state');
    }
  }
  return value;
}

export async function readDeployment(layout) {
  let text;
  try {
    text = await readFile(layout.metadataFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot parse deployment metadata ${layout.metadataFile}: ${error.message}`, { cause: error });
  }
  return validateMetadata(layout, value);
}

export async function writeDeployment(layout, value) {
  validateMetadata(layout, value);
  await mkdir(layout.root, { recursive: true, mode: 0o755 });
  const temporary = join(dirname(layout.metadataFile), `.deployment.json.next-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, layout.metadataFile);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function assertSafeRootRemoval(layout, metadata) {
  const expectedRoot = platformRoot(layout.platform, layout.home);
  if (resolve(layout.root) !== resolve(expectedRoot)) {
    throw new Error(`Refusing to remove unexpected deployment root: ${layout.root}`);
  }
  validateMetadata(layout, metadata);
  const stat = await lstat(layout.root);
  if (stat.isSymbolicLink()) throw new Error('Refusing to remove a symlink deployment root');
  if (!stat.isDirectory()) throw new Error('Deployment root is not a directory');
  const actual = await realpath(layout.root);
  const expectedActual = await realpath(expectedRoot);
  if (resolve(actual) !== resolve(expectedActual)) {
    throw new Error(`Deployment root resolves elsewhere: ${actual}`);
  }
}
