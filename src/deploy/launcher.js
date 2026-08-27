import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  realpathSync,
} from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readFile as fsReadFile,
  rename as fsRename,
  rm as fsRm,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { currentVersion, installKind as detectInstallKind, PKG_NAME } from '../updater.js';

export const LAUNCHER_OWNER = 'teamclaude-git-deploy-v1';

function defaultFindExecutable(command, pathEnv = process.env.PATH || '') {
  for (const directory of pathEnv.split(':').filter(Boolean)) {
    const candidate = resolve(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* keep searching */ }
  }
  return null;
}

function defaultIsExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandSucceeded(value) {
  return value && !value.error && (value.code ?? value.status) === 0;
}

function commandError(command, argv, value) {
  const detail = String(value?.stderr || value?.error?.message || '').trim();
  const code = value?.code ?? value?.status ?? 'unknown';
  return new Error(`${command} ${argv.join(' ')} failed with exit code ${code}${detail ? `: ${detail}` : ''}`);
}

function defaultRun(command, argv, options = {}) {
  const value = spawnSync(command, argv, { encoding: 'utf8', ...options });
  return { ...value, code: value.status };
}

export function discoverBootstrap({
  execPath = process.execPath,
  nodeVersion = process.versions.node,
  pathEnv = process.env.PATH || '',
  findExecutable = defaultFindExecutable,
  realpath = realpathSync,
  isExecutable = defaultIsExecutable,
  installKind = detectInstallKind(),
  packageVersion = currentVersion(),
  invokedCommandPath = process.argv[1] ? resolve(process.argv[1]) : null,
} = {}) {
  const major = Number.parseInt(String(nodeVersion).split('.')[0], 10);
  if (!Number.isInteger(major) || major < 20) {
    throw new Error(`teamclaude deploy requires Node.js 20 or newer; found ${nodeVersion}`);
  }

  let nodePath = execPath;
  const pathNode = findExecutable('node', pathEnv);
  try {
    if (pathNode && realpath(pathNode) === realpath(execPath)) nodePath = pathNode;
  } catch { /* process.execPath remains authoritative */ }
  if (!isAbsolute(nodePath) || !isExecutable(nodePath)) {
    throw new Error(`The running Node executable is not accessible: ${nodePath}`);
  }

  const adjacentNpm = join(dirname(nodePath), 'npm');
  const npmPath = isExecutable(adjacentNpm) ? adjacentNpm : findExecutable('npm', pathEnv);
  if (!npmPath || !isAbsolute(npmPath) || !isExecutable(npmPath)) {
    throw new Error('Could not find an executable npm on PATH');
  }
  return { nodePath, npmPath, invokedCommandPath, installKind, packageVersion };
}

function isVersionOwnedDirectory(directory) {
  const normalized = directory.replaceAll('\\', '/');
  return [
    '/.nvm/versions/node/',
    '/.asdf/installs/nodejs/',
    '/.volta/tools/image/node/',
    '/Cellar/node/',
  ].some(fragment => normalized.includes(fragment));
}

