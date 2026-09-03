# Git deployment

TeamClaude can replace a regular global npm installation with a persistent Git
deployment. Each deployed branch, tag, or commit becomes an immutable release;
the service and the `teamclaude` terminal command both run the selected release.

The deployment command is part of the normal TeamClaude binary. There is no
separate `teamclaude-deploy` package or second npm executable.

## Quick start

Install TeamClaude and create a usable account configuration first:

```bash
npm install -g @karpeleslab/teamclaude
teamclaude login                 # or: teamclaude import
teamclaude deploy install https://github.com/OWNER/teamclaude.git --ref master
```

`deploy install` checks the existing config, Git, Node.js, the remote URL, and
the requested ref before writing the deployment. It then clones or adopts the
repository, creates a detached candidate release, runs the complete test suite,
installs a boot-persistent service, checks service and application health, and
finally hands the `teamclaude` command to the Git deployment.

The global npm package is removed only after the Git launcher passes a smoke
test. TeamClaude records the exact npm version and executable so uninstall can
restore them later. If npm cleanup fails, the healthy Git deployment remains
active and the command reports this recovery step:

```bash
npm uninstall -g @karpeleslab/teamclaude
```

## Daily operations

```bash
teamclaude deploy status
teamclaude deploy ref feature/name
teamclaude deploy restart
teamclaude deploy logs
teamclaude deploy logs --lines 250 --no-follow
teamclaude deploy rollback
teamclaude deploy uninstall
```

`teamclaude deploy status --json` emits only JSON and is suitable for scripts.
`teamclaude status` is a different command: it queries the running proxy and its
accounts, while `teamclaude deploy status` describes Git releases, the service,
launcher, Node executable, and deployment metadata.

`deploy logs` follows logs by default. Use `--no-follow` for finite output.
`deploy rollback` swaps `current` and `previous`, so running it twice toggles
back to the original release.

## Selecting a ref

Deploy a remote branch, tag, or commit:

```bash
teamclaude deploy ref master
teamclaude deploy ref v1.2.0
teamclaude deploy ref 0123456789abcdef
```

The resolver checks a remote branch first, then a tag, then an explicit commit.
A local development branch must be pushed to the deployment repository before
the server can resolve it.

Every candidate is fetched into the persistent repository and checked out as a
detached worktree. TeamClaude runs its full Node test suite before changing
`current`. After the atomic switch it restarts the service and verifies both the
service manager and `current/src/index.js status`. A failed test never activates
the candidate. A failed restart or health check restores the exact previous
`current`/`previous` pair, restarts it, and verifies the restored application.

The candidate worktree is retained when deployment fails, making it available
for diagnosis.

## Linux layout and startup

Linux deployment is system-wide and must be installed or mutated as root. It
uses:

```text
/opt/teamclaude/
├── repo/                    # persistent Git repository
├── releases/                # detached immutable worktrees
├── current -> releases/...  # active release
├── previous -> releases/... # prior release
├── backups/                 # validated displaced service definition
└── deployment.json          # private deployment metadata

/etc/systemd/system/teamclaude.service
/usr/local/bin/teamclaude
```

The systemd unit is enabled under `multi-user.target`, uses `Restart=always`,
and starts the last selected `current` release after a reboot. It records an
absolute Node executable rather than depending on systemd's minimal PATH, so an
NVM installation is supported.

Useful checks are:

```bash
systemctl is-enabled teamclaude.service
systemctl is-active teamclaude.service
systemctl show teamclaude.service -p ExecStart -p WorkingDirectory
teamclaude deploy status
```

## macOS layout and startup

macOS deployment is per-user and does not require root. It uses:

```text
$HOME/Library/Application Support/TeamClaude/deploy/
├── repo/
├── releases/
├── current -> releases/...
├── previous -> releases/...
├── backups/
└── deployment.json

$HOME/Library/LaunchAgents/com.karpeleslab.teamclaude.plist
$HOME/Library/Logs/teamclaude.log
```

The LaunchAgent has `RunAtLoad` and `KeepAlive`, so the last selected release
starts at login and restarts after an unexpected exit.

The installer places the stable launcher in the first writable stable PATH
directory among `/usr/local/bin`, `/opt/homebrew/bin`, and `$HOME/.local/bin`.
It deliberately avoids version-specific NVM, asdf, Volta, and Homebrew Cellar
directories. If none is available, the launcher is stored in the deployment's
`bin` directory and the installer prints this exact zsh setup:

```zsh
path=("$HOME/Library/Application Support/TeamClaude/deploy/bin" $path)
export PATH
```

## Configuration and data preservation

The account config and runtime state remain outside the removable deployment
root. The normal defaults are:

