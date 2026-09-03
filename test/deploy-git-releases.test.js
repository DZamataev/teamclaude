import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDeployLayout } from '../src/deploy/layout.js';
import {
  createGitReleaseStore,
  validateRemoteUrl,
  validateRequestedRef,
} from '../src/deploy/git-releases.js';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'tc-git-store-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = join(home, 'source');
  const remote = join(home, 'remote.git');
  await mkdir(source);
  git(source, 'init', '-b', 'master');
  git(source, 'config', 'user.email', 'test@example.com');
  git(source, 'config', 'user.name', 'TeamClaude Test');
  await writeFile(join(source, 'value.txt'), 'one\n');
  git(source, 'add', 'value.txt');
  git(source, 'commit', '-m', 'first');
  const first = git(source, 'rev-parse', 'HEAD');
  git(source, 'tag', 'v1.0.0');
  git(source, 'switch', '-c', 'feature');
  await writeFile(join(source, 'value.txt'), 'two\n');
  git(source, 'commit', '-am', 'feature');
  const feature = git(source, 'rev-parse', 'HEAD');
  git(source, 'switch', 'master');
  git(home, 'clone', '--bare', source, remote);
  const remoteUrl = pathToFileURL(remote).href;
  const layout = resolveDeployLayout({
    platform: 'darwin', home: join(home, 'deploy-home'),
    configPath: join(home, 'config', 'teamclaude.json'),
  });
  return { home, source, remote, remoteUrl, layout, first, feature };
}

test('remote and ref validation rejects injection-shaped inputs', () => {
  assert.equal(validateRemoteUrl('https://github.com/dzamataev/teamclaude.git'), 'https://github.com/dzamataev/teamclaude.git');
  assert.equal(validateRemoteUrl('git@github.com:dzamataev/teamclaude.git'), 'git@github.com:dzamataev/teamclaude.git');
  assert.equal(validateRemoteUrl('file:///tmp/teamclaude.git'), 'file:///tmp/teamclaude.git');
  assert.throws(() => validateRemoteUrl('https://token@github.com/org/repo.git'), /credentials/);
  assert.throws(() => validateRemoteUrl('/tmp/local-path'), /remote URL/);
  assert.throws(() => validateRequestedRef('-c core.sshCommand=evil'), /start with/);
  assert.throws(() => validateRequestedRef('master~1'), /invalid ref/i);
  assert.throws(() => validateRequestedRef('master..other'), /invalid ref/i);
  assert.equal(validateRequestedRef('feature/deploy-cli'), 'feature/deploy-cli');
  assert.equal(validateRequestedRef('1342e92b7207'), '1342e92b7207');
});

test('repository setup is idempotent and refuses a different origin', async (t) => {
  const f = await fixture(t);
  const store = createGitReleaseStore({ layout: f.layout });
  await store.ensureRepository(f.remoteUrl);
  assert.equal(git(f.layout.repo, 'remote', 'get-url', 'origin'), f.remoteUrl);
  await store.ensureRepository(f.remoteUrl);
  await assert.rejects(store.ensureRepository('file:///tmp/other.git'), /different remote/i);
  assert.equal(git(f.layout.repo, 'remote', 'get-url', 'origin'), f.remoteUrl);
});

test('branches, tags, and commits resolve to immutable commits', async (t) => {
  const f = await fixture(t);
  const store = createGitReleaseStore({ layout: f.layout });
  await store.ensureRepository(f.remoteUrl);
  await store.fetch();
  assert.equal(await store.resolveRef('feature'), f.feature);
  assert.equal(await store.resolveRef('v1.0.0'), f.first);
  assert.equal(await store.resolveRef(f.first.slice(0, 12)), f.first);
  assert.throws(() => store.resolveRef('does-not-exist'), /cannot resolve/i);

  const blob = git(f.layout.repo, 'hash-object', '-w', join(f.source, 'value.txt'));
  assert.throws(() => store.resolveRef(blob), /cannot resolve|commit/i);
});

test('candidate releases are detached worktrees below releases', async (t) => {
  const f = await fixture(t);
  const store = createGitReleaseStore({
    layout: f.layout,
    now: () => new Date('2026-08-27T10:30:03.000Z'),
  });
  await store.ensureRepository(f.remoteUrl);
  await store.fetch();
  const candidate = await store.createCandidate(f.feature);
  assert.equal(dirname(candidate.path), f.layout.releases);
  assert.match(candidate.path, /20260827T103003Z-[a-f0-9]{12}$/);
  assert.equal(candidate.commit, f.feature);
  assert.equal(git(candidate.path, 'rev-parse', 'HEAD'), f.feature);
  assert.equal(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: candidate.path }).status, 1);
});

test('activation and rollback toggle only safe release links', async (t) => {
  const f = await fixture(t);
  const store = createGitReleaseStore({ layout: f.layout });
  const releaseA = join(f.layout.releases, 'release-a');
  const releaseB = join(f.layout.releases, 'release-b');
  await mkdir(releaseA, { recursive: true });
  await mkdir(releaseB);
  await symlink(releaseA, f.layout.current);

  await store.activate(releaseB);
  assert.equal(await realpath(f.layout.current), await realpath(releaseB));
  assert.equal(await realpath(f.layout.previous), await realpath(releaseA));

  await store.swapForRollback();
  assert.equal(await realpath(f.layout.current), await realpath(releaseA));
  assert.equal(await realpath(f.layout.previous), await realpath(releaseB));

  await store.swapForRollback();
  assert.equal(await realpath(f.layout.current), await realpath(releaseB));
  assert.equal(await realpath(f.layout.previous), await realpath(releaseA));
  assert.ok((await readlink(f.layout.current)).includes('release-b'));
});

test('selection rejects regular files, dangling links, and outside targets', async (t) => {
  const f = await fixture(t);
  const store = createGitReleaseStore({ layout: f.layout });
  await mkdir(f.layout.releases, { recursive: true });

  await writeFile(f.layout.current, 'not a link');
  await assert.rejects(store.readSelection(), /symbolic link/i);
  await rm(f.layout.current);

  await symlink(join(f.layout.releases, 'missing'), f.layout.current);
  await assert.rejects(store.readSelection(), /dangling|resolve/i);
  await rm(f.layout.current);

  const outside = join(f.home, 'outside');
  await mkdir(outside);
  await symlink(outside, f.layout.current);
  await assert.rejects(store.readSelection(), /outside|releases/i);
});

test('a failed second rename restores the original selection', async (t) => {
  const f = await fixture(t);
  const releaseA = join(f.layout.releases, 'release-a');
  const releaseB = join(f.layout.releases, 'release-b');
  const releaseC = join(f.layout.releases, 'release-c');
  await mkdir(releaseA, { recursive: true });
  await mkdir(releaseB);
  await mkdir(releaseC);
  await symlink(releaseA, f.layout.current);
  await symlink(releaseB, f.layout.previous);

  const fs = await import('node:fs/promises');
  let renames = 0;
  const store = createGitReleaseStore({
    layout: f.layout,
    fs: {
      ...fs,
      rename: async (...args) => {
        renames++;
        if (renames === 2) throw new Error('injected rename failure');
        return fs.rename(...args);
      },
    },
  });

  await assert.rejects(store.activate(releaseC), /injected rename failure/);
  assert.equal(await realpath(f.layout.current), await realpath(releaseA));
  assert.equal(await realpath(f.layout.previous), await realpath(releaseB));
});
