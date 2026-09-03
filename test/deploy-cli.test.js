import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseDeployArgs,
  promptYesNo,
  runDeployCli,
  showDeployHelp,
} from '../src/deploy/cli.js';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'src', 'index.js');

function streamPair(inputText = '', isTTY = true) {
  const input = new PassThrough();
  input.isTTY = isTTY;
  input.end(inputText);
  const output = new PassThrough();
  const stdout = new PassThrough();
  return {
    input, output, stdout,
    errorText: () => output.read()?.toString() || '',
    stdoutText: () => stdout.read()?.toString() || '',
  };
}

function fakeManager(overrides = {}) {
  const calls = [];
  const manager = {
    install: async options => { calls.push(['install', options]); return { ok: true, partial: false, commit: 'a'.repeat(40), releasePath: '/release' }; },
    deployRef: async options => { calls.push(['deployRef', options]); return { ok: true, commit: 'b'.repeat(40), releasePath: '/release' }; },
    rollback: async () => { calls.push(['rollback']); return { ok: true, current: '/current', previous: '/previous' }; },
    restart: async () => { calls.push(['restart']); return { ok: true }; },
    logs: async options => { calls.push(['logs', options]); return { ok: true, code: 0 }; },
    status: async () => { calls.push(['status']); return { installed: false, platform: 'linux', root: '/opt/teamclaude', detail: 'not installed' }; },
    uninstall: async options => { calls.push(['uninstall', options]); return {
      ok: true, partial: false, restoredNpm: options.restoreNpm,
      packageSpec: options.restoreNpm ? '@karpeleslab/teamclaude@1.1.13' : null,
      commandPath: options.restoreNpm ? '/prefix/bin/teamclaude' : null,
      restoredService: options.restoreNpm, launcherRemoved: !options.restoreNpm,
      removedRoot: true, remainingPaths: [],
    }; },
    ...overrides,
  };
  return { manager, calls };
}

test('deploy parser accepts every public command form', () => {
  assert.deepEqual(parseDeployArgs(['install', 'https://example/repo.git']),
    { command: 'install', remoteUrl: 'https://example/repo.git', ref: 'master' });
  assert.deepEqual(parseDeployArgs(['install', 'https://example/repo.git', '--ref', 'feature']),
    { command: 'install', remoteUrl: 'https://example/repo.git', ref: 'feature' });
  assert.deepEqual(parseDeployArgs(['ref', 'v1.2.0']), { command: 'ref', ref: 'v1.2.0' });
  assert.deepEqual(parseDeployArgs(['rollback']), { command: 'rollback' });
  assert.deepEqual(parseDeployArgs(['restart']), { command: 'restart' });
  assert.deepEqual(parseDeployArgs(['logs']), { command: 'logs', lines: 100, follow: true });
  assert.deepEqual(parseDeployArgs(['logs', '--lines', '250', '--no-follow']),
    { command: 'logs', lines: 250, follow: false });
  assert.deepEqual(parseDeployArgs(['status', '--json']), { command: 'status', json: true });
  assert.deepEqual(parseDeployArgs(['uninstall']), { command: 'uninstall', yes: false, restoreNpm: null });
  assert.deepEqual(parseDeployArgs(['uninstall', '--yes', '--restore-npm']),
    { command: 'uninstall', yes: true, restoreNpm: true });
  assert.deepEqual(parseDeployArgs(['uninstall', '--yes', '--no-restore-npm']),
    { command: 'uninstall', yes: true, restoreNpm: false });
  assert.deepEqual(parseDeployArgs([]), { command: 'help' });
  assert.deepEqual(parseDeployArgs(['help']), { command: 'help' });
});

test('deploy parser rejects ambiguous or malformed arguments with usage status', () => {
  for (const argv of [
    ['install'], ['install', 'url', '--ref'], ['install', 'url', '--json'],
    ['ref'], ['ref', 'a', 'b'], ['rollback', 'extra'], ['logs', '--lines', '0'],
    ['logs', '--lines', '1.5'], ['logs', '--lines', '100001'], ['logs', '--wat'],
    ['status', '--json', '--json'], ['uninstall', '--yes', '--yes'],
    ['uninstall', '--restore-npm', '--no-restore-npm'], ['unknown'],
  ]) {
    assert.throws(() => parseDeployArgs(argv), error => error.exitCode === 64, argv.join(' '));
  }
});

test('deploy help is the exact public command surface', () => {
  const output = new PassThrough();
  showDeployHelp(output);
  assert.equal(output.read().toString(), `teamclaude deploy install <git-url> [--ref master]
teamclaude deploy ref <branch|tag|commit>
teamclaude deploy rollback
teamclaude deploy restart
teamclaude deploy logs [--lines 100] [--no-follow]
teamclaude deploy status [--json]
teamclaude deploy uninstall [--yes] [--restore-npm|--no-restore-npm]
teamclaude deploy help
`);
});

test('yes/no prompt handles defaults, case, retries, and EOF', async () => {
  for (const [inputText, defaultValue, expected] of [
    ['y\n', false, true], ['YES\n', false, true], ['n\n', true, false], ['No\n', true, false],
    ['\n', false, false], ['\n', true, true], ['maybe\nyes\n', false, true], ['', false, null],
  ]) {
    const io = streamPair(inputText);
    assert.equal(await promptYesNo({ input: io.input, output: io.output, question: 'Continue?', defaultValue }), expected);
  }
});

