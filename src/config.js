import { readFile, open, mkdir, chmod, rename, unlink, realpath, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { resolveUpstreamProxy, setUpstreamProxy } from './upstream-proxy.js';
import { ensureAccountIds } from './account-id.js';

export function getConfigPath() {
  if (process.env.TEAMCLAUDE_CONFIG) return process.env.TEAMCLAUDE_CONFIG;
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configDir, 'teamclaude.json');
}

/**
 * Path to the runtime state file (a sibling of the config). This holds volatile
 * data learned at runtime — e.g. quota utilization observed passively from
 * traffic — kept out of the hand-editable config so config stays clean and
 * isn't rewritten on every state save.
 */
export function getStatePath() {
  const cfg = getConfigPath();
  return cfg.endsWith('.json') ? cfg.replace(/\.json$/, '.state.json') : cfg + '.state';
}

/**
 * Path to the crash log (a sibling of the config), where a fatal error is
 * recorded before the process exits.
 */
export function getCrashLogPath() {
  const cfg = getConfigPath();
  return cfg.endsWith('.json') ? cfg.replace(/\.json$/, '-crash.log') : cfg + '-crash.log';
}

export async function loadState() {
  try {
    return JSON.parse(await readFile(getStatePath(), 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveState(state) {
  await writeJsonAtomic(getStatePath(), state);
}

/**
 * Write a JSON document so that the file at `path` is, at every instant, either
 * the previous complete document or the new one.
 *
 * A plain writeFile truncates first and fills in afterwards. The config holds
 * every account's OAuth tokens and the proxy key; a crash or power loss in that
 * gap left an empty or half-written file, and the next start threw on
 * JSON.parse with the credentials gone. So the document goes to a sibling
 * temp file, is fsynced so it is on disk before it is named, and is renamed
 * over the target — rename replaces atomically on POSIX and, in Node, on
 * Windows too (same scheme mitm.js uses for the leaf key).
 *
 * The temp file is created 0600 and chmod'ed before the rename, so the
 * "enforce 0600 on every save" behaviour of the old code holds: a config that
 * was once world-readable becomes 0600 on the next save, and the tokens are
 * never on disk under a looser mode even for an instant.
 */
async function writeJsonAtomic(path, value) {
  // A rename replaces the NAME, so a config that is a symlink (a dotfiles
  // checkout, say) would silently become a regular file where the old in-place
  // write followed the link. Resolve it first; a dangling or absent path is
  // written where it is.
  path = await realpath(path).catch(() => path);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    const fh = await open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(JSON.stringify(value, null, 2) + '\n');
      await fh.sync();
    } finally {
      await fh.close();
    }
    // `open`'s mode is masked by the umask; make the mode exact regardless.
    await chmod(tmp, 0o600).catch(() => {});
    await rename(tmp, path);
  } catch (err) {
    // Never leave a half-written copy of the credentials lying beside the config.
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export function createDefaultConfig() {
  return {
    proxy: {
      port: 3456,
      apiKey: 'tc-' + randomBytes(24).toString('base64url'),
    },
    upstream: 'https://api.anthropic.com',
    switchThreshold: 0.98,
    holdSeconds: 0,
    distributeSessions: false,
    sessionTitles: { enabled: false, width: 18 },
    eventLogging: 'hide',
    blockedModels: [],
    accounts: [],
  };
}

export async function loadConfig() {
  const path = getConfigPath();
  try {
    const config = JSON.parse(await readFile(path, 'utf-8'));
    // A file with no `accounts` key is what an empty or hand-trimmed config
    // looks like. Every reader treats the list as always present, and the first
    // one to trip was the save path — so the failure arrived while writing,
    // long after the read that could have explained it (#330). A missing list
    // is an empty one.
    if (!Array.isArray(config.accounts)) config.accounts = [];
    // Everything downstream pairs config entries to running accounts by entry id,
    // so a config written before the field existed — or edited by hand — is given
    // ids here, before anything can read one. The next save persists them.
    ensureAccountIds(config.accounts);
    applyUpstreamProxy(config);
    return config;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Publish the config's egress proxy to the process-wide setting.
 *
 * Done here, in the one place every command loads its config, rather than at
 * each of the sixteen call sites: `login`, `import`, `accounts`, `probe` and the
 * server all reach the network, and a proxy that applied to only some of them
 * would be worse than none — the account list would refresh while logging in
 * failed, or vice versa.
 *
 * A bad value is fatal on purpose. Falling back to a direct connection on a host
 * that has no route to the internet would turn one clear error into a pile of
 * ETIMEDOUTs pointing nowhere near the typo that caused them.
 */
function applyUpstreamProxy(config) {
  try {
    setUpstreamProxy(resolveUpstreamProxy(config));
  } catch (err) {
    console.error(`[TeamClaude] Bad proxy setting in ${getConfigPath()}: ${err.message}`);
    process.exit(1);
  }
}

export async function loadOrCreateConfig() {
  let config = await loadConfig();
  if (!config) {
    config = createDefaultConfig();
    await saveConfig(config);
    console.log(`Created config at ${getConfigPath()}`);
    // loadConfig applies this only when a file already existed — it returns
    // early on ENOENT. Without it here, the FIRST run of a network command
    // (`login` on a fresh install) leaves the process-wide setting unset, and
    // the lazy fallback resolves it from the environment against an EMPTY
    // config. That fallback has no listener to compare against, so the
    // self-proxy guard cannot fire: an operator whose HTTPS_PROXY points at
    // their own TeamClaude gets a CONNECT back into the proxy and a timeout,
    // on the one run where there is no config to explain it.
    applyUpstreamProxy(config);
  }
  return config;
}

export async function saveConfig(config) {
  // The proxy apiKey and every account's tokens live here: see writeJsonAtomic
  // for why this is not a plain writeFile.
  await writeJsonAtomic(getConfigPath(), config);
}

// Serialize config updates. atomicConfigUpdate is a read-modify-write, so two
// concurrent callers can both read the same config and then save in turn, and
// the later save silently drops the earlier caller's change. This bites hardest
// on startup, when several OAuth accounts refresh their tokens at once: only the
// last writer's rotated refresh token persists, and the other accounts keep a
// token that was just rotated away, so they fail on the next restart with
// invalid_grant and need a re-login. Chaining the updates keeps every write.
let configUpdateChain = Promise.resolve();

// A lock is stuck when its holder is GONE, not when it is slow. Time alone
// cannot tell the two apart: on a small host a queue of updaters legitimately
// takes one slow turn each, and every fixed budget — whether it bounds the
// whole wait or a single turn — eventually fails callers that are waiting on
// work which is actually progressing. The queue that matters is several OAuth
// accounts persisting rotated refresh tokens at once, where a caller that gives
// up loses a token upstream has already rotated and the account needs a
// re-login: precisely what this locking exists to prevent.
//
// So the holder writes its pid, and a waiter only breaks the lock once that
// process is gone. A live holder is waited on for as long as it lives.

// The grace period before an ownerless lock is broken. A lock is written in two
// steps — create, then write the pid — so a lock found empty may simply be one
// created microseconds ago. Waiting this long before believing it is abandoned
// costs nothing on the happy path and avoids stealing a lock from a holder that
// had not finished announcing itself.
const CONFIG_LOCK_STALE_MS = 15_000;

// Is this process alive? Signal 0 performs the permission and existence checks
// without delivering anything. EPERM means it exists under another uid, which
// still answers the question that matters here: something holds this lock.
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Who holds the lock: its pid, and how long the file has existed. A lock whose
// contents are unreadable or not a pid is treated as ownerless, which the
// caller resolves by the staleness rule rather than by trusting it forever.
async function readLockHolder(lockPath) {
  try {
    const [text, info] = await Promise.all([
      readFile(lockPath, 'utf-8').catch(() => ''),
      stat(lockPath),
    ]);
    const pid = Number.parseInt(String(text).trim(), 10);
    return { pid: Number.isInteger(pid) ? pid : null, ageMs: Date.now() - info.mtimeMs };
  } catch {
    // Gone: the next open() attempt is the one that decides what that means.
    return null;
  }
}

async function acquireConfigLock() {
  const configPath = await realpath(getConfigPath()).catch(() => getConfigPath());
  const lockPath = `${configPath}.lock`;
  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      // Announce ownership so a later waiter can tell a live holder from the
      // remains of one that was killed.
      await handle.write(`${process.pid}\n`, 0, 'utf-8').catch(() => {});
      await handle.sync?.().catch(() => {});
      return async () => {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const holder = await readLockHolder(lockPath);
      // Released while we looked: retry immediately rather than sleeping.
      if (holder) {
        const ownerless = holder.pid == null || !processAlive(holder.pid);
        if (ownerless && holder.ageMs >= CONFIG_LOCK_STALE_MS) {
          // The holder is gone and left the lock behind. Remove it and race for
          // it like everyone else; losing that race is fine, the winner is a
          // live holder we will then wait on.
          await unlink(lockPath).catch(() => {});
          continue;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 10 + Math.floor(Math.random() * 20)));
    }
  }
}

/**
 * Atomically update the config: re-reads from disk, calls updater(config),
 * then saves. Returns the updated config. This prevents overwriting changes
 * made by other processes (e.g. `teamclaude import` while the server runs), and
 * serializes concurrent callers so simultaneous updates queue instead of
 * clobbering one another.
 */
export function atomicConfigUpdate(updater) {
  const run = async () => {
    const release = await acquireConfigLock();
    try {
      const config = await loadConfig() || createDefaultConfig();
      await updater(config);
      await saveConfig(config);
      return config;
    } finally {
      await release();
    }
  };
  const result = configUpdateChain.then(run, run);
  configUpdateChain = result.then(() => {}, () => {});
  return result;
}
