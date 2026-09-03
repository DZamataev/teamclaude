import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { ReadableStream } from 'node:stream/web';
import { TextEncoder } from 'node:util';
import * as dashboard from '../src/watch-dashboard.js';
import { resetUpstreamProxy, setUpstreamProxy } from '../src/upstream-proxy.js';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

test('watch is a terminal command and explains when no terminal is attached', () => {
  const result = spawnSync(process.execPath, [cliPath, 'watch'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /teamclaude watch needs a terminal/i);
  assert.doesNotMatch(result.stderr, /unknown command/i);
});

test('top-level help presents watch as the read-only terminal dashboard', () => {
  const result = spawnSync(process.execPath, [cliPath, 'help'], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /watch\s+Open the read-only terminal dashboard/);
});

test('Anthropic status summarizes operational, incident, and unavailable states', () => {
  const operational = dashboard.formatAnthropicStatus?.({
    status: { indicator: 'none', description: 'All Systems Operational' },
    incidents: [],
  });
  const incident = dashboard.formatAnthropicStatus?.({
    status: { indicator: 'minor', description: 'Minor Service Outage' },
    incidents: [{ name: 'Elevated errors for multiple models', status: 'identified' }],
  });

  assert.equal(operational, 'Anthropic: OPERATIONAL');
  assert.equal(incident, 'Anthropic: MINOR — Elevated errors for multiple models (identified)');
  assert.equal(dashboard.formatAnthropicStatus?.(null), 'Anthropic: UNKNOWN');
});

test('external status text cannot inject terminal control characters', () => {
  const line = dashboard.formatAnthropicStatus?.({
    status: { indicator: 'minor\x1b[2J' },
    incidents: [{ name: `bad\n\x1b[31mred\u202e${'x'.repeat(500)}`, status: 'identified\r' }],
  });

  assert.doesNotMatch(line || '', /\p{C}/u);
  assert.ok((line || '').length <= 240, 'external status line must be bounded');
});

test('control host follows the configured bind and maps wildcards to loopback', () => {
  assert.equal(dashboard.resolveControlHost?.({ proxy: { host: '192.0.2.4' } }, {}), '192.0.2.4');
  assert.equal(dashboard.resolveControlHost?.({ proxy: { host: '0.0.0.0' } }, {}), '127.0.0.1');
  assert.equal(dashboard.resolveControlHost?.({ proxy: { host: '::' } }, {}), '127.0.0.1');
  assert.equal(
    dashboard.resolveControlHost?.({ proxy: { host: '192.0.2.4' } }, { TEAMCLAUDE_HOST: '198.51.100.8' }),
    '198.51.100.8',
  );
});

test('Anthropic status uses the configured upstream proxy', async t => {
  let connectTarget = null;
  const proxy = http.createServer();
  proxy.on('connect', (req, socket) => {
    connectTarget = req.url;
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    resetUpstreamProxy();
    proxy.close();
  });
  setUpstreamProxy({
    proxy: { host: '127.0.0.1', port: proxy.address().port, username: null, password: null },
    source: 'test',
    noProxy: null,
  });

  assert.equal(await dashboard.readAnthropicStatus({ timeoutMs: 200 }), 'Anthropic: UNKNOWN');
  assert.equal(connectTarget, 'status.claude.com:443');
});

test('aborting Anthropic status cancels its active request', async () => {
  const controller = new AbortController();
  let requestSignal = null;
  const read = dashboard.readAnthropicStatus({
    timeoutMs: 1000,
    signal: controller.signal,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      requestSignal = signal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  controller.abort(new Error('stop dashboard'));

  const outcome = await Promise.race([
    read,
    new Promise(resolve => setTimeout(() => resolve('still pending'), 50)),
  ]);
  assert.equal(outcome, 'Anthropic: UNKNOWN');
  assert.equal(requestSignal?.aborted, true);
});

test('Anthropic timeout cancels a response body that stalls after headers', async () => {
  let bodyCancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"status":'));
    },
    cancel() {
      bodyCancelled = true;
    },
  });
  const read = dashboard.readAnthropicStatus({
    timeoutMs: 20,
    fetchImpl: async () => ({ ok: true, body, json: () => new Promise(() => {}) }),
  });

  const outcome = await Promise.race([
    read,
    new Promise(resolve => setTimeout(() => resolve('still pending'), 100)),
  ]);
  assert.equal(outcome, 'Anthropic: UNKNOWN');
  assert.equal(bodyCancelled, true);
});

test('an unsuccessful Anthropic response is discarded without retaining its socket', async () => {
  let bodyCancelled = false;
  const body = new ReadableStream({ cancel() { bodyCancelled = true; } });

  const outcome = await dashboard.readAnthropicStatus({
    fetchImpl: async () => ({ ok: false, body }),
  });

  assert.equal(outcome, 'Anthropic: UNKNOWN');
  assert.equal(bodyCancelled, true);
});