test('interactive uninstall resolves both decisions before calling manager', async () => {
  for (const [argv, answers, expectedRestore, firstPrompt, secondPrompt] of [
    [['uninstall'], 'yes\nno\n', false, true, true],
    [['uninstall', '--yes'], 'yes\n', true, false, true],
    [['uninstall', '--restore-npm'], 'yes\n', true, true, false],
    [['uninstall', '--no-restore-npm'], 'yes\n', false, true, false],
  ]) {
    const io = streamPair(answers, true);
    const fake = fakeManager();
    let factoryCalls = 0;
    const code = await runDeployCli(argv, {
      ...io,
      createManager: () => { factoryCalls += 1; return fake.manager; },
    });
    assert.equal(code, 0);
    assert.equal(factoryCalls, 1);
    assert.deepEqual(fake.calls, [['uninstall', { restoreNpm: expectedRestore }]]);
    const text = io.errorText();
    assert.equal(text.includes('Remove the Git deployment, service, releases, and launcher? [y/N]'), firstPrompt);
    assert.equal(text.includes('Restore @karpeleslab/teamclaude as a global npm package? [Y/n]'), secondPrompt);
    assert.equal(text.includes('The teamclaude command will be removed with the Git deployment.'), !expectedRestore);
  }
});

test('interactive uninstall cancellation is a successful no-op', async () => {
  for (const answer of ['no\n', '\n', '']) {
    const io = streamPair(answer, true);
    let factoryCalls = 0;
    const code = await runDeployCli(['uninstall'], {
      ...io, createManager: () => { factoryCalls += 1; return fakeManager().manager; },
    });
    assert.equal(code, 0);
    assert.equal(factoryCalls, 0);
  }
});

test('non-interactive uninstall requires confirmation and an explicit npm decision', async () => {
  for (const argv of [
    ['uninstall'], ['uninstall', '--yes'], ['uninstall', '--restore-npm'],
  ]) {
    const io = streamPair('', false);
    let factoryCalls = 0;
    assert.equal(await runDeployCli(argv, {
      ...io, createManager: () => { factoryCalls += 1; return fakeManager().manager; },
    }), 64);
    assert.equal(factoryCalls, 0);
    const text = io.errorText();
    assert.match(text, /uninstall --yes --restore-npm/);
    assert.match(text, /uninstall --yes --no-restore-npm/);
  }

  for (const [flag, expected] of [['--restore-npm', true], ['--no-restore-npm', false]]) {
    const io = streamPair('', false);
    const fake = fakeManager();
    assert.equal(await runDeployCli(['uninstall', '--yes', flag], { ...io, createManager: () => fake.manager }), 0);
    assert.deepEqual(fake.calls, [['uninstall', { restoreNpm: expected }]]);
  }
});

test('each deploy command dispatches once with parsed options', async () => {
  const cases = [
    [['install', 'https://example/repo.git', '--ref', 'dev'], ['install', { remoteUrl: 'https://example/repo.git', ref: 'dev' }]],
    [['ref', 'v1.2.0'], ['deployRef', { ref: 'v1.2.0' }]],
    [['rollback'], ['rollback']],
    [['restart'], ['restart']],
    [['logs', '--lines', '25', '--no-follow'], ['logs', { lines: 25, follow: false }]],
  ];
  for (const [argv, expected] of cases) {
    const io = streamPair('', true);
    const fake = fakeManager();
    assert.equal(await runDeployCli(argv, { ...io, createManager: () => fake.manager }), 0);
    assert.deepEqual(fake.calls, [expected]);
  }
});

test('status supports clean JSON and readable human output', async () => {
  const status = {
    schemaVersion: 1, platform: 'linux', root: '/opt/teamclaude', remoteUrl: 'https://example/repo.git',
    requestedRef: 'master', current: { commit: 'a'.repeat(40), path: '/release/a' },
    previous: { commit: 'b'.repeat(40), path: '/release/b' },
    service: { running: true, detail: 'active' }, nodePath: '/node', launcherPath: '/usr/local/bin/teamclaude',
    configPath: '/root/.config/teamclaude.json', npmCleanupPending: false, npmRestore: {}, serviceBackup: null,
  };
  for (const json of [true, false]) {
    const io = streamPair('', true);
    const fake = fakeManager({ status: async () => { fake.calls.push(['status']); return status; } });
    assert.equal(await runDeployCli(['status', ...(json ? ['--json'] : [])], { ...io, createManager: () => fake.manager }), 0);
    const text = io.stdoutText();
    if (json) assert.equal(text, `${JSON.stringify(status, null, 2)}\n`);
    else {
      for (const value of ['linux', '/opt/teamclaude', 'https://example/repo.git', 'master', 'a'.repeat(40),
        '/release/a', 'b'.repeat(40), '/release/b', 'active', '/node', '/usr/local/bin/teamclaude',
        '/root/.config/teamclaude.json']) assert.match(text, new RegExp(value.replaceAll('/', '\\/')));
    }
    assert.equal(io.errorText(), '');
  }
});

test('operational and partial failures return one without exiting the process', async () => {
  const thrown = streamPair('', true);
  assert.equal(await runDeployCli(['restart'], {
    ...thrown, createManager: () => fakeManager({ restart: async () => { throw new Error('restart failed'); } }).manager,
  }), 1);
  assert.match(thrown.errorText(), /restart failed/);

  const partial = streamPair('', true);
  assert.equal(await runDeployCli(['install', 'https://example/repo.git'], {
    ...partial,
    createManager: () => fakeManager({ install: async () => ({
      ok: false, partial: true, commit: 'a'.repeat(40), releasePath: '/release', warning: 'npm cleanup pending',
    }) }).manager,
  }), 1);
  assert.match(partial.errorText(), /npm cleanup pending/);
});

test('top-level deploy dispatch exposes help and usage failures', () => {
  const help = spawnSync(process.execPath, [entry, 'deploy', 'help'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /teamclaude deploy install/);
  const unknown = spawnSync(process.execPath, [entry, 'deploy', 'wat'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(unknown.status, 64);
  assert.match(unknown.stderr, /Unknown deploy command/);
});
