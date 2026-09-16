import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

async function writeConfig({ port = 3, apiKey = 'shared-secret', clientKeys = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-client-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    proxy: { port, apiKey, clientKeys },
    upstream: 'https://api.anthropic.com',
    upstreamProxy: false,
    accounts: [],
  }), { mode: 0o644 });
  return path;
}

// A CLI that never exits must fail the test rather than hang it, but the
// deadline has to cover the work the process legitimately does — including
// waiting its turn behind the other updaters in the concurrency test below.
// That queue takes one config write per process, and on a small single-core
// host each turn is slow enough that a ten-second cap killed processes that
// were working correctly.
const CLI_TIMEOUT_MS = 120_000;

function runCli(configPath, cliArgs) {
  const child = spawn(process.execPath, [cliPath, ...cliArgs], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI did not exit')); }, CLI_TIMEOUT_MS);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function readProxy(configPath) {
  return JSON.parse(await readFile(configPath, 'utf8')).proxy;
}

test('client add generates, stores, and prints a new 256-bit key', async () => {
  const configPath = await writeConfig();
  const res = await runCli(configPath, ['client', 'add', 'mbp']);

  assert.equal(res.code, 0, res.stderr);
  const printed = /Key: (tc-[A-Za-z0-9_-]{43})\b/.exec(res.stdout)?.[1];
  assert.ok(printed, `generated key not printed:\n${res.stdout}`);
  const proxy = await readProxy(configPath);
  assert.deepEqual(proxy.clientKeys, [{ name: 'mbp', key: printed }]);
  assert.equal(proxy.apiKey, 'shared-secret');
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
});

test('client add refuses a duplicate normalized name without rewriting the config', async () => {
  const configPath = await writeConfig({ clientKeys: [{ name: 'mbp', key: 'existing-client-secret' }] });
  const before = await readFile(configPath, 'utf8');
  const res = await runCli(configPath, ['client', 'add', ' mbp ']);

  assert.equal(res.code, 1);
  assert.match(res.stderr, /already exists/i);
  assert.doesNotMatch(res.stdout + res.stderr, /existing-client-secret/);
  assert.equal(await readFile(configPath, 'utf8'), before);
});

test('client add rejects empty and control-character names without touching the config', async () => {
  const configPath = await writeConfig();
  const before = await readFile(configPath, 'utf8');
  for (const name of ['   ', 'bad\nname']) {
    const res = await runCli(configPath, ['client', 'add', name]);
    assert.equal(res.code, 1, `${JSON.stringify(name)}: ${res.stderr}`);
    assert.match(res.stderr, /valid client name/i);
  }
  assert.equal(await readFile(configPath, 'utf8'), before);
});

test('client list masks keys by default and reveals them only with --show-keys', async () => {
  const secret = 'tc-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
  const configPath = await writeConfig({ clientKeys: [
    { name: 'shared_api_key', key: 'shared-secret' },
    { name: 'mbp', key: secret },
  ] });

  const masked = await runCli(configPath, ['client', 'list']);
  assert.equal(masked.code, 0, masked.stderr);
  assert.match(masked.stdout, /shared_api_key/);
  assert.match(masked.stdout, /shared apiKey/);
  assert.match(masked.stdout, /mbp/);
  assert.doesNotMatch(masked.stdout, new RegExp(secret));

  const shown = await runCli(configPath, ['client', 'list', '--show-keys']);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, new RegExp(secret));
  assert.match(shown.stdout, /shared-secret/);
});

test('client list never reveals a short key through its default mask', async () => {
  const configPath = await writeConfig({ clientKeys: [{ name: 'legacy', key: 'abcdefghi' }] });
  const res = await runCli(configPath, ['client', 'list']);

  assert.equal(res.code, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /abcdefghi/);
  assert.match(res.stdout, /legacy/);
});