test('the dashboard frame includes Anthropic health and colored TeamClaude quota bars', () => {
  const now = Date.parse('2026-09-03T13:00:00Z');
  const frame = dashboard.renderWatchFrame?.({
    now,
    anthropicStatus: 'Anthropic: OPERATIONAL',
    teamClaudeStatus: {
      currentAccount: 'a',
      switchThreshold: 0.95,
      probe: { enabled: false, intervalSeconds: 0, accounts: [] },
      accounts: [{
        name: 'a',
        type: 'oauth',
        status: 'active',
        quota: { unified5h: 0.5, unified5hReset: now + 60_000 },
        usage: {},
      }],
    },
  });

  assert.match(frame || '', /^TeamClaude dashboard — /);
  assert.match(frame || '', /Anthropic: OPERATIONAL/);
  assert.match(frame || '', /\x1b\[38;2;\d+;\d+;\d+m█/);
});

test('the dashboard repaints complete frames in place and restores the cursor', async () => {
  const controller = new AbortController();
  const writes = [];
  const stdout = {
    isTTY: true,
    write(chunk) { writes.push(String(chunk)); return true; },
  };
  const teamClaudeStatus = {
    currentAccount: 'a',
    switchThreshold: 0.95,
    probe: { enabled: false, intervalSeconds: 0, accounts: [] },
    accounts: [],
  };
  const anthropicStatuses = [
    'Anthropic: OPERATIONAL',
    'Anthropic: MINOR — Elevated errors (identified)',
  ];
  let reads = 0;
  let waits = 0;

  const code = await dashboard.runWatchDashboard({
    stdout,
    stderr: { write() { return true; } },
    signal: controller.signal,
    readTeamClaude: async () => teamClaudeStatus,
    readAnthropic: async () => anthropicStatuses[reads++],
    wait: async () => {
      waits++;
      if (waits === 2) controller.abort();
    },
    now: () => Date.parse('2026-09-03T13:00:00Z'),
  });

  const output = writes.join('');
  assert.equal(code, 0);
  assert.equal((output.match(/\x1b\[H/g) || []).length, 2);
  assert.equal((output.match(/\x1b\[2J/g) || []).length, 1);
  assert.match(output, /Anthropic: OPERATIONAL/);
  assert.match(output, /Anthropic: MINOR — Elevated errors \(identified\)/);
  assert.ok(output.endsWith('\x1b[?25h\n'), 'cursor must be visible after exit');
});

test('the first frame replaces the screen only after both reads finish', async () => {
  const controller = new AbortController();
  const writes = [];
  let finishTeamClaude;
  let finishAnthropic;
  const teamClaude = new Promise(resolve => { finishTeamClaude = resolve; });
  const anthropic = new Promise(resolve => { finishAnthropic = resolve; });
  const running = dashboard.runWatchDashboard({
    stdout: { isTTY: true, write(chunk) { writes.push(String(chunk)); return true; } },
    stderr: { write() { return true; } },
    signal: controller.signal,
    readTeamClaude: async () => teamClaude,
    readAnthropic: async () => anthropic,
    wait: async () => controller.abort(),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, [], 'the existing terminal must remain visible during the first fetch');

  finishTeamClaude({ currentAccount: 'a', switchThreshold: 0.95, accounts: [] });
  finishAnthropic('Anthropic: OPERATIONAL');
  assert.equal(await running, 0);
  assert.equal((writes.join('').match(/\x1b\[2J/g) || []).length, 1);
});

test('refresh timing subtracts fetch time instead of accumulating drift', async () => {
  const controller = new AbortController();
  const clock = [1000, 6000, 6000];
  let requestedDelay = null;
  await dashboard.runWatchDashboard({
    stdout: { isTTY: true, write() { return true; } },
    stderr: { write() { return true; } },
    signal: controller.signal,
    readTeamClaude: async () => ({ currentAccount: 'a', switchThreshold: 0.95, accounts: [] }),
    readAnthropic: async () => 'Anthropic: OPERATIONAL',
    now: () => clock.shift() ?? 6000,
    wait: async delay => { requestedDelay = delay; controller.abort(); },
  });

  assert.equal(requestedDelay, 55_000);
});

test('SIGINT propagates to active readers in a real child process', async () => {
  const moduleUrl = new URL('../src/watch-dashboard.js', import.meta.url).href;
  const source = `
    import { runWatchDashboard } from ${JSON.stringify(moduleUrl)};
    const hold = setInterval(() => {}, 1000);
    const pending = ({ signal }) => new Promise((_resolve, reject) => {
      process.stderr.write('reader-ready\\n');
      signal.addEventListener('abort', () => {
        process.stderr.write('reader-aborted\\n');
        reject(signal.reason);
      }, { once: true });
    });
    const stdout = { isTTY: true, write: chunk => process.stdout.write(chunk) };
    const code = await runWatchDashboard({ stdout, readTeamClaude: pending, readAnthropic: pending });
    clearInterval(hold);
    process.exit(code);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child readers did not start: ${stderr}`)), 1000);
    const ready = () => {
      if ((stderr.match(/reader-ready/g) || []).length !== 2) return;
      clearTimeout(timer);
      child.stderr.off('data', ready);
      resolve();
    };
    child.stderr.on('data', ready);
  });
  child.kill('SIGINT');
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, 500);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', value => { clearTimeout(timer); resolve(value); });
  });

  assert.equal(code, 0, stderr);
  assert.equal((stderr.match(/reader-aborted/g) || []).length, 2, stderr);
  assert.doesNotMatch(stdout, /\x1b\[\?25l/, 'the cursor is untouched before the first frame');
});