```text
Linux: $HOME/.config/teamclaude.json
       $HOME/.config/teamclaude.state.json

macOS: $HOME/.config/teamclaude.json
       $HOME/.config/teamclaude.state.json
```

`TEAMCLAUDE_CONFIG` and `XDG_CONFIG_HOME` continue to select custom locations.
Installation is refused if the config is inside the deployment root, because
that root can be removed by uninstall.

Deploy, rollback, and uninstall never purge the TeamClaude config or state.
They also do not create, edit, reload, or remove nginx configuration. Retained
service logs outside the deployment root are preserved. Version 1 intentionally
has no config-purge option.

## Uninstall

Interactive and scripted forms are:

```bash
teamclaude deploy uninstall
teamclaude deploy uninstall --yes
teamclaude deploy uninstall --yes --restore-npm
teamclaude deploy uninstall --yes --no-restore-npm
```

Without flags, TeamClaude asks:

```text
Remove the Git deployment, service, releases, and launcher? [y/N]
Restore @karpeleslab/teamclaude as a global npm package? [Y/n]
```

`--yes` answers only the first question. `--restore-npm` and
`--no-restore-npm` answer only the second. A non-interactive invocation must
provide `--yes` and exactly one npm choice.

When npm restoration is selected, TeamClaude resolves the predicted global
command path, installs and verifies npm before stopping the healthy Git
service, and only then removes deployment-owned resources. A deployment that
started from a global npm package restores its exact recorded version. An
adopted or source-based deployment, which has no trustworthy former version,
restores `@karpeleslab/teamclaude@latest`; it never silently substitutes latest
for a recorded exact version.

The displaced service is restored only when its validated backup is npm-backed
and outside the Git deployment root. A legacy service that refers to
`/opt/teamclaude` is not restored because removing that root would make it
invalid.

Every destructive step checks owner markers, regular-file identity, safe
release links, backup hashes, and the exact platform root. An unmarked operator
launcher or service is preserved or causes a preflight refusal. If teardown
fails before its commit boundary, TeamClaude restores the Git service and
launcher, restarts the unchanged release, and checks its health. If root removal
fails after npm and the prior service have been restored, uninstall reports
partial success and lists the remaining path instead of undoing the healthy
replacement.

With `--no-restore-npm`, the global package and prior service are not restored.
The `teamclaude` command is intentionally removed together with the Git
deployment. Config, state, nginx, and retained logs are still preserved.

## Migrating an existing VPS release layout

An existing `/opt/teamclaude` repository, `releases`, `current`, `previous`, and
system service can be adopted in place. First use the legacy operator helper to
deploy a ref that already contains the integrated `teamclaude deploy` command.
Then run from that active release:

```bash
teamclaude deploy install https://github.com/OWNER/teamclaude.git --ref <same-ref>
```

The installer verifies that the existing repository has the same origin and
that every selection link resolves to a direct child of `releases`. It reruns
the candidate tests, replaces the service and launcher with owner-marked
definitions, and writes deployment metadata. It does not reclone the repository
or remove a release. Config, nginx, `current`, `previous`, and releases are not
migrated or rewritten merely to adopt the layout.

Exercise `teamclaude deploy ref`, verify application health, and reboot the VPS
before retiring the legacy helper. Back up `/usr/local/sbin/teamclaude-deploy`
first; remove it only after the integrated commands and reboot startup have both
been verified.

## Reverse proxy

Reverse-proxy management is intentionally outside the deploy command. A typical
nginx upstream remains:

```nginx
location / {
    proxy_pass http://127.0.0.1:3456;
}
```

Keep TeamClaude on loopback when nginx is the only public entry point. An HTTP
`401 Unauthorized` from the public endpoint can be the expected nginx-auth
response; use `teamclaude deploy status` and `teamclaude status` locally to
distinguish proxy authentication from application health.

## Troubleshooting

Inspect recent logs without following:

```bash
teamclaude deploy logs --lines 100 --no-follow
```

Inspect available refs directly when resolution fails:

```bash
git -C /opt/teamclaude/repo fetch --prune --tags origin
git -C /opt/teamclaude/repo branch -r
git -C /opt/teamclaude/repo tag --list
```

If candidate tests fail, the error names the retained release directory. Run
the same command there with the Node path reported by deploy status:

```bash
cd /opt/teamclaude/releases/<candidate-release>
<absolute-node> --test --test-timeout=120000
```

## npm packaging

The npm package still exposes one binary:

```json
{
  "bin": {
    "teamclaude": "src/index.js"
  }
}
```

All deployment modules ship below `src/deploy/`. There is no postinstall hook:
installing the npm package alone does not create a service or mutate deployment
state. The explicit `teamclaude deploy install` command performs the handoff.
