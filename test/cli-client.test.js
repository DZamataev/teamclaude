import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

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
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI did not exit')); }, 10_000);
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
  const names = Array.from({ length: 12 }, (_, i) => `client-${i}`);
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