test('client list safely shows and remove revokes a legacy control-character name', async () => {
  const name = 'legacy\nname';
  const configPath = await writeConfig({ clientKeys: [{ name, key: 'legacy-secret' }] });

  const listed = await runCli(configPath, ['client', 'list']);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /legacy name/);
  assert.doesNotMatch(listed.stdout, /legacy\nname/);

  const removed = await runCli(configPath, ['client', 'remove', name]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.deepEqual((await readProxy(configPath)).clientKeys, []);
  assert.doesNotMatch(removed.stdout + removed.stderr, /legacy\nname/);
});

test('client remove revokes every key for the exact normalized name', async () => {
  const configPath = await writeConfig({ clientKeys: [
    { name: 'mbp', key: 'mbp-1' },
    { name: 'other', key: 'other-key' },
    { name: ' mbp ', key: 'mbp-2' },
  ] });
  const res = await runCli(configPath, ['client', 'remove', 'mbp']);

  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Removed 2 keys? for client "mbp"/);
  assert.deepEqual((await readProxy(configPath)).clientKeys, [{ name: 'other', key: 'other-key' }]);
});

test('client remove refuses a key that is still accepted as proxy.apiKey', async () => {
  const configPath = await writeConfig({ clientKeys: [
    { name: 'shared_api_key', key: 'shared-secret' },
    { name: 'mbp', key: 'mbp-key' },
  ] });
  const before = await readFile(configPath, 'utf8');
  const res = await runCli(configPath, ['client', 'remove', 'shared_api_key']);

  assert.equal(res.code, 1);
  assert.match(res.stderr, /proxy\.apiKey/);
  assert.match(res.stderr, /would remain valid/i);
  assert.equal(await readFile(configPath, 'utf8'), before);
});

// The same lie one step further out: two clients issued the same key (a copied
// credential, or two machines an operator set up alike). Removing one leaves
// the key working under the other name, so "Removed 1 key" would tell an
// operator a credential is withdrawn while it still authenticates.
test('client remove refuses a key another client still holds', async () => {
  const configPath = await writeConfig({ clientKeys: [
    { name: 'laptop', key: 'shared-between-two' },
    { name: 'desktop', key: 'shared-between-two' },
    { name: 'other', key: 'its-own-key' },
  ] });
  const before = await readFile(configPath, 'utf8');
  const res = await runCli(configPath, ['client', 'remove', 'laptop']);

  assert.equal(res.code, 1);
  assert.match(res.stderr, /shares its key with "desktop"/);
  assert.match(res.stderr, /would remain valid/i);
  assert.equal(await readFile(configPath, 'utf8'), before, 'the config is untouched');
});

// The ordinary case must keep working: a client with its own key is removed
// even while other clients exist.
test('client remove still revokes a key no one else holds', async () => {
  const configPath = await writeConfig({ clientKeys: [
    { name: 'laptop', key: 'laptop-only' },
    { name: 'desktop', key: 'desktop-only' },
  ] });
  const res = await runCli(configPath, ['client', 'remove', 'laptop']);

  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual((await readProxy(configPath)).clientKeys, [{ name: 'desktop', key: 'desktop-only' }]);
});

