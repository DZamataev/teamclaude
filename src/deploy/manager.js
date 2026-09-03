import { spawnSync } from 'node:child_process';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { loadConfig as defaultLoadConfig } from '../config.js';
import {
  DEPLOYMENT_SCHEMA_VERSION,
  assertSafeRootRemoval as defaultAssertSafeRootRemoval,
  assertMutationAllowed,
  readDeployment as defaultReadDeployment,
  validateInstallConfig,
  writeDeployment as defaultWriteDeployment,
} from './layout.js';
import { createGitReleaseStore, validateRemoteUrl, validateRequestedRef } from './git-releases.js';
import {
  createDeployServiceAdapter,
  isDeploymentOwnedDefinition,
  renderLaunchAgent,
  renderSystemdService,
} from './service.js';
import {
  chooseLauncherPath as defaultChooseLauncherPath,
  discoverBootstrap as defaultDiscoverBootstrap,
  handoffLauncher as defaultHandoffLauncher,
  LAUNCHER_OWNER,
  removeOwnedLauncher as defaultRemoveOwnedLauncher,
  resolveNpmRestore as defaultResolveNpmRestore,
  restoreGlobalNpm as defaultRestoreGlobalNpm,
} from './launcher.js';

export const TEST_TIMEOUT_MS = 120_000;
export const HEALTH_ATTEMPTS = 20;
export const HEALTH_INTERVAL_MS = 1_000;

function defaultRun(command, argv, { cwd, timeoutMs = 30_000, stdio = 'pipe', env } = {}) {
  const result = spawnSync(command, argv, { cwd, encoding: 'utf8', timeout: timeoutMs, stdio, env });
  return {
    code: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
  };
}

function commandFailed(result) {
  return !result || (result.code ?? result.status) !== 0;
}

function below(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
}

function publicBackup(backup) {
  if (!backup) return null;
  const { source, backupPath, sha256, wasRunning, restoreOnUninstall } = backup;
  return { source, backupPath, sha256, wasRunning, restoreOnUninstall };
}

function defaultRenderService({ layout, nodePath }) {
  return layout.kind === 'systemd'
    ? renderSystemdService({ layout, nodePath })
    : renderLaunchAgent({ layout, nodePath });
}

