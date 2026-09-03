# Git deployment

This page describes the release-based Linux deployment used for running a
TeamClaude Git fork behind systemd. It supports switching between remote
branches, tags, and commits while keeping the last healthy release available
for rollback.

This is different from the global npm installation described in the quick
start. The deployment helper is currently installed by the server operator; it
is **not** included in the `@karpeleslab/teamclaude` npm package.

## What is installed

The deployment uses these paths:

```text
/opt/teamclaude/
├── repo/                    # persistent clone of the Git fork
├── releases/                # detached worktrees, one per deployment
├── current -> releases/...  # active, last successfully deployed release
└── previous -> releases/... # release that was active before current

/etc/systemd/system/teamclaude.service
/usr/local/bin/teamclaude
/usr/local/sbin/teamclaude-deploy
/usr/local/libexec/teamclaude-node
```

The `teamclaude` command is a small wrapper around the active
`current/src/index.js`. The service and terminal command therefore use the same
code. `teamclaude-node` points at the absolute Node.js executable selected when
the deployment was installed.

The account configuration and runtime quota state stay outside Git:

```text
/root/.config/teamclaude.json
/root/.config/teamclaude.state.json
```

Deploying another ref does not replace either file.

## Requirements

- Linux with systemd
- Git
- Node.js 20 or newer
- A remote Git repository reachable by the VPS
- A valid TeamClaude config containing at least one account
- Root access for updating the system service

The reference deployment uses an NVM Node installation. The systemd unit keeps
the matching NVM directory on `PATH`, so TeamClaude can also find programs such
as `claude` when it launches them.

## Everyday commands

Show the active proxy status:

```bash
teamclaude status
```

Follow service logs:

```bash
journalctl -u teamclaude.service -f
```

Restart the active release without changing it:

```bash
systemctl restart teamclaude.service
```

Check service startup configuration:

```bash
systemctl is-enabled teamclaude.service
systemctl is-active teamclaude.service
systemctl show teamclaude.service -p ExecStart -p WorkingDirectory
```

An enabled system-level unit under `multi-user.target` starts the selected
`current` release after a VPS reboot.

## Deploy a branch, tag, or commit

Deploy the default branch:

```bash
teamclaude-deploy master
```

Deploy another remote branch:

```bash
teamclaude-deploy my-feature
```

Deploy a tag or commit:

```bash
teamclaude-deploy v1.2.0
teamclaude-deploy 0123456789abcdef
```

A local development branch must be pushed to the configured `origin` before
the VPS can deploy it:

```bash
git push -u origin my-feature
ssh root@your-vps teamclaude-deploy my-feature
```

The helper performs the following sequence:

1. Fetches branches and tags from `origin`.
2. Resolves the requested ref to an immutable commit.
3. Creates a detached worktree below `/opt/teamclaude/releases`.
4. Runs the complete Node test suite.
5. Records the old `current` release as `previous`.
6. Atomically switches `current` to the candidate.
7. Restarts `teamclaude.service`.
8. Checks both systemd state and `teamclaude status`.

Fetch, ref-resolution, worktree, or test failures leave the running release
untouched. A failed service health check switches `current` back to the former
release and restarts it automatically. The command exits non-zero whenever the
candidate was not activated.

The restart creates a short interruption, normally a few seconds. A reverse
proxy may remain online during that interval, but requests reaching TeamClaude
can fail until the health check passes.

## Inspect the active and previous releases

```bash
readlink -f /opt/teamclaude/current
git -C /opt/teamclaude/current rev-parse HEAD

readlink -f /opt/teamclaude/previous
git -C /opt/teamclaude/previous rev-parse HEAD
```

Confirm Git provenance:

```bash
git -C /opt/teamclaude/current remote get-url origin
git -C /opt/teamclaude/current log -1 --oneline
```

## Roll back

The normal rollback is another tested deployment of a known-good ref:

```bash
teamclaude-deploy <known-good-branch-tag-or-commit>
```

If the Git remote is unavailable and an emergency rollback is required, point
`current` at the already-tested `previous` worktree and restart the service:

```bash
previous="$(readlink -f /opt/teamclaude/previous)"
test -n "$previous"
test -f "$previous/src/index.js"
ln -s "$previous" "/opt/teamclaude/current.next.$$"
mv -Tf "/opt/teamclaude/current.next.$$" /opt/teamclaude/current
systemctl restart teamclaude.service
teamclaude status
```

Always verify status after a manual rollback. The deployment helper is preferred
because it also runs tests, records the release transition, and performs health
verification.

## Reverse proxy

TeamClaude listens on the loopback address by default. A typical nginx upstream
is:

```nginx
location / {
    proxy_pass http://127.0.0.1:3456;
}
```

Keep the TeamClaude listener on loopback when nginx is the only public entry
point. If TeamClaude is bound to a non-loopback interface instead, configure
`proxy.apiKey`; remote clients must not have unauthenticated access to a proxy
that injects account credentials.

An HTTP `401 Unauthorized` from the public nginx endpoint can be the expected
result when nginx authentication is enabled. Check the local TeamClaude status
separately to distinguish proxy authentication from an unhealthy application:

```bash
teamclaude status
curl -fsS http://127.0.0.1:3456/teamclaude/status
```

## Logs and troubleshooting

Show recent service failures:

```bash
systemctl status teamclaude.service --no-pager
journalctl -u teamclaude.service -n 100 --no-pager
```

Validate the installed unit and deployment script:

```bash
systemd-analyze verify /etc/systemd/system/teamclaude.service
bash -n /usr/local/sbin/teamclaude-deploy
```

If a ref cannot be resolved:

```bash
git -C /opt/teamclaude/repo fetch --prune --tags origin
git -C /opt/teamclaude/repo branch -r
git -C /opt/teamclaude/repo tag --list
```

If a deployment stops at the test step, run the same suite in the candidate
release shown in its output:

```bash
cd /opt/teamclaude/releases/<candidate-release>
/usr/local/libexec/teamclaude-node --test --test-timeout=120000
```

If the terminal cannot find `teamclaude-deploy`, verify whether
`/usr/local/sbin` is on `PATH`:

```bash
command -v teamclaude-deploy
print -r -- $path  # zsh
```

For zsh, add it when necessary:

```zsh
path=(/usr/local/sbin $path)
export PATH
```

The reference VPS uses Bash as root's login shell. Zsh must be installed and
configured separately if it is preferred.

## Backups and old releases

The initial migration stores the former systemd and nginx files below:

```text
/root/teamclaude-migration-backup/<UTC timestamp>/
```

Do not delete `current` or `previous`. Older detached worktrees can be listed
and removed explicitly:

```bash
git -C /opt/teamclaude/repo worktree list
git -C /opt/teamclaude/repo worktree remove /opt/teamclaude/releases/<old-release>
git -C /opt/teamclaude/repo worktree prune
```

Check both symlink targets before removing an old release.

## npm packaging status

The current npm package contains `src/` and exposes one binary:

```json
{
  "bin": {
    "teamclaude": "src/index.js"
  }
}
```

Consequently, `npm install -g @karpeleslab/teamclaude` does not install
`teamclaude-deploy`, the Git release layout, or the systemd unit. Adding that
behavior upstream requires a separately designed cross-platform installer or
additional npm binary. Until such a feature is released, treat
`teamclaude-deploy` as operator-managed VPS tooling.

Installing the global npm package is unnecessary for this layout. The service
and `teamclaude` wrapper both run the source selected by `current`.
