import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function oauth() {
  return {
    name: 'primary',
    type: 'oauth',
    accessToken: 'upstream-oauth-token',
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 3600_000,
  };
}

async function withRemoteProxy(run) {
  let upstreamAuthorization;
  let upstreamRequests = 0;
  const upstream = http.createServer((req, res) => {
    upstreamRequests += 1;
    upstreamAuthorization = req.headers.authorization;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);

  const proxy = createProxyServer(new AccountManager([oauth()], 0.98), {
    proxy: { apiKey: 'sk-ant-oat-proxy-key' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  proxy.on('connection', socket => {
    Object.defineProperty(socket, 'remoteAddress', { value: '203.0.113.9' });
  });
  const proxyPort = await listen(proxy);

  try {
    await run({
      request: headers => fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
      }),
      upstream: () => ({ authorization: upstreamAuthorization, requests: upstreamRequests }),
    });
  } finally {
    proxy.close();
    upstream.close();
  }
}

test('a remote base-URL client may present the proxy API key as Bearer auth', async () => {
  await withRemoteProxy(async ({ request, upstream }) => {
    const response = await request({ authorization: 'Bearer sk-ant-oat-proxy-key' });
    await response.text();

    assert.equal(response.status, 200);
    assert.deepEqual(upstream(), { authorization: 'Bearer upstream-oauth-token', requests: 1 });
  });
});

test('a remote base-URL client may still present the proxy API key as x-api-key', async () => {
  await withRemoteProxy(async ({ request, upstream }) => {
    const response = await request({ 'x-api-key': 'sk-ant-oat-proxy-key' });
    await response.text();

    assert.equal(response.status, 200);
    assert.deepEqual(upstream(), { authorization: 'Bearer upstream-oauth-token', requests: 1 });
  });
});

test('a remote base-URL client with the wrong Bearer key is rejected before upstream', async () => {
  await withRemoteProxy(async ({ request, upstream }) => {
    const response = await request({ authorization: 'Bearer wrong-key' });
    await response.text();

    assert.equal(response.status, 401);
    assert.deepEqual(upstream(), { authorization: undefined, requests: 0 });
  });
});

async function upgradeThroughRemoteProxy(headers) {
  let upstreamAuthorization;
  let upstreamRequests = 0;
  const upstream = http.createServer();
  upstream.on('upgrade', (req, socket) => {
    upstreamRequests += 1;
    upstreamAuthorization = req.headers.authorization;
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.end();
  });
  const upstreamPort = await listen(upstream);

  const proxy = createProxyServer(new AccountManager([oauth()], 0.98), {
    proxy: { apiKey: 'sk-ant-oat-proxy-key' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  proxy.on('connection', socket => {
    Object.defineProperty(socket, 'remoteAddress', { value: '203.0.113.9' });
  });
  const proxyPort = await listen(proxy);
  const client = net.connect(proxyPort, '127.0.0.1');

  try {
    await once(client, 'connect');
    client.write(
      'GET /v1/session_ingress/ws/test HTTP/1.1\r\n' +
      'Host: 127.0.0.1\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join('') +
      '\r\n',
    );
    const [response] = await once(client, 'data');
    return {
      response: response.toString(),
      upstream: { authorization: upstreamAuthorization, requests: upstreamRequests },
    };
  } finally {
    client.destroy();
    proxy.close();
    upstream.close();
    upstream.closeAllConnections();
  }
}

test('a remote Upgrade without a proxy key is rejected before upstream', async () => {
  const result = await upgradeThroughRemoteProxy({});

  assert.match(result.response, /401 Unauthorized/);
  assert.deepEqual(result.upstream, { authorization: undefined, requests: 0 });
});

test('a remote Upgrade consumes a matching Bearer proxy key', async () => {
  const result = await upgradeThroughRemoteProxy({ authorization: 'Bearer sk-ant-oat-proxy-key' });

  assert.match(result.response, /101 Switching Protocols/);
  assert.deepEqual(result.upstream, { authorization: undefined, requests: 1 });
});

test('a remote Upgrade authenticated by x-api-key preserves client Authorization', async () => {
  const result = await upgradeThroughRemoteProxy({
    'x-api-key': 'sk-ant-oat-proxy-key',
    authorization: 'Bearer client-own-token',
  });

  assert.match(result.response, /101 Switching Protocols/);
  assert.deepEqual(result.upstream, { authorization: 'Bearer client-own-token', requests: 1 });
});
