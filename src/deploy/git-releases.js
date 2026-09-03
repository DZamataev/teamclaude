import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fsPromises from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const COMMAND_TIMEOUT_MS = 120_000;

function defaultRun(command, argv, { cwd, timeoutMs = COMMAND_TIMEOUT_MS, stdio = 'pipe' } = {}) {
  const result = spawnSync(command, argv, {
    cwd,
    encoding: 'utf8',
    stdio,
    timeout: timeoutMs,
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
  };
}

function commandError(command, argv, result) {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
  return new Error(`${command} ${argv.join(' ')} failed (${result.code}): ${detail}`);
}

export function validateRemoteUrl(remoteUrl) {
  if (typeof remoteUrl !== 'string' || !remoteUrl || /[\0\r\n]/.test(remoteUrl)) {
    throw new Error('Invalid Git remote URL');
  }
  if (/^[^/@\s]+@[^:\s]+:.+/.test(remoteUrl)) return remoteUrl;
  let parsed;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    throw new Error(`Invalid Git remote URL: ${remoteUrl}`);
  }
  if (!['https:', 'ssh:', 'git:', 'file:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported Git remote URL protocol: ${parsed.protocol}`);
  }
  if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && (parsed.username || parsed.password)) {
    throw new Error('Git remote URL must not contain credentials');
  }
  return remoteUrl;
}

export function validateRequestedRef(ref) {
  if (typeof ref !== 'string' || !ref) throw new Error('A Git ref is required');
  if (ref.startsWith('-')) throw new Error('Git refs must not start with -');
  if (/[\0\r\n\\]/.test(ref) || ref.includes('..') || ref.includes('@{')) {
    throw new Error(`Invalid ref: ${ref}`);
  }
  if (/^[a-f0-9]{7,40}$/i.test(ref)) return ref;
  const checked = spawnSync('git', ['check-ref-format', `refs/teamclaude/${ref}`], {
    encoding: 'utf8', timeout: 5000,
  });
  if (checked.status !== 0) throw new Error(`Invalid ref: ${ref}`);
  return ref;
}

function timestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function isBelow(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

export function createGitReleaseStore({
  layout,
  run = defaultRun,
  fs = fsPromises,
  now = () => new Date(),
} = {}) {
  if (!layout) throw new Error('A deployment layout is required');

  const runGit = (argv, options = {}) => {
    const result = run('git', argv, options);
    if (result.code !== 0) throw commandError('git', argv, result);
    return result.stdout.trim();
  };

  const tryGit = (argv, options = {}) => {
    const result = run('git', argv, options);
    return result.code === 0 ? result.stdout.trim() : null;
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

  async function ensureRepository(remoteUrl) {
    const validated = validateRemoteUrl(remoteUrl);
    if (!await exists(layout.repo)) {
      await fs.mkdir(dirname(layout.repo), { recursive: true, mode: 0o755 });
      runGit(['clone', '--origin', 'origin', '--', validated, layout.repo]);
      return { cloned: true, remoteUrl: validated };
    }
    const inside = tryGit(['-C', layout.repo, 'rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true') throw new Error(`${layout.repo} is not a Git working tree`);
    const configured = runGit(['-C', layout.repo, 'remote', 'get-url', 'origin']);
    if (configured !== validated) {
      throw new Error(`Deployment repository uses a different remote: ${configured}`);
    }
    return { cloned: false, remoteUrl: configured };
  }

  function fetch() {
    runGit(['-C', layout.repo, 'fetch', '--prune', '--tags', 'origin']);
  }

  function resolveRef(ref) {
    const validated = validateRequestedRef(ref);
    const candidates = [
      `refs/remotes/origin/${validated}`,
      `refs/tags/${validated}`,
    ];
    if (/^[a-f0-9]{7,40}$/i.test(validated)) candidates.push(validated);
    for (const candidate of candidates) {
      const commit = tryGit(['-C', layout.repo, 'rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
      if (commit && /^[a-f0-9]{40}$/i.test(commit)) return commit;
    }
    throw new Error(`Cannot resolve Git ref to a commit: ${validated}`);
  }

  async function createCandidate(commit) {
    if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error(`Invalid commit: ${commit}`);
    const verified = tryGit(['-C', layout.repo, 'rev-parse', '--verify', '--quiet', `${commit}^{commit}`]);
    if (!verified) throw new Error(`Commit is not available in the deployment repository: ${commit}`);
    await fs.mkdir(layout.releases, { recursive: true, mode: 0o755 });
    const base = `${timestamp(now())}-${verified.slice(0, 12)}`;
    let path = join(layout.releases, base);
    let suffix = 1;
    while (await exists(path)) path = join(layout.releases, `${base}-${suffix++}`);
    runGit(['-C', layout.repo, 'worktree', 'add', '--detach', path, verified]);
    return { path, commit: verified };
  }

  async function safeRelease(path, label = 'release') {
    let target;
    try {
      target = await fs.realpath(path);
    } catch (error) {
      throw new Error(`${label} is dangling or cannot resolve: ${path}`, { cause: error });
    }
    let releases;
    try {
      releases = await fs.realpath(layout.releases);
    } catch (error) {
      throw new Error(`Releases directory cannot resolve: ${layout.releases}`, { cause: error });
    }
    if (!isBelow(releases, target) || dirname(target) !== releases) {
      throw new Error(`${label} resolves outside the releases directory: ${target}`);
    }
    const stat = await fs.lstat(target);
    if (!stat.isDirectory()) throw new Error(`${label} is not a release directory: ${target}`);
    return target;
  }

  async function readLink(link, label) {
    let stat;
    try {
      stat = await fs.lstat(link);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (!stat.isSymbolicLink()) throw new Error(`${label} must be a symbolic link`);
    return safeRelease(link, label);
  }

  async function readSelection() {
    return {
      current: await readLink(layout.current, 'current'),
      previous: await readLink(layout.previous, 'previous'),
    };
  }

  async function atomicLink(link, target) {
    const safeTarget = await safeRelease(target, basename(link));
    const temporary = `${link}.next-${process.pid}-${randomUUID()}`;
    try {
      await fs.symlink(safeTarget, temporary);
      await fs.rename(temporary, link);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function restoreLink(link, target) {
    if (target === null) {
      await fs.rm(link, { force: true });
    } else {
      await atomicLink(link, target);
    }
  }

  async function activate(candidatePath) {
    const candidate = await safeRelease(candidatePath, 'candidate');
    const original = await readSelection();
    try {
      if (original.current) await atomicLink(layout.previous, original.current);
      await atomicLink(layout.current, candidate);
    } catch (error) {
      await restoreLink(layout.previous, original.previous).catch(() => {});
      await restoreLink(layout.current, original.current).catch(() => {});
      throw error;
    }
    return { current: candidate, previous: original.current };
  }

  async function swapForRollback() {
    const original = await readSelection();
    if (!original.current || !original.previous) throw new Error('Both current and previous releases are required for rollback');
    try {
      await atomicLink(layout.current, original.previous);
      await atomicLink(layout.previous, original.current);
    } catch (error) {
      await restoreLink(layout.current, original.current).catch(() => {});
      await restoreLink(layout.previous, original.previous).catch(() => {});
      throw error;
    }
    return { current: original.previous, previous: original.current };
  }

  async function restoreSelection(selection) {
    if (!selection || !Object.hasOwn(selection, 'current') || !Object.hasOwn(selection, 'previous')) {
      throw new Error('A complete release selection is required');
    }
    if (selection.current) await safeRelease(selection.current, 'current restore target');
    if (selection.previous) await safeRelease(selection.previous, 'previous restore target');
    const original = await readSelection();
    try {
      await restoreLink(layout.current, selection.current);
      await restoreLink(layout.previous, selection.previous);
    } catch (error) {
      await restoreLink(layout.current, original.current).catch(() => {});
      await restoreLink(layout.previous, original.previous).catch(() => {});
      throw error;
    }
  }

  async function describeRelease(path) {
    if (!path) return null;
    const safePath = await safeRelease(path);
    const commit = runGit(['-C', safePath, 'rev-parse', '--verify', 'HEAD^{commit}']);
    return { path: safePath, commit };
  }

  return {
    ensureRepository,
    fetch,
    resolveRef,
    createCandidate,
    readSelection,
    activate,
    swapForRollback,
    restoreSelection,
    describeRelease,
  };
}
