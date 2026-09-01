import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../src/server.js';

const withCode = code => Object.assign(new Error(code), { code });

function classify(error, options) {
  assert.equal(typeof server.isTransientUpstreamError, 'function',
    'server must expose the upstream error classifier used by failover');
  return server.isTransientUpstreamError(error, options);
}

test('socket failures remain transient even when another host is available', () => {
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
    'TEAMCLAUDE_HEADERS_TIMEOUT', 'TEAMCLAUDE_BODY_TIMEOUT']) {
    assert.equal(classify(withCode(code)), true, code);
    assert.equal(classify(withCode(code), { otherHostAvailable: true }), true, code);
  }
});

test('host failures are transient only when no other host is available', () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN']) {
    assert.equal(classify(withCode(code)), true, code);
    assert.equal(classify(withCode(code), { otherHostAvailable: true }), false, code);
  }
});

test('wrapped and aggregate host error codes keep their host-scoped behavior', () => {
  const child = withCode('ENOTFOUND');
  const wrapped = Object.assign(new TypeError('fetch failed'), { cause: child });
  assert.equal(classify(wrapped), true);
  assert.equal(classify(wrapped, { otherHostAvailable: true }), false);

  const aggregate = new AggregateError([child]);
  assert.equal(classify(aggregate), true);
  assert.equal(classify(aggregate, { otherHostAvailable: true }), false);

  const nested = Object.assign(new Error('boom'), { cause: aggregate });
  assert.equal(classify(nested), true);
});

test('deep mixed error trees are traversed once even when they contain cycles', () => {
  const root = new Error('root');
  const aggregate = new AggregateError([], 'aggregate');
  const deepWrapper = Object.assign(new Error('wrapper'), { cause: withCode('ENOTFOUND') });
  root.cause = aggregate;
  aggregate.errors = [root, deepWrapper];

  assert.equal(classify(root), true);
  assert.equal(classify(root, { otherHostAvailable: true }), false);
});

test('timeout names and an unclassified fetch failure remain transient', () => {
  assert.equal(classify(Object.assign(new Error('x'), { name: 'TimeoutError' })), true);
  assert.equal(classify(Object.assign(new Error('x'), { name: 'AbortError' })), true);
  assert.equal(classify(new TypeError('fetch failed')), true);
});

test('unknown errors and non-Error values do not trigger transient handling', () => {
  assert.equal(classify(withCode('EACCES')), false);
  assert.equal(classify(new Error('unknown')), false);
  assert.equal(classify({ code: 'ENOTFOUND' }), false);
  assert.equal(classify(undefined), false);
});
