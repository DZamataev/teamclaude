import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyServer } from '../src/server.js';
import { oauthUsage } from '../src/oauth-usage.js';

// Claude Code reads subscription usage from `GET {ANTHROPIC_BASE_URL}/api/oauth/usage`,
// so the proxy has to answer it from its own quota model. These pin the two
// unit changes (fraction → percent, epoch ms → ISO), the buckets that must stay
// absent, and that the route wins over the forwarder for every query spelling.

// Taken from the live fleet aggregate.
const RESET = 1793667600493;
const SUMMARY = {
  aggregate: {
    fiveHour: null,
    weeklyShared: { capacityWeight: 20, utilization: 1, remaining: 0, nextResetAt: RESET },
    weeklySonnet: { capacityWeight: 20, utilization: 1, remaining: 0, nextResetAt: RESET },
    weeklyFable: { capacityWeight: 20, utilization: 0.02, remaining: 0.98, nextResetAt: RESET },
  },
};

test('the aggregate becomes percent used and ISO reset times', () => {
  const out = oauthUsage({
    aggregate: {
      fiveHour: { utilization: 0.26, nextResetAt: Date.UTC(2026, 10, 2, 17, 20) },
      weeklyShared: { utilization: 1, nextResetAt: RESET },
      weeklySonnet: { utilization: 0.523, nextResetAt: RESET },
      weeklyFable: { utilization: 0.02, nextResetAt: RESET },
    },
  });
  assert.deepEqual(out, {
    five_hour: { utilization: 26, resets_at: '2026-11-02T17:20:00.000Z' },
    seven_day: { utilization: 100, resets_at: '2026-11-03T01:00:00.493Z' },
    seven_day_sonnet: { utilization: 52.3, resets_at: '2026-11-03T01:00:00.493Z' },
  });
  // Only the three windows the CLI reads. weeklyFable has no field it parses.
  assert.deepEqual(Object.keys(out), ['five_hour', 'seven_day', 'seven_day_sonnet']);
});

test('an unknown window is omitted, never stated as 0%', () => {
  const out = oauthUsage(SUMMARY);
  assert.equal('five_hour' in out, false, 'a null fiveHour must not become 0%');
  assert.deepEqual(out, {
    seven_day: { utilization: 100, resets_at: '2026-11-03T01:00:00.493Z' },
    seven_day_sonnet: { utilization: 100, resets_at: '2026-11-03T01:00:00.493Z' },
  });
  // A bucket with no reset still reports what is used; no timestamp is invented.
  assert.deepEqual(oauthUsage({ aggregate: { weeklyShared: { utilization: 0.5, nextResetAt: null } } }), {
    seven_day: { utilization: 50 },
  });
  assert.deepEqual(oauthUsage({}), {});
  assert.deepEqual(oauthUsage(undefined), {});
});

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function upstreamStub() {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    req.resume();
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'x-api-key header is required' } }));
  });
  return { server, hits: () => hits };
}

test('the route answers locally for every query spelling and never forwards', async () => {
  const upstream = upstreamStub();
  const upstreamPort = await listen(upstream.server);
  const am = { getQuotaSummary: () => SUMMARY };
  const proxy = createProxyServer(am, { proxy: { apiKey: 'secret' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  const origin = `http://127.0.0.1:${port}`;
  try {
    const expected = oauthUsage(SUMMARY);
    for (const qs of ['', '?cedar_ember=1', '?at_wall=1&skip_spend=1', '?at_wall=1&cedar_ember=1&skip_spend=1']) {
      const res = await fetch(`${origin}/api/oauth/usage${qs}`, { headers: { 'x-api-key': 'secret' } });
      assert.equal(res.status, 200, qs);
      assert.equal(res.headers.get('content-type'), 'application/json', qs);
      assert.deepEqual(await res.json(), expected, qs);
    }
    assert.equal(upstream.hits(), 0, 'the usage route must not reach upstream');
  } finally {
    proxy.close();
    upstream.server.close();
  }
});

test('the usage route sits behind the same key gate as /teamclaude/quota', async () => {
  const am = { getQuotaSummary: () => SUMMARY };
  const proxy = createProxyServer(am, { proxy: { apiKey: 'secret' }, upstream: 'http://127.0.0.1:9' });
  const port = await listen(proxy);
  const origin = `http://127.0.0.1:${port}`;
  try {
    // A forwarded loopback request loses the exemption, so the key is the only
    // way in — the same answer the control routes give.
    for (const path of ['/api/oauth/usage?cedar_ember=1', '/teamclaude/quota']) {
      const res = await fetch(`${origin}${path}`, { headers: { 'x-forwarded-for': '203.0.113.7' } });
      assert.equal(res.status, 401, path);
      assert.deepEqual(await res.json(), {
        type: 'error',
        error: { type: 'authentication_error', message: 'Invalid proxy API key' },
      }, path);
    }
  } finally {
    proxy.close();
  }
});
