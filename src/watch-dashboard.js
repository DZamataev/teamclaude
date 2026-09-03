import { loadOrCreateConfig } from './config.js';
import { renderStatus } from './status-renderer.js';
import { RemoteControl } from './tui-remote.js';
import { proxyFetch } from './upstream-fetch.js';
import { timeoutSignal } from './abort.js';

const ANTHROPIC_STATUS_URL = 'https://status.claude.com/api/v2/summary.json';
const REFRESH_MS = 60_000;
const timestampFormat = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

/** Reduce the public Anthropic status summary to one terminal line. */
export function formatAnthropicStatus(summary) {
  const indicator = typeof summary?.status?.indicator === 'string'
    ? cleanLine(summary.status.indicator, 32)
    : '';
  if (!indicator) return 'Anthropic: UNKNOWN';
  if (indicator === 'none') return 'Anthropic: OPERATIONAL';

  const label = indicator.toUpperCase();
  const incident = Array.isArray(summary.incidents) ? summary.incidents[0] : null;
  const incidentName = typeof incident?.name === 'string' ? cleanLine(incident.name) : '';
  if (incidentName) {
    const incidentStatus = typeof incident.status === 'string' ? cleanLine(incident.status, 48) : '';
    const status = incidentStatus
      ? ` (${incidentStatus})`
      : '';
    return cleanLine(`Anthropic: ${label} — ${incidentName}${status}`);
  }
  const description = typeof summary?.status?.description === 'string'
    ? cleanLine(summary.status.description)
    : '';
  return description
    ? cleanLine(`Anthropic: ${label} — ${description}`)
    : `Anthropic: ${label}`;
}

/** Resolve the local control address from the same bind settings as attach. */
export function resolveControlHost(config, env = process.env) {
  const bound = env.TEAMCLAUDE_HOST || config.proxy.host || '127.0.0.1';
  return bound === '0.0.0.0' || bound === '::' ? '127.0.0.1' : bound;
}

/** Build one complete dashboard repaint with color forced on. */
export function renderWatchFrame({ teamClaudeStatus, teamClaudeError, anthropicStatus, now = Date.now() }) {
  const timestamp = timestampFormat.format(new Date(now));
  const status = teamClaudeStatus
    ? renderStatus(teamClaudeStatus, { color: true, now })
    : `TeamClaude: UNAVAILABLE${teamClaudeError ? ` — ${cleanLine(teamClaudeError)}` : ''}`;
  return `TeamClaude dashboard — ${timestamp}\n\n${anthropicStatus}\n\n${status}`;
}

/** Read and reduce the public Anthropic status page without failing the dashboard. */
export async function readAnthropicStatus({ fetchImpl = proxyFetch, timeoutMs = 5000, signal = null } = {}) {
  const request = timeoutSignal(signal, timeoutMs);
  try {
    const response = await fetchImpl(ANTHROPIC_STATUS_URL, {
      signal: request.signal,
    });
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      return 'Anthropic: UNKNOWN';
    }
    return formatAnthropicStatus(await readJsonBody(response, request.signal));
  } catch {
    return 'Anthropic: UNKNOWN';
  } finally {
    request.cleanup();
  }
}

/** Run the read-only terminal dashboard until its signal is aborted. */
export async function runWatchDashboard({
  stdout = process.stdout,
  stderr = process.stderr,
  signal = null,
  readTeamClaude = null,
  readAnthropic = readAnthropicStatus,
  wait = waitFor,
  now = Date.now,
} = {}) {
  if (!stdout.isTTY) {
    stderr.write('teamclaude watch needs a terminal. For a one-shot readout use: teamclaude status\n');
    return 1;
  }

  if (!readTeamClaude) {
    const config = await loadOrCreateConfig();
    const control = new RemoteControl({
      port: config.proxy.port,
      host: resolveControlHost(config),
      apiKey: config.proxy.apiKey,
      timeoutMs: 5000,
    });
    readTeamClaude = ({ signal }) => control.status({ signal });
  }

  const controller = signal ? null : new AbortController();
  signal ||= controller.signal;
  const stop = () => controller.abort();
  if (controller) {
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('SIGHUP', stop);
  }

  let painted = false;
  try {
    while (!signal.aborted) {
      const cycleStartedAt = now();
      const [teamClaude, anthropic] = await Promise.allSettled([
        readTeamClaude({ signal }),
        readAnthropic({ signal }),
      ]);
      if (signal.aborted) break;

      const frameNow = now();
      const frame = renderWatchFrame({
        teamClaudeStatus: teamClaude.status === 'fulfilled' ? teamClaude.value : null,
        teamClaudeError: teamClaude.status === 'rejected' ? teamClaude.reason?.message || teamClaude.reason : null,
        anthropicStatus: anthropic.status === 'fulfilled' ? anthropic.value : 'Anthropic: UNKNOWN',
        now: frameNow,
      });
      const prefix = painted ? '\x1b[H' : '\x1b[?25l\x1b[2J\x1b[H';
      stdout.write(`${prefix}${frame}\n\x1b[J`);
      painted = true;
      const elapsed = Math.max(0, now() - cycleStartedAt);
      await wait(Math.max(0, REFRESH_MS - elapsed), signal);
    }
    return 0;
  } finally {
    if (controller) {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      process.off('SIGHUP', stop);
    }
    if (painted) stdout.write('\x1b[?25h\n');
  }
}

function waitFor(ms, signal) {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

async function readJsonBody(response, signal) {
  if (!response.body?.getReader) return response.json();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  const onAbort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_000_000) {
        await reader.cancel();
        throw new Error('Anthropic status response is too large');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function cleanLine(value, maxLength = 240) {
  return String(value).replace(/\p{C}+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maxLength);
}
