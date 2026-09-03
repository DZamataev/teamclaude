import { createInterface } from 'node:readline';
import { resolveDeployLayout } from './layout.js';
import { createDeployManager } from './manager.js';

const HELP = `teamclaude deploy install <git-url> [--ref master]
teamclaude deploy ref <branch|tag|commit>
teamclaude deploy rollback
teamclaude deploy restart
teamclaude deploy logs [--lines 100] [--no-follow]
teamclaude deploy status [--json]
teamclaude deploy uninstall [--yes] [--restore-npm|--no-restore-npm]
teamclaude deploy help
`;

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 64;
  return error;
}

function rejectExtra(command, argv) {
  if (argv.length) throw usageError(`Unexpected arguments for deploy ${command}: ${argv.join(' ')}`);
  return { command };
}

function takeUniqueFlag(argv, flag, { value = false } = {}) {
  const indices = argv.flatMap((item, index) => item === flag ? [index] : []);
  if (indices.length > 1) throw usageError(`Duplicate option: ${flag}`);
  if (indices.length === 0) return { found: false, argv };
  const index = indices[0];
  if (!value) return { found: true, argv: argv.toSpliced(index, 1) };
  const selected = argv[index + 1];
  if (!selected || selected.startsWith('--')) throw usageError(`${flag} requires a value`);
  return { found: true, selected, argv: argv.toSpliced(index, 2) };
}

export function parseDeployArgs(argv) {
  const [command = 'help', ...rest] = argv;
  if (command === 'help') return rejectExtra('help', rest);
  if (command === 'install') {
    const refFlag = takeUniqueFlag(rest, '--ref', { value: true });
    if (refFlag.argv.length !== 1 || refFlag.argv[0].startsWith('--')) {
      throw usageError('deploy install requires exactly one <git-url>');
    }
    return { command, remoteUrl: refFlag.argv[0], ref: refFlag.found ? refFlag.selected : 'master' };
  }
  if (command === 'ref') {
    if (rest.length !== 1 || rest[0].startsWith('--')) throw usageError('deploy ref requires one branch, tag, or commit');
    return { command, ref: rest[0] };
  }
  if (command === 'rollback' || command === 'restart') return rejectExtra(command, rest);
  if (command === 'logs') {
    const noFollow = takeUniqueFlag(rest, '--no-follow');
    const linesFlag = takeUniqueFlag(noFollow.argv, '--lines', { value: true });
    if (linesFlag.argv.length) throw usageError(`Unknown deploy logs option: ${linesFlag.argv[0]}`);
    const lines = linesFlag.found ? Number(linesFlag.selected) : 100;
    if (!Number.isInteger(lines) || lines < 1 || lines > 100_000) {
      throw usageError('--lines must be an integer from 1 to 100000');
    }
    return { command, lines, follow: !noFollow.found };
  }
  if (command === 'status') {
    const json = takeUniqueFlag(rest, '--json');
    if (json.argv.length) throw usageError(`Unknown deploy status option: ${json.argv[0]}`);
    return { command, json: json.found };
  }
  if (command === 'uninstall') {
    const yes = takeUniqueFlag(rest, '--yes');
    const restore = takeUniqueFlag(yes.argv, '--restore-npm');
    const noRestore = takeUniqueFlag(restore.argv, '--no-restore-npm');
    if (restore.found && noRestore.found) {
      throw usageError('--restore-npm and --no-restore-npm cannot be used together');
    }
    if (noRestore.argv.length) throw usageError(`Unknown deploy uninstall option: ${noRestore.argv[0]}`);
    return {
      command,
      yes: yes.found,
      restoreNpm: restore.found ? true : noRestore.found ? false : null,
    };
  }
  throw usageError(`Unknown deploy command: ${command}`);
}

export function showDeployHelp(out = process.stdout) {
  out.write(HELP);
}

const promptReaders = new WeakMap();

function promptReader(input) {
  let state = promptReaders.get(input);
  if (!state) {
    const lines = createInterface({ input, crlfDelay: Infinity });
    state = { lines, iterator: lines[Symbol.asyncIterator]() };
    promptReaders.set(input, state);
  }
  return state;
}

function closePromptReader(input) {
  const state = promptReaders.get(input);
  if (state) state.lines.close();
  promptReaders.delete(input);
}

export async function promptYesNo({ input, output, question, defaultValue }) {
  const { iterator } = promptReader(input);
  while (true) {
    output.write(`${question} `);
    const next = await iterator.next();
    if (next.done) return null;
    const answer = next.value.trim().toLowerCase();
    if (!answer) return defaultValue;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    output.write('Please answer yes or no.\n');
  }
}

function defaultManager() {
  return createDeployManager({ layout: resolveDeployLayout() });
}

