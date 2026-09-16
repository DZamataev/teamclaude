import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, stat, chmod, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const configModuleUrl = new URL('../src/config.js', import.meta.url).href;

// The config holds every account's OAuth tokens and the proxy key. A save that
// truncates in place leaves nothing behind if the process dies mid-write; a
// save must therefore replace the file whole or not at all, and must not leave
// a half-written copy of the credentials beside it.

async function withConfigDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tc-atomic-'));
  const prev = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = join(dir, 'teamclaude.json');
  try {
    const cfg = await import('../src/config.js');
    await fn({ dir, cfg, path: process.env.TEAMCLAUDE_CONFIG });
  } finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = prev;
  }
}

const onPosix = process.platform !== 'win32';

test('saveConfig writes the whole document and leaves no temp file behind', async () => {
  await withConfigDir(async ({ dir, cfg, path }) => {
    const config = { proxy: { port: 1, apiKey: 'tc-secret' }, accounts: [{ name: 'a', refreshToken: 'rt' }] };
    await cfg.saveConfig(config);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf-8')), config);
    assert.deepEqual(await readdir(dir), ['teamclaude.json'], 'only the config itself is on disk');
    if (onPosix) assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

test('saveConfig replaces a pre-existing file and tightens its mode', async () => {
  await withConfigDir(async ({ dir, cfg, path }) => {
    await writeFile(path, '{"old":true}\n');
    if (onPosix) await chmod(path, 0o644);
    await cfg.saveConfig({ fresh: true });
    assert.deepEqual(JSON.parse(await readFile(path, 'utf-8')), { fresh: true });
    assert.deepEqual(await readdir(dir), ['teamclaude.json']);
    if (onPosix) assert.equal((await stat(path)).mode & 0o777, 0o600, 'a world-readable config becomes 0600 on save');
  });
});

test('saveState is atomic the same way', async () => {
  await withConfigDir(async ({ dir, cfg }) => {
    const statePath = cfg.getStatePath();
    await cfg.saveState({ quota: { a: 1 } });
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf-8')), { quota: { a: 1 } });
    assert.deepEqual(await readdir(dir), ['teamclaude.state.json']);
    if (onPosix) assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  });
});

test('a save that cannot complete leaves the previous config intact and no temp file', async () => {
  await withConfigDir(async ({ dir, cfg, path }) => {
    await cfg.saveConfig({ good: true });
    // A BigInt cannot be serialized: the failure happens before anything is
    // written, and the file on disk must still be the last complete document.
    await assert.rejects(cfg.saveConfig({ bad: 1n }), TypeError);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf-8')), { good: true });
    assert.deepEqual(await readdir(dir), ['teamclaude.json'], 'no temp file is left beside the config');
  });
});

test('the round trip through loadConfig reads back what saveConfig wrote', async () => {
  await withConfigDir(async ({ cfg }) => {
    const config = cfg.createDefaultConfig();
    config.accounts.push({ name: 'a', type: 'oauth', accessToken: 'at', refreshToken: 'rt' });
    await cfg.saveConfig(config);
    const loaded = await cfg.loadConfig();
    assert.equal(loaded.proxy.apiKey, config.proxy.apiKey);
    assert.equal(loaded.accounts[0].refreshToken, 'rt');
  });
});

test('saveConfig follows a symlinked config to its target instead of replacing the link', { skip: !onPosix }, async () => {
  await withConfigDir(async ({ dir, cfg, path }) => {
    const { symlink, lstat } = await import('node:fs/promises');
    const real = join(dir, 'real.json');
    await writeFile(real, '{"old":true}\n');
    await symlink(real, path);
    await cfg.saveConfig({ proxy: { port: 2, apiKey: 'k' }, accounts: [] });
    assert.ok((await lstat(path)).isSymbolicLink(), 'the config path is still a symlink');
    assert.deepEqual(JSON.parse(await readFile(real, 'utf-8')).proxy.port, 2, 'the link target received the write');
    assert.deepEqual((await readdir(dir)).sort(), ['real.json', 'teamclaude.json']);
  });
});

// The lock deadline exists to break a STUCK holder — a process that died
// holding the file, or one wedged mid-write. It is not a budget for the whole
// wait: N processes updating the config take N turns by construction, and a
// slow machine makes each turn long. Measuring the TOTAL wait against a fixed
// deadline fails the processes at the back of a queue that is working
// perfectly, and the queue that matters is several OAuth accounts persisting
// rotated refresh tokens at once — a caller that gives up there loses a token
// that was already rotated away, which costs a re-login.
//
// This has to be driven by real processes: within one process the update chain
// serializes callers before the file lock is ever contended, so an in-process
// version of this test passes against either rule and proves nothing.
function spawnUpdater(configPath, name, holdMs) {
  const source = `
    import { atomicConfigUpdate } from ${JSON.stringify(configModuleUrl)};
    await atomicConfigUpdate(async config => {
      config.accounts.push({ name: ${JSON.stringify(name)} });
      await new Promise(r => setTimeout(r, ${holdMs}));
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', c => { stderr += c; });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => resolve({ code, stderr }));
  });
}

test('a long but progressing queue of separate processes does not time out', async () => {
  await withConfigDir(async ({ cfg, path }) => {
    await cfg.saveConfig({ proxy: { port: 1 }, accounts: [] });

    // Each holder keeps the lock for a good fraction of the staleness window
    // without reaching it, so the queue as a whole runs several times longer
    // than any fixed total-wait cap — the shape such a cap fails on however
    // fast the machine is — while no individual holder is ever stale.
    const HOLD_MS = 1_500;
    const TURNS = 8;
    const results = await Promise.all(
      Array.from({ length: TURNS }, (_, i) => spawnUpdater(path, `acct-${i}`, HOLD_MS)),
    );

    for (const r of results) assert.equal(r.code, 0, r.stderr);
    const saved = JSON.parse(await readFile(path, 'utf-8'));
    assert.deepEqual(
      new Set(saved.accounts.map(a => a.name)),
      new Set(Array.from({ length: TURNS }, (_, i) => `acct-${i}`)),
      'every process persisted its update',
    );
  });
});

// The other half of the same rule: a lock left behind by a process that died
// mid-update must not wedge every later one. Since a live holder is now waited
// on indefinitely, the thing that breaks the deadlock is noticing the owner is
// gone — so the update must SUCCEED here, not merely fail in bounded time.
test('a lock left by a dead process is broken, not waited on forever', async () => {
  await withConfigDir(async ({ cfg, path }) => {
    await cfg.saveConfig({ proxy: { port: 1 }, accounts: [] });

    // A real pid that is no longer running: a process spawned and reaped, which
    // is exactly the corpse a killed updater leaves pointing out of its lock.
    // Written in the lock file's documented shape so the reader takes the pid
    // path rather than falling back to the file's age.
    const corpse = spawn(process.execPath, ['--eval', '0'], { stdio: 'ignore' });
    const deadPid = await new Promise(resolve => corpse.on('exit', () => resolve(corpse.pid)));
    await writeFile(`${path}.lock`, JSON.stringify({ pid: deadPid, at: Date.now() }));

    const started = Date.now();
    await cfg.atomicConfigUpdate(config => { config.accounts.push({ name: 'after-the-corpse' }); });
    const saved = JSON.parse(await readFile(path, 'utf-8'));

    assert.deepEqual(saved.accounts.map(a => a.name), ['after-the-corpse'], 'the update went through');
    assert.ok(Date.now() - started < 60_000, `broke the stale lock promptly, took ${Date.now() - started}ms`);
  });
});

// The dangerous mistake in the other direction: breaking a lock whose owner is
// merely slow loses the very write the lock protects. A live holder is waited
// on for as long as it keeps its turn inside the staleness window — elapsed
// time alone never overrides a pid that is still running.
test('a lock held by a live process is never stolen', async () => {
  await withConfigDir(async ({ cfg, path }) => {
    await cfg.saveConfig({ proxy: { port: 1 }, accounts: [] });

    // A process that is alive and doing nothing, announced in the lock file's
    // documented shape: `{"pid":…,"at":…}`. That means "someone is working".
    const holder = spawn(process.execPath, ['--eval', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    await writeFile(`${path}.lock`, JSON.stringify({ pid: holder.pid, at: Date.now() }));

    try {
      const update = cfg.atomicConfigUpdate(config => { config.accounts.push({ name: 'stolen' }); });
      const outcome = await Promise.race([
        update.then(() => 'completed', err => `failed: ${err.message}`),
        // Well past the 2s total-wait cap this replaced, and inside the
        // staleness window, where a live holder is simply waited on.
        new Promise(resolve => setTimeout(() => resolve('still waiting'), 5_000)),
      ]);
      assert.equal(outcome, 'still waiting', 'a live holder must not be overridden by elapsed time');

      // Releasing the lock lets the waiter through, proving it was queued
      // rather than wedged.
      holder.kill('SIGKILL');
      await new Promise(resolve => holder.on('exit', resolve));
      await unlink(`${path}.lock`).catch(() => {});
      await update;
      assert.deepEqual(JSON.parse(await readFile(path, 'utf-8')).accounts.map(a => a.name), ['stolen']);
    } finally {
      holder.kill('SIGKILL');
    }
  });
});
