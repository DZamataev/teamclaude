# Quota

How TeamClaude learns each account's quota, the two optional background jobs, and what happens when everything is spent.

## How quota is observed

TeamClaude is **passive** by default: it reads `anthropic-ratelimit-unified-*` headers off the responses that flow through it. An account that hasn't served a request yet shows unknown quota until rotation first reaches it.

Observed quota is persisted to `teamclaude.state.json` next to the config, so rotation state survives a restart. Stale windows are discarded automatically, and the file is safe to delete — quota is simply re-learned from traffic.

## Fleet quota endpoint

`GET /teamclaude/quota` returns the quota data intended for lightweight consumers such as a Claude Code status line. It includes every account's observed limits plus tier-weighted fleet aggregates for the shared 5-hour window, shared weekly window, Sonnet weekly window, and Fable weekly window. Sonnet and Fable fall back to the shared weekly bucket on accounts where Anthropic does not report a dedicated bucket. Its top-level `warmup` object reports whether keep-warm is off, interval-based, scheduled for a daily reset target, or running on an anchored five-hour cadence. Scheduled modes include the configured timezone, missed-run policy, and next warm-up/reset timestamps; rolling mode also includes `anchorResetAt` and `cadenceSeconds`.

Subscription capacity is weighted relative to Claude Pro: Pro and Team Standard are `1`, Max 5x and Team tier 1 are `5`, and Max 20x and Team tier 2 are `20`. TeamClaude reads the organization and seat tier from the OAuth profile. An unrecognized tier remains visible under `accounts` and `unknownTiers` but is excluded from the aggregate instead of being assigned a guessed weight. API-key token and request limits remain per-account because their units cannot be combined with subscription utilization.

Remote callers authenticate exactly like the other control endpoints:

```bash
curl -H "x-api-key: $TEAMCLAUDE_API_KEY" https://proxy.example.com/teamclaude/quota
```

The optional quota probe also fills missing tier metadata on its first successful refresh. Tier metadata is persisted with observed quota in `teamclaude.state.json`, so it survives subsequent restarts.

The repository includes a ready-to-install [Claude Code status-line snippet](../examples/claude-code-statusline.sh) that reads this endpoint and caches it for 15 seconds. Its first line renders tier-weighted 5-hour and shared weekly fleet usage as color progress bars, with remaining capacity printed beside each bar, and keeps Fable compact as a remaining percentage. Its second line renders each account's remaining capacity with that account's reset countdown. Installation and environment hints are in the [README](../README.md#claude-code-quota-status-line).

## Quota probe

If you'd rather keep idle accounts' quota fresh, enable the background probe:

```bash
teamclaude probe 300    # refresh every 300s
teamclaude probe off    # back to passive (default)
teamclaude probe        # show current setting
```

The **Quota probe** row on the TUI settings screen (`g`) does the same thing, and `p` on the main screen is a one-shot refresh of every account.

It reads each OAuth account's utilization from Anthropic's usage endpoint (`/api/oauth/usage`), which reports quota **without consuming any message quota**. API-key and third-party accounts are skipped. Minimum interval is 30s. Changing it takes effect on a running server immediately.

The probe is also the only source for the **Sonnet 7-day** bucket, when your plan exposes it. The Fable weekly bucket arrives passively in the response headers (`anthropic-ratelimit-unified-7d_oi-*`), so Fable-aware routing works without turning the probe on.

## Keep-warm

The rolling **5-hour session window** only starts once an account sends a real message. So when your active account runs out and rotation moves to a cold account, that account's 5h window starts *then* — right when you need its full headroom. Keep-warm ([#76](https://github.com/KarpelesLab/teamclaude/issues/76)) starts the timer on idle accounts ahead of time, so the next account is already partway (or fully) through a fresh window when it's needed.

```bash
teamclaude warmup 600                                      # warm idle accounts every 600s
teamclaude warmup reset 15:30 --timezone Europe/Moscow     # target a daily 15:30 reset
teamclaude warmup rolling 15:30 --timezone Europe/Moscow   # anchor resets at 15:30, then every 5h
teamclaude warmup off                                      # disable either mode
teamclaude warmup                                          # show current setting
```

> ⚠️ **This spends a little quota — unlike the passive quota probe.** The 5h timer can't be started by a read-only call, so keep-warm sends a real (minimal) message: for each eligible idle account it spawns a one-shot `claude -p --bare --model haiku --output-format text "hi"` pointed at this proxy, pinned to that account. It only warms accounts whose 5h window is **not already running**, skips disabled/throttled/errored and third-party-backend accounts, and uses the cheapest model — but it does consume a few tokens and a slice of the 5h/weekly buckets per account per window. Requires the `claude` CLI on `PATH`. Minimum interval 60s; changes apply live. Status shows under `warm` in `teamclaude status --json`.

Reset mode stores the target wall time and IANA timezone in the config, then subtracts Anthropic's fixed five-hour window to find each warm-up. It recalculates the next calendar occurrence after startup, config reload, and every run, so daylight-saving changes do not drift the schedule. It follows cron semantics: if TeamClaude was stopped at the scheduled time, that run is skipped and the server waits for the next future occurrence. The CLI confirmation prints the resolved local time, UTC time, timezone offset, and next occurrence.

Rolling mode uses the requested local time to save the next reset whose warm-up time has not passed, then schedules warm-ups on the same absolute five-hour cadence indefinitely. The saved anchor keeps the phase stable across service restarts and config reloads. Missed slots are skipped with no catch-up request; TeamClaude waits for the next point on the original cadence. Because 24 hours is not divisible by 5, only the anchor reset occurs at the requested wall time: later reset times move around the local clock, and daylight-saving changes can shift their displayed local time as well. The CLI prints each rolling instant with its own UTC offset and ISO timestamp so repeated DST wall times remain unambiguous. This is best effort: an account with a live five-hour window or an ineligible state is skipped at that slot.

Keep-warm has nothing to do with the prompt cache — see [Prompt caching across rotation](routing.md#prompt-caching-across-rotation).

## Hold on exhaustion

By default, when all accounts are exhausted TeamClaude returns a `429` immediately, which causes Claude Code to abort the current task. With `holdSeconds` set, the proxy **holds the HTTP connection open** instead and polls silently every ~60 seconds; the instant any account's quota resets, the request is forwarded and Claude Code resumes — the interruption never happens.

Set it in the config file (`~/.config/teamclaude.json`):

```json
"holdSeconds": 3600
```

`teamclaude run` automatically raises `API_TIMEOUT_MS` on the spawned Claude Code process to `holdSeconds + 60` seconds, so the client-side timeout covers the full hold window. No manual Claude Code configuration is needed.

Useful for overnight or unattended runs: rather than waking up to a stopped task, the session resumes silently once a quota window opens.
