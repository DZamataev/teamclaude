import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, isTransientUpstreamError, HOST_SETTLED } from '../src/server.js';
import { setUpstreamProxy, resolveUpstreamProxy, resetUpstreamProxy } from '../src/upstream-proxy.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function sendThrough(port, path = '/v1/messages') {
  return new Promise(resolve => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json' },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ type: 'response', status: response.statusCode, body }));
    });
    request.on('error', error => resolve({ type: 'error', code: error.code }));
    request.end(JSON.stringify({ model: 'claude-x', messages: [] }));
  });
}

function apiKeyAccount(name, upstream) {
  return { name, type: 'apikey', apiKey: `key-${name}`, upstream };
}

function disableAmbientProxy() {
  setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {}));
}

test.afterEach(() => resetUpstreamProxy());

test('a DNS failure on the shared upstream resets the client connection', async () => {
  disableAmbientProxy();
  const accountManager = new AccountManager([
    apiKeyAccount('broken', 'https://does-not-exist.invalid'),
  ], 0.98);
  const proxy = createProxyServer(accountManager, { proxy: {}, upstream: 'https://does-not-exist.invalid' });
  const proxyPort = await listen(proxy);

  try {
    const outcome = await sendThrough(proxyPort);
    assert.equal(outcome.type, 'error',
      `DNS failure should reset the connection, got ${JSON.stringify(outcome)}`);
  } finally {
    proxy.close();
  }
});

test('a DNS failure fails over to an eligible account on another host', async () => {
  disableAmbientProxy();
  const good = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  const goodPort = await listen(good);
  const accountManager = new AccountManager([
    apiKeyAccount('broken', 'https://does-not-exist.invalid'),
    apiKeyAccount('good', `http://127.0.0.1:${goodPort}`),
  ], 0.98);
  const proxy = createProxyServer(accountManager, { proxy: {}, upstream: 'https://does-not-exist.invalid' });
  const proxyPort = await listen(proxy);

  try {
    const outcome = await sendThrough(proxyPort);
    assert.deepEqual(outcome, { type: 'response', status: 200, body: '{"ok":true}' });
  } finally {
    proxy.close();
    good.close();
  }
});

test('a host-scoped failure skips untried sibling accounts on the same host', async () => {
  disableAmbientProxy();
  const good = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  const goodPort = await listen(good);
  const routed = [];
  const accountManager = new AccountManager([
    apiKeyAccount('broken-a', 'https://does-not-exist.invalid'),
    apiKeyAccount('broken-b', 'https://does-not-exist.invalid'),
    apiKeyAccount('good', `http://127.0.0.1:${goodPort}`),
  ], 0.98);
  const proxy = createProxyServer(
    accountManager,
    { proxy: {}, upstream: 'https://does-not-exist.invalid' },
    { onRequestRouted: (_requestId, { account }) => routed.push(account) },
  );
  const proxyPort = await listen(proxy);

  try {
    const outcome = await sendThrough(proxyPort);
    assert.deepEqual(outcome, { type: 'response', status: 200, body: '{"ok":true}' });
    assert.deepEqual(routed, ['broken-a', 'good']);
  } finally {
    proxy.close();
    good.close();
  }
});

test('a pinned account with a DNS failure reports pinned-unavailable instead of resetting', async () => {
  disableAmbientProxy();
  const accountManager = new AccountManager([
    apiKeyAccount('broken', 'https://does-not-exist.invalid'),
  ], 0.98);
  const proxy = createProxyServer(accountManager, { proxy: {}, upstream: 'https://does-not-exist.invalid' });
  const proxyPort = await listen(proxy);

  try {
    const outcome = await sendThrough(proxyPort, '/tc-acct/broken/v1/messages');
    assert.equal(outcome.type, 'response');
    assert.equal(outcome.status, 429);
    assert.match(outcome.body, /pinned account is unavailable/i);
  } finally {
    proxy.close();
  }
});

// Skipping an account is a prediction about an attempt not yet made, so the set
// that triggers it must hold only codes whose answer cannot differ a moment
// later. This is asserted on the set itself: an integration test can reach
// ENOTFOUND through a real resolver, but not EAI_AGAIN, so narrowing the
// condition to ENOTFOUND alone would otherwise leave every other code untested.
test('only settled host failures write off an account, never a retryable one', () => {
  // A resolver saying "temporary failure, try again" is the case that must NOT
  // skip: one timed-out lookup is no evidence the next will fail, and the
  // sibling discarded on that basis might have answered.
  assert.equal(HOST_SETTLED.has('EAI_AGAIN'), false);
  // The local interface being down is not scoped to a hostname at all, so
  // there is no "other host" that skipping could usefully reach.
  assert.equal(HOST_SETTLED.has('ENETDOWN'), false);

  for (const settled of ['ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH']) {
    assert.equal(HOST_SETTLED.has(settled), true, `${settled} is settled`);
  }

  // Every skip code must also be one the classifier already treats as
  // host-scoped, or the two would disagree about what a host failure is.
  for (const code of HOST_SETTLED) {
    assert.equal(
      isTransientUpstreamError(Object.assign(new Error('x'), { code }), { otherHostAvailable: false }),
      true,
      `${code} is host-transient to the classifier`,
    );
  }
});