export function createDeployManager(dependencies = {}) {
  const layout = dependencies.layout;
  if (!layout) throw new Error('A deployment layout is required');
  const run = dependencies.run || defaultRun;
  const store = dependencies.store || createGitReleaseStore({ layout, run });
  const service = dependencies.service || createDeployServiceAdapter({ layout, run });
  const loadConfig = dependencies.loadConfig || defaultLoadConfig;
  const readDeployment = dependencies.readDeployment || defaultReadDeployment;
  const writeDeployment = dependencies.writeDeployment || defaultWriteDeployment;
  const discoverBootstrap = dependencies.discoverBootstrap || defaultDiscoverBootstrap;
  const chooseLauncherPath = dependencies.chooseLauncherPath || defaultChooseLauncherPath;
  const handoffLauncher = dependencies.handoffLauncher || defaultHandoffLauncher;
  const fs = dependencies.fs || fsPromises;
  const validateUninstallLayout = dependencies.validateUninstallLayout || defaultAssertSafeRootRemoval;
  const assertSafeRootRemoval = dependencies.assertSafeRootRemoval || defaultAssertSafeRootRemoval;
  const readServiceDefinition = dependencies.readServiceDefinition || (async () => {
    const before = await fs.lstat(layout.serviceFile);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error(`Service definition must be a regular file: ${layout.serviceFile}`);
    }
    const contents = await fs.readFile(layout.serviceFile, 'utf8');
    const after = await fs.lstat(layout.serviceFile);
    if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error(`Service definition changed during inspection: ${layout.serviceFile}`);
    }
    return contents;
  });
  const resolveNpmRestore = dependencies.resolveNpmRestore || defaultResolveNpmRestore;
  const restoreGlobalNpm = dependencies.restoreGlobalNpm || defaultRestoreGlobalNpm;
  const removeOwnedLauncher = dependencies.removeOwnedLauncher || defaultRemoveOwnedLauncher;
  const removeDeploymentRoot = dependencies.removeDeploymentRoot
    || (() => fs.rm(layout.root, { recursive: true, force: false }));
  const verifyRestoredCommand = dependencies.verifyRestoredCommand || (async resolved => {
    const result = run(resolved.commandPath, ['version']);
    if (commandFailed(result)) throw new Error(`Restored command failed verification: ${resolved.commandPath} version`);
  });
  const validateLauncher = dependencies.validateLauncher || (async path => {
    try {
      const stat = await fs.lstat(path);
      if (stat.isSymbolicLink()) return { exists: true, owned: false, symlink: true };
      if (!stat.isFile()) return { exists: true, owned: false, symlink: false };
      const contents = await fs.readFile(path, 'utf8');
      return { exists: true, owned: contents.includes(`TeamClaude-Owner: ${LAUNCHER_OWNER}`), symlink: false };
    } catch (error) {
      if (error.code === 'ENOENT') return { exists: false, owned: false, symlink: false };
      throw error;
    }
  });
  const stageLauncher = dependencies.stageLauncher || (async launcherPath => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'teamclaude-uninstall-'));
    const path = join(directory, 'teamclaude');
    await fs.copyFile(launcherPath, path);
    await fs.chmod(path, 0o700);
    return { path };
  });
  const restoreStagedLauncher = dependencies.restoreStagedLauncher || (async (staged, launcherPath) => {
    await fs.mkdir(dirname(launcherPath), { recursive: true, mode: 0o755 });
    await fs.copyFile(staged.path, launcherPath);
    await fs.chmod(launcherPath, 0o755);
  });
  const cleanupStagedLauncher = dependencies.cleanupStagedLauncher || (async staged => {
    if (staged?.path) await fs.rm(dirname(staged.path), { recursive: true, force: true });
  });
  const renderService = dependencies.renderService || defaultRenderService;
  const sleep = dependencies.sleep || (milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds)));
  const now = dependencies.now || (() => new Date());
  const onStage = dependencies.onStage || (() => {});
  const uid = dependencies.uid ?? process.getuid?.();

  const runCandidateTests = dependencies.runCandidateTests || (async (candidate, nodePath) => {
    const result = run(nodePath, ['--test', `--test-timeout=${TEST_TIMEOUT_MS}`], {
      cwd: candidate.path,
      timeoutMs: TEST_TIMEOUT_MS + 30_000,
      stdio: 'inherit',
    });
    if (commandFailed(result)) throw new Error(`candidate tests exited ${result?.code ?? result?.status ?? 'unknown'}`);
  });

  const checkHealth = dependencies.checkHealth || (async metadata => {
    const entry = join(layout.current, 'src', 'index.js');
    const result = run(metadata.nodePath, [entry, 'status'], {
      timeoutMs: 10_000,
      env: { ...process.env, TEAMCLAUDE_CONFIG: metadata.configPath },
    });
    return !commandFailed(result);
  });

  async function preflight({ remoteUrl, ref }) {
    onStage('preflight');
    if (layout.platform !== 'linux' && layout.platform !== 'darwin') {
      throw new Error(`teamclaude deploy supports Linux and macOS, not ${layout.platform}`);
    }
    assertMutationAllowed(layout, { uid });
    if (below(layout.root, layout.configPath)) {
      throw new Error(`TeamClaude config cannot be stored inside the deployment root: ${layout.configPath}`);
    }
    validateRemoteUrl(remoteUrl);
    validateRequestedRef(ref);
    const config = await loadConfig();
    const eligible = validateInstallConfig(config);
    if (!eligible.ok) throw new Error(`TeamClaude config is not deployable: ${eligible.reason}`);
    const bootstrap = discoverBootstrap();
    const git = run('git', ['--version'], { timeoutMs: 5_000 });
    if (commandFailed(git)) throw new Error('Git is required for teamclaude deploy install');
    return { config, bootstrap };
  }

  async function waitForHealth(metadata) {
    for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1) {
      const serviceState = await service.status();
      if (serviceState.running && await checkHealth(metadata)) return serviceState;
      if (attempt < HEALTH_ATTEMPTS) await sleep(HEALTH_INTERVAL_MS);
    }
    throw new Error(`deployment did not become healthy after ${HEALTH_ATTEMPTS} attempts`);
  }

  async function requireMetadata({ mutation = true } = {}) {
    const metadata = await readDeployment(layout);
    if (!metadata) {
      throw new Error('Git deployment is not installed. Run: teamclaude deploy install <git-url>');
    }
    if (mutation) assertMutationAllowed(layout, { uid });
    return metadata;
  }

  function rollbackAggregate(candidateError, rollbackError) {
    const logCommand = layout.kind === 'systemd'
      ? 'teamclaude deploy logs --no-follow'
      : `tail -n 100 ${layout.logFile}`;
    return new AggregateError(
      [candidateError, rollbackError],
      `Candidate deployment failed: ${candidateError.message}. Rollback also failed: ${rollbackError.message}. Inspect logs with: ${logCommand}`,
    );
  }

  async function restoreRuntime(selection, metadata, candidateError) {
    try {
      await store.restoreSelection(selection);
      await service.restart();
      await waitForHealth(metadata);
    } catch (rollbackError) {
      throw rollbackAggregate(candidateError, rollbackError);
    }
    throw candidateError;
  }

  async function install({ remoteUrl, ref = 'master' }) {
    const { bootstrap } = await preflight({ remoteUrl, ref });
    const existingMetadata = await readDeployment(layout);
    if (existingMetadata && existingMetadata.remoteUrl !== remoteUrl) {
      throw new Error(`Deployment already uses a different remote: ${existingMetadata.remoteUrl}`);
    }
    const repository = await store.ensureRepository(remoteUrl);
    await store.fetch();
    const commit = await store.resolveRef(ref);
    const originalSelection = await store.readSelection();
    const currentRelease = originalSelection.current
      ? await store.describeRelease(originalSelection.current)
      : null;
    const candidate = currentRelease?.commit === commit
      ? currentRelease
      : await store.createCandidate(commit);
    await runCandidateTests(candidate, bootstrap.nodePath);

    const definition = renderService({ layout, nodePath: bootstrap.nodePath });
    await service.validateDefinition(definition);
    const serviceBackup = await service.backupExisting();
    const adopted = !existingMetadata && !repository.cloned && Boolean(originalSelection.current);
    const launcherSelection = existingMetadata
      ? { path: existingMetadata.launcherPath, pathInstruction: null }
      : chooseLauncherPath({ layout });
    const provisionalMetadata = {
      schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
      remoteUrl,
      requestedRef: ref,
      nodePath: bootstrap.nodePath,
      launcherPath: launcherSelection.path,
      configPath: layout.configPath,
      serviceKind: layout.kind,
      installedAt: existingMetadata?.installedAt || now().toISOString(),
      npmCleanupPending: false,
      npmRestore: existingMetadata?.npmRestore || {
        packageName: '@karpeleslab/teamclaude', version: null, npmPath: bootstrap.npmPath,
      },
      serviceBackup: existingMetadata?.serviceBackup ?? publicBackup(serviceBackup),
    };
    let serviceTakeoverAttempted = false;
    let candidateActivated = false;
    let handoff;
    try {
      if (serviceBackup) {
        serviceTakeoverAttempted = true;
        await service.stop();
      }
      if (candidate.path !== originalSelection.current) {
        await store.activate(candidate.path);
        candidateActivated = true;
      }
      serviceTakeoverAttempted = true;
      await service.install(definition);
      await service.start();
      await waitForHealth(provisionalMetadata);
      handoff = await handoffLauncher({
        bootstrap: adopted ? { ...bootstrap, installKind: 'git', packageVersion: null } : bootstrap,
        launcherPath: launcherSelection.path,
        entryPath: join(layout.current, 'src', 'index.js'),
      });
    } catch (candidateError) {
      if (!serviceTakeoverAttempted && !candidateActivated) throw candidateError;
      const rollbackErrors = [];
      if (serviceTakeoverAttempted) {
        try {
          await service.restore(serviceBackup);
        } catch (error) {
          rollbackErrors.push(error);
        }
      }
      if (candidateActivated) {
        try {
          await store.restoreSelection(originalSelection);
        } catch (error) {
          rollbackErrors.push(error);
        }
      }
      if (rollbackErrors.length === 0) {
        try {
          await waitForHealth(provisionalMetadata);
        } catch (error) {
          rollbackErrors.push(error);
        }
      }
      if (rollbackErrors.length > 0) {
        const logCommand = layout.kind === 'systemd'
          ? 'teamclaude deploy logs --no-follow'
          : `tail -n 100 ${layout.logFile}`;
        const detail = rollbackErrors.map(error => error.message).join('; ');
        throw new AggregateError(
          [candidateError, ...rollbackErrors],
          `Candidate deployment failed: ${candidateError.message}. Rollback also failed: ${detail}. Inspect logs with: ${logCommand}`,
        );
      }
      throw candidateError;
    }
    const metadata = {
      ...provisionalMetadata,
      launcherPath: handoff.launcherPath,
      npmCleanupPending: handoff.npmCleanupPending,
      npmRestore: existingMetadata?.npmRestore || handoff.npmRestore,
    };
    await writeDeployment(layout, metadata);
    const partial = Boolean(handoff.npmCleanupPending);
    return {
      ok: !partial,
      partial,
      requestedRef: ref,
      commit,
      releasePath: candidate.path,
      launcherPath: handoff.launcherPath,
      npmCleanupPending: handoff.npmCleanupPending,
      npmRestore: metadata.npmRestore,
      serviceBackup: metadata.serviceBackup,
      ...(handoff.warning ? { warning: handoff.warning } : {}),
    };
  }

  async function deployRef({ ref }) {
    const metadata = await requireMetadata();
    validateRequestedRef(ref);
    await store.ensureRepository(metadata.remoteUrl);
    await store.fetch();
    const commit = await store.resolveRef(ref);
    const candidate = await store.createCandidate(commit);
    await runCandidateTests(candidate, metadata.nodePath);
    const originalSelection = await store.readSelection();
    await store.activate(candidate.path);
    try {
      await service.restart();
      await waitForHealth(metadata);
    } catch (candidateError) {
      return restoreRuntime(originalSelection, metadata, candidateError);
    }
    await writeDeployment(layout, { ...metadata, requestedRef: ref });
    return {
      ok: true,
      requestedRef: ref,
      commit,
      releasePath: candidate.path,
      previous: originalSelection.current,
    };
  }

  async function rollback() {
    const metadata = await requireMetadata();
    const originalSelection = await store.readSelection();
    const selection = await store.swapForRollback();
    try {
      await service.restart();
      await waitForHealth(metadata);
    } catch (candidateError) {
      return restoreRuntime(originalSelection, metadata, candidateError);
    }
    return { ok: true, current: selection.current, previous: selection.previous };
  }

  async function restart() {
    const metadata = await requireMetadata();
    await service.restart();
    await waitForHealth(metadata);
    return { ok: true };
  }

  async function logs({ lines = 100, follow = true } = {}) {
    if (!Number.isInteger(lines) || lines < 1 || lines > 100_000) {
      throw new Error('logs lines must be an integer from 1 to 100000');
    }
    await requireMetadata({ mutation: false });
    const result = await service.logs({ lines, follow });
    return { ok: result.code === 0, code: result.code };
  }

  async function status() {
    const metadata = await readDeployment(layout);
    if (!metadata) {
      return { installed: false, platform: layout.platform, root: layout.root, detail: 'not installed' };
    }
    const selection = await store.readSelection();
    const [current, previous, serviceState] = await Promise.all([
      selection.current ? store.describeRelease(selection.current) : null,
      selection.previous ? store.describeRelease(selection.previous) : null,
      service.status(),
    ]);
    return {
      schemaVersion: metadata.schemaVersion,
      platform: layout.platform,
      root: layout.root,
      remoteUrl: metadata.remoteUrl,
      requestedRef: metadata.requestedRef,
      current,
      previous,
      service: serviceState,
      nodePath: metadata.nodePath,
      launcherPath: metadata.launcherPath,
      configPath: metadata.configPath,
      npmCleanupPending: metadata.npmCleanupPending,
      npmRestore: metadata.npmRestore,
      serviceBackup: metadata.serviceBackup,
    };
  }

  async function uninstall({ restoreNpm } = {}) {
    if (typeof restoreNpm !== 'boolean') {
      throw new Error('uninstall restoreNpm must be an explicit boolean');
    }
    const metadata = await requireMetadata();
    await validateUninstallLayout(layout, metadata);
    await store.readSelection();
    const deploymentDefinition = await readServiceDefinition();
    if (!isDeploymentOwnedDefinition(deploymentDefinition)) {
      throw new Error(`Service definition is not deployment-owned: ${layout.serviceFile}`);
    }
    const validBackup = metadata.serviceBackup
      ? await service.validateBackup(metadata.serviceBackup)
      : null;
    const launcherState = await validateLauncher(metadata.launcherPath);
    if (launcherState.exists && !launcherState.owned && restoreNpm) {
      throw new Error(`Refusing to overwrite a launcher that is not deployment-owned: ${metadata.launcherPath}`);
    }

    let resolvedNpm = null;
    if (restoreNpm) {
      resolvedNpm = await resolveNpmRestore({
        npmRestore: metadata.npmRestore,
        nodePath: metadata.nodePath,
        run,
      });
      const commandState = resolvedNpm.commandPath === metadata.launcherPath
        ? launcherState
        : await validateLauncher(resolvedNpm.commandPath);
      if (commandState.exists && !commandState.owned) {
        throw new Error(`Refusing to overwrite a non-deployment command: ${resolvedNpm.commandPath}`);
      }
      if (!launcherState.exists || !launcherState.owned || launcherState.symlink) {
        throw new Error(`A regular deployment-owned launcher is required for safe npm restoration: ${metadata.launcherPath}`);
      }
    }

    const stagedLauncher = launcherState.exists && launcherState.owned
      ? await stageLauncher(metadata.launcherPath)
      : null;
    let npmRestored = false;
    if (restoreNpm) {
      try {
        await restoreGlobalNpm(resolvedNpm, { run });
        npmRestored = true;
      } catch (error) {
        if (stagedLauncher) await restoreStagedLauncher(stagedLauncher, metadata.launcherPath).catch(() => {});
        await cleanupStagedLauncher(stagedLauncher).catch(() => {});
        throw new Error(
          `npm restoration failed: ${error.message}. Retry manually: npm install --global ${resolvedNpm.packageSpec}`,
          { cause: error },
        );
      }
    }

    const shouldRestorePriorService = Boolean(
      restoreNpm && validBackup?.restoreOnUninstall,
    );
    let restoredService = false;
    let launcherRemoved = false;
    let commitBoundary = false;
    try {
      await service.stop();
      await service.removeOwnedDefinition();
      if (shouldRestorePriorService) {
        await service.restore(validBackup);
        const priorState = await service.status();
        if (!priorState.installed || (validBackup.wasRunning && !priorState.running)) {
          throw new Error('The prior TeamClaude service did not restore to its recorded state');
        }
        restoredService = true;
      }
      const launcherResult = await removeOwnedLauncher({ launcherPath: metadata.launcherPath });
      launcherRemoved = launcherResult.removed;
      await assertSafeRootRemoval(layout, metadata);
      commitBoundary = true;
      await removeDeploymentRoot(layout.root);
    } catch (primaryError) {
      if (commitBoundary) {
        if (restoreNpm) await verifyRestoredCommand(resolvedNpm).catch(() => {});
        await cleanupStagedLauncher(stagedLauncher).catch(() => {});
        return {
          ok: false,
          partial: true,
          restoredNpm: npmRestored,
          packageSpec: resolvedNpm?.packageSpec || null,
          commandPath: resolvedNpm?.commandPath || null,
          restoredService,
          launcherRemoved,
          removedRoot: false,
          remainingPaths: [layout.root],
          warning: `Deployment teardown committed, but the deployment root remains: ${primaryError.message}`,
        };
      }

      const compensationErrors = [];
      try {
        await service.stop().catch(() => {});
        await service.install(deploymentDefinition);
        if (stagedLauncher) await restoreStagedLauncher(stagedLauncher, metadata.launcherPath);
        await service.start();
        await waitForHealth(metadata);
      } catch (error) {
        compensationErrors.push(error);
      }
      await cleanupStagedLauncher(stagedLauncher).catch(() => {});
      if (compensationErrors.length > 0) {
        throw rollbackAggregate(primaryError, compensationErrors[0]);
      }
      throw primaryError;
    }

    if (restoreNpm) {
      try {
        await verifyRestoredCommand(resolvedNpm);
      } catch (error) {
        await cleanupStagedLauncher(stagedLauncher).catch(() => {});
        return {
          ok: false,
          partial: true,
          restoredNpm: npmRestored,
          packageSpec: resolvedNpm.packageSpec,
          commandPath: resolvedNpm.commandPath,
          restoredService,
          launcherRemoved,
          removedRoot: true,
          remainingPaths: [resolvedNpm.commandPath],
          warning: `Deployment was removed, but the restored npm command failed verification: ${error.message}`,
        };
      }
    }
    await cleanupStagedLauncher(stagedLauncher);
    return {
      ok: true,
      partial: false,
      restoredNpm: npmRestored,
      packageSpec: resolvedNpm?.packageSpec || null,
      commandPath: resolvedNpm?.commandPath || null,
      restoredService,
      launcherRemoved,
      removedRoot: true,
      remainingPaths: [],
      ...(!restoreNpm ? {
        warning: 'TeamClaude was intentionally left uninstalled; the config, state, nginx, and retained logs were preserved.',
      } : {}),
    };
  }

  return { install, deployRef, rollback, restart, logs, status, uninstall };
}
