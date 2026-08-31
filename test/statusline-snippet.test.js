import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const snippet = fileURLToPath(new URL('../examples/claude-code-statusline.sh', import.meta.url));

function runSnippet(env) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [snippet], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end('{}');
  });
}

async function quotaServer(payload) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function fleetQuota({ fiveHour, weekly, fable, fiveHourReset = null, weeklyReset = null }) {
  return {
    accounts: [],
    aggregate: {
      fiveHour: { remaining: fiveHour, nextResetAt: fiveHourReset },
      weeklyShared: { remaining: weekly, nextResetAt: weeklyReset },
      weeklySonnet: { remaining: weekly, nextResetAt: weeklyReset },
      weeklyFable: { remaining: fable, nextResetAt: weeklyReset },
    },
    unknownTiers: [],
  };
}

test('statusline snippet renders five-hour and weekly reset countdowns', async t => {
  const now = Date.now();
  const endpoint = await quotaServer(fleetQuota({
    fiveHour: 0.02,
    weekly: 0.86,
    fable: 0.75,
    fiveHourReset: now + 90 * 60 * 1000,
    weeklyReset: now + 51 * 60 * 60 * 1000,
  }));
  const temp = await mkdtemp(path.join(os.tmpdir(), 'teamclaude-statusline-'));
  t.after(async () => {
    await endpoint.close();
    await rm(temp, { recursive: true, force: true });
  });

  const result = await runSnippet({
    TEAMCLAUDE_BASE_URL: endpoint.url,
    TEAMCLAUDE_API_KEY: 'test-key',
    TEAMCLAUDE_QUOTA_CACHE: path.join(temp, 'quota.json'),
    NO_COLOR: '1',
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'Σ 5h 2% ↻1h30m  7d 86% ↻2d3h  F7 75% left');
});

test('statusline snippet colors remaining capacity by risk', async t => {
  const endpoint = await quotaServer(fleetQuota({ fiveHour: 0.02, weekly: 0.20, fable: 0.75 }));
  const temp = await mkdtemp(path.join(os.tmpdir(), 'teamclaude-statusline-'));
  t.after(async () => {
    await endpoint.close();
    await rm(temp, { recursive: true, force: true });
  });

  const result = await runSnippet({
    TEAMCLAUDE_BASE_URL: endpoint.url,
    TEAMCLAUDE_API_KEY: 'test-key',
    TEAMCLAUDE_QUOTA_CACHE: path.join(temp, 'quota.json'),
    NO_COLOR: '',
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\x1b\[36mΣ\x1b\[0m/);
  assert.match(result.stdout, /\x1b\[31m2%\x1b\[0m/);
  assert.match(result.stdout, /\x1b\[33m20%\x1b\[0m/);
  assert.match(result.stdout, /\x1b\[32m75%\x1b\[0m/);
});