function printHumanStatus(status, stdout) {
  if (status.installed === false) {
    stdout.write(`Status:       not installed\nPlatform:     ${status.platform}\nRoot:         ${status.root}\n`);
    return;
  }
  const service = status.service || {};
  const serviceText = service.running ? (service.detail || 'running') : (service.detail || 'stopped');
  stdout.write([
    `Platform:     ${status.platform}`,
    `Root:         ${status.root}`,
    `Remote:       ${status.remoteUrl}`,
    `Requested:    ${status.requestedRef}`,
    `Current:      ${status.current ? `${status.current.commit}  ${status.current.path}` : '-'}`,
    `Previous:     ${status.previous ? `${status.previous.commit}  ${status.previous.path}` : '-'}`,
    `Service:      ${serviceText}`,
    `Node:         ${status.nodePath}`,
    `Launcher:     ${status.launcherPath}`,
    `Config:       ${status.configPath}`,
    `npm cleanup:  ${status.npmCleanupPending ? 'pending' : 'complete'}`,
    '',
  ].join('\n'));
}

function printDeploymentResult(result, output) {
  if (result.commit) output.write(`Commit: ${result.commit}\n`);
  if (result.releasePath) output.write(`Release: ${result.releasePath}\n`);
  if (result.warning) output.write(`${result.warning}\n`);
}

async function resolveUninstall(parsed, { input, output }) {
  const interactive = input.isTTY === true;
  if (!interactive && (!parsed.yes || parsed.restoreNpm === null)) {
    output.write('Non-interactive uninstall requires one of:\n');
    output.write('  teamclaude deploy uninstall --yes --restore-npm\n');
    output.write('  teamclaude deploy uninstall --yes --no-restore-npm\n');
    return { code: 64 };
  }
  try {
    if (!parsed.yes) {
      const remove = await promptYesNo({
        input, output,
        question: 'Remove the Git deployment, service, releases, and launcher? [y/N]',
        defaultValue: false,
      });
      if (remove !== true) return { code: 0 };
    }
    let restoreNpm = parsed.restoreNpm;
    if (restoreNpm === null) {
      restoreNpm = await promptYesNo({
        input, output,
        question: 'Restore @karpeleslab/teamclaude as a global npm package? [Y/n]',
        defaultValue: true,
      });
      if (restoreNpm === null) return { code: 0 };
    }
    if (!restoreNpm) output.write('The teamclaude command will be removed with the Git deployment.\n');
    return { restoreNpm };
  } finally {
    closePromptReader(input);
  }
}

export async function runDeployCli(argv, {
  input = process.stdin,
  output = process.stderr,
  stdout = process.stdout,
  createManager = defaultManager,
} = {}) {
  let parsed;
  try {
    parsed = parseDeployArgs(argv);
  } catch (error) {
    output.write(`${error.message}\n`);
    return error.exitCode || 64;
  }
  if (parsed.command === 'help') {
    showDeployHelp(stdout);
    return 0;
  }

  let uninstallDecision = null;
  if (parsed.command === 'uninstall') {
    uninstallDecision = await resolveUninstall(parsed, { input, output });
    if (Object.hasOwn(uninstallDecision, 'code')) return uninstallDecision.code;
  }

  let manager;
  try {
    manager = createManager();
    if (parsed.command === 'install') {
      const result = await manager.install({ remoteUrl: parsed.remoteUrl, ref: parsed.ref });
      printDeploymentResult(result, result.partial ? output : stdout);
      return result.ok ? 0 : 1;
    }
    if (parsed.command === 'ref') {
      const result = await manager.deployRef({ ref: parsed.ref });
      printDeploymentResult(result, stdout);
      return result.ok ? 0 : 1;
    }
    if (parsed.command === 'rollback') {
      const result = await manager.rollback();
      stdout.write(`Current: ${result.current}\nPrevious: ${result.previous}\n`);
      return result.ok ? 0 : 1;
    }
    if (parsed.command === 'restart') {
      const result = await manager.restart();
      if (result.ok) stdout.write('TeamClaude restarted and is healthy.\n');
      return result.ok ? 0 : 1;
    }
    if (parsed.command === 'logs') {
      const result = await manager.logs({ lines: parsed.lines, follow: parsed.follow });
      return result.code;
    }
    if (parsed.command === 'status') {
      const status = await manager.status();
      if (parsed.json) stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      else printHumanStatus(status, stdout);
      return 0;
    }
    const result = await manager.uninstall({ restoreNpm: uninstallDecision.restoreNpm });
    if (result.restoredNpm) {
      stdout.write(`Restored: ${result.packageSpec}\nCommand: ${result.commandPath}\n`);
    }
    if (result.restoredService) stdout.write('The prior TeamClaude service was restored.\n');
    if (result.warning) (result.partial ? output : stdout).write(`${result.warning}\n`);
    if (result.partial) {
      for (const path of result.remainingPaths) output.write(`Remaining: ${path}\n`);
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    output.write(`teamclaude deploy ${parsed.command} failed: ${error.message}\n`);
    return 1;
  }
}