test('client add reloads a running server with the shared proxy key', async t => {
  let seen = null;
  const server = http.createServer((req, res) => {
    seen = { method: req.method, url: req.url, key: req.headers['x-api-key'] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const configPath = await writeConfig({ port: server.address().port });

  const res = await runCli(configPath, ['client', 'add', 'mob']);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(seen, { method: 'POST', url: '/teamclaude/reload', key: 'shared-secret' });
  assert.match(res.stdout, /Reloaded running server/);
});

test('client add authenticates reload with an existing client key when there is no shared key', async t => {
  let seenKey = null;
  const server = http.createServer((req, res) => {
    seenKey = req.headers['x-api-key'];
    if (seenKey !== 'existing-key') {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const configPath = await writeConfig({
    port: server.address().port,
    apiKey: null,
    clientKeys: [{ name: 'existing', key: 'existing-key' }],
  });

  const res = await runCli(configPath, ['client', 'add', 'new-client']);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(seenKey, 'existing-key');
});

test('client mutation reports a running server reload failure', async t => {
  const server = http.createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'reload rejected' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const configPath = await writeConfig({ port: server.address().port });

  const res = await runCli(configPath, ['client', 'add', 'mob']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /reload rejected|HTTP 500/i);
  assert.match(res.stderr, /saved/i);
});

test('concurrent client adds preserve every successful mutation', async () => {
  const configPath = await writeConfig();
  // Enough writers to contend for the lock several times over, few enough to
  // fit on the machine under test. Each one is a whole Node process (~70MB),
  // so twelve at once plus the test runner exceeds a 1GB host with no swap:
  // they then crawl against each other and the harness kills them at its
  // deadline, which reads as "the CLI hung" rather than "the box ran out".
  // Four still proves the property — a queue that must be waited out — and
  // leaves the same evidence in a fraction of the footprint.
  const names = Array.from({ length: 4 }, (_, i) => `client-${i}`);
  const results = await Promise.all(names.map(name => runCli(configPath, ['client', 'add', name])));

  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const entries = (await readProxy(configPath)).clientKeys;
  assert.deepEqual(new Set(entries.map(entry => entry.name)), new Set(names));
});

test('client command rejects unknown forms with usage', async () => {
  const configPath = await writeConfig();
  for (const argv of [
    ['client'],
    ['client', 'bogus'],
    ['client', 'list', '--bogus'],
    ['client', 'remove'],
  ]) {
    const res = await runCli(configPath, argv);
    assert.equal(res.code, 1, `${argv.join(' ')}: ${res.stderr}`);
    assert.match(res.stderr, /Usage: teamclaude client/);
  }
});

test('top-level help documents client key management', async () => {
  const configPath = await writeConfig();
  const res = await runCli(configPath, ['help']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /client <sub>\s+Manage per-client proxy keys: add \| list \| remove/);
});

// A config that lists clients whose entries are unusable — an empty key, a
// blank name — is not the same as a config that lists none. The server ignores
// both, but an operator reading "No client keys configured" over a file that
// visibly names clients goes looking in the wrong place.
test('client list distinguishes no entries from no USABLE entries', async () => {
  const empty = await writeConfig({ clientKeys: [] });
  const emptyRes = await runCli(empty, ['client', 'list']);
  assert.equal(emptyRes.code, 0, emptyRes.stderr);
  assert.match(emptyRes.stdout, /No client keys configured\./);

  const malformed = await writeConfig({ clientKeys: [
    { name: 'alice', key: '' },
    { name: '   ', key: 'orphaned-key' },
  ] });
  const malformedRes = await runCli(malformed, ['client', 'list']);
  assert.equal(malformedRes.code, 0, malformedRes.stderr);
  assert.match(malformedRes.stdout, /No usable client keys configured \(2 malformed entries ignored\)\./);
});

// A listener that accepts the TCP connection and then never answers — a wedged
// server, or a stale port some other process now holds. Without a deadline on
// the reload the credential command hangs forever, with the key already on
// disk and the operator unable to tell whether the running server has it.
test('a mutation does not hang when the reload endpoint never answers', async () => {
  const silent = net.createServer(socket => { socket.resume(); /* never reply */ });
  await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve));
  const port = silent.address().port;

  try {
    const configPath = await writeConfig({ port });
    const started = Date.now();
    const res = await runCli(configPath, ['client', 'add', 'wedged']);
    const took = Date.now() - started;

    assert.equal(res.code, 1, 'a reload that never answers fails the command');
    assert.ok(took < 30_000, `gave up rather than hanging (took ${took}ms)`);
  } finally {
    await new Promise(resolve => silent.close(resolve));
  }
});