export function chooseLauncherPath({
  layout,
  pathEnv = process.env.PATH || '',
  access = directory => {
    try {
      accessSync(directory, constants.W_OK | constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
}) {
  if (layout.platform === 'linux') {
    return { path: layout.defaultLauncher || '/usr/local/bin/teamclaude', pathInstruction: null };
  }

  const stable = new Set(['/usr/local/bin', '/opt/homebrew/bin', join(layout.home, '.local', 'bin')]);
  for (const directory of pathEnv.split(':').filter(Boolean)) {
    if (stable.has(directory) && !isVersionOwnedDirectory(directory) && access(directory)) {
      return { path: join(directory, 'teamclaude'), pathInstruction: null };
    }
  }
  const binDir = layout.binDir || join(layout.root, 'bin');
  const homeRelative = binDir.startsWith(`${layout.home}/`) ? `$HOME/${binDir.slice(layout.home.length + 1)}` : binDir;
  return {
    path: join(binDir, 'teamclaude'),
    pathInstruction: `path=("${homeRelative}" $path)\nexport PATH`,
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function renderLauncher({ nodePath, entryPath }) {
  return [
    '#!/bin/sh',
    `# TeamClaude-Owner: ${LAUNCHER_OWNER}`,
    `exec ${shellQuote(nodePath)} ${shellQuote(entryPath)} "$@"`,
    '',
  ].join('\n');
}

export async function handoffLauncher({
  bootstrap,
  launcherPath,
  entryPath,
  run = defaultRun,
  writeFile = fsWriteFile,
  chmodFile = chmod,
  rename = fsRename,
  nonce = randomUUID(),
  pid = process.pid,
  onEvent = () => {},
}) {
  if (bootstrap.installKind === 'global' && !bootstrap.packageVersion) {
    throw new Error('Cannot hand off a global npm installation without its exact npm package version');
  }
  const stagedPath = `${launcherPath}.next-${pid}-${nonce}`;
  await mkdir(dirname(launcherPath), { recursive: true, mode: 0o755 });
  const script = renderLauncher({ nodePath: bootstrap.nodePath, entryPath });
  await writeFile(stagedPath, script, { flag: 'wx', mode: 0o755 });
  onEvent('write', stagedPath);
  await chmodFile(stagedPath, 0o755);
  onEvent('chmod', stagedPath, 0o755);

  const smoke = run(stagedPath, ['version']);
  if (!commandSucceeded(smoke)) {
    await fsRm(stagedPath, { force: true }).catch(() => {});
    throw commandError(stagedPath, ['version'], smoke);
  }

  const npmRestore = {
    packageName: PKG_NAME,
    version: bootstrap.installKind === 'global' ? bootstrap.packageVersion : null,
    npmPath: bootstrap.npmPath,
  };
  let npmCleanupPending = false;
  let warning;
  if (bootstrap.installKind === 'global') {
    const uninstallArgs = ['uninstall', '-g', PKG_NAME];
    const uninstall = run(bootstrap.nodePath, [bootstrap.npmPath, ...uninstallArgs]);
    if (!commandSucceeded(uninstall)) {
      npmCleanupPending = true;
      warning = `Global npm cleanup is still pending. Run: npm uninstall -g ${PKG_NAME}`;
    }
  }

  try {
    await rename(stagedPath, launcherPath);
    onEvent('rename', stagedPath, launcherPath);
  } catch (error) {
    throw new Error(`Could not publish launcher; staged launcher remains available at ${stagedPath}: ${error.message}`, { cause: error });
  }
  const verification = run(launcherPath, ['version']);
  if (!commandSucceeded(verification)) throw commandError(launcherPath, ['version'], verification);

  return {
    launcherPath,
    npmCleanupPending,
    npmRestore,
    ...(warning ? { warning } : {}),
  };
}

async function pathExists(path, exists) {
  return Boolean(await exists(path));
}

export async function resolveNpmRestore({
  npmRestore,
  nodePath,
  run = defaultRun,
  exists = async path => existsSync(path),
  pathEnv = process.env.PATH || '',
  findExecutable = defaultFindExecutable,
}) {
  if (!npmRestore || npmRestore.packageName !== PKG_NAME) {
    throw new Error('Invalid npm restoration metadata');
  }
  let npmPath = npmRestore.npmPath;
  if (!await pathExists(npmPath, exists)) {
    const adjacent = join(dirname(nodePath), 'npm');
    if (await pathExists(adjacent, exists)) npmPath = adjacent;
    else {
      const pathNpm = findExecutable('npm', pathEnv);
      if (!pathNpm || !await pathExists(pathNpm, exists)) {
        throw new Error('Could not find npm to restore the global TeamClaude package');
      }
      npmPath = pathNpm;
    }
  }
  const packageSpec = `${PKG_NAME}@${npmRestore.version ?? 'latest'}`;
  const prefixResult = run(nodePath, [npmPath, 'prefix', '--global']);
  if (!commandSucceeded(prefixResult)) throw commandError(npmPath, ['prefix', '--global'], prefixResult);
  const prefix = String(prefixResult.stdout || '').trim();
  if (!isAbsolute(prefix)) throw new Error(`npm returned an invalid global prefix: ${prefix || '(empty)'}`);
  return { packageSpec, nodePath, npmPath, commandPath: join(prefix, 'bin', 'teamclaude') };
}

export async function restoreGlobalNpm(resolved, { run = defaultRun } = {}) {
  const installArgs = ['install', '--global', resolved.packageSpec];
  const installed = run(resolved.nodePath, [resolved.npmPath, ...installArgs], { stdio: 'inherit' });
  if (!commandSucceeded(installed)) throw commandError(resolved.npmPath, installArgs, installed);
  const verified = run(resolved.commandPath, ['version']);
  if (!commandSucceeded(verified)) throw commandError(resolved.commandPath, ['version'], verified);
  return { ...resolved };
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

export async function removeOwnedLauncher({
  launcherPath,
  readFile = fsReadFile,
  rm = fsRm,
  stat = lstat,
}) {
  let before;
  try {
    before = await stat(launcherPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { removed: false, preserved: false };
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) return { removed: false, preserved: true };
  const firstContents = await readFile(launcherPath, 'utf8');
  if (!firstContents.includes(`TeamClaude-Owner: ${LAUNCHER_OWNER}`)) {
    return { removed: false, preserved: true };
  }
  const secondContents = await readFile(launcherPath, 'utf8');
  const after = await stat(launcherPath);
  if (!sameFile(before, after) || secondContents !== firstContents || !secondContents.includes(`TeamClaude-Owner: ${LAUNCHER_OWNER}`)) {
    return { removed: false, preserved: true };
  }
  await rm(launcherPath);
  return { removed: true, preserved: false };
}
