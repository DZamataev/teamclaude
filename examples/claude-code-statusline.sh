#!/usr/bin/env bash
# Minimal Claude Code status line for TeamClaude fleet quota.

cat >/dev/null
umask 077

if [ -n "${NO_COLOR:-}" ]; then
    RESET=''; BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; CYAN=''; USE_COLOR=0
else
    RESET='\033[0m'; BOLD='\033[1m'; DIM='\033[2m'; RED='\033[31m'
    GREEN='\033[32m'; YELLOW='\033[33m'; CYAN='\033[36m'; USE_COLOR=1
fi

quota_color() {
    if [ "$1" -lt 10 ]; then printf '%s' "$RED"
    elif [ "$1" -le 30 ]; then printf '%s' "$YELLOW"
    else printf '%s' "$GREEN"; fi
}

quota_percent() {
    local percent
    percent=$(awk -v value="$1" 'BEGIN {printf "%.0f", value * 100}')
    printf '%b%s%%%b' "$(quota_color "$percent")" "$percent" "$RESET"
}

usage_bar() {
    awk -v remaining="$1" -v color="$USE_COLOR" 'BEGIN {
        width = 18
        remaining = remaining + 0
        if (remaining < 0) remaining = 0
        if (remaining > 1) remaining = 1
        filled = int((1 - remaining) * width + 0.5)
        printf "["
        for (i = 0; i < filled; i++) {
            t = width <= 1 ? 1 : i / (width - 1)
            if (t < 0.5) {
                p = t * 2
                r = int(35 + (245 - 35) * p + 0.5)
                g = int(209 + (185 - 209) * p + 0.5)
                b = int(96 + (40 - 96) * p + 0.5)
            } else {
                p = (t - 0.5) * 2
                r = int(245 + (239 - 245) * p + 0.5)
                g = int(185 + (68 - 185) * p + 0.5)
                b = int(40 + (68 - 40) * p + 0.5)
            }
            if (color) printf "\033[38;2;%d;%d;%dm", r, g, b
            printf "█"
        }
        if (color && filled < width) printf "\033[90m"
        for (i = filled; i < width; i++) printf "░"
        if (color) printf "\033[0m"
        printf "]"
    }'
}

reset_in() {
    local reset_at="$1" reset_seconds minutes days hours
    [[ "$reset_at" =~ ^[0-9]+$ ]] || return
    reset_seconds="$reset_at"
    [ "$reset_seconds" -ge 100000000000 ] && reset_seconds=$((reset_seconds / 1000))
    minutes=$(( (reset_seconds - $(date +%s) + 59) / 60 ))
    [ "$minutes" -gt 0 ] || return

    days=$((minutes / 1440))
    hours=$((minutes % 1440 / 60))
    minutes=$((minutes % 60))
    if [ "$days" -gt 0 ]; then
        printf '%b↻%dd' "$DIM" "$days"
        [ "$hours" -gt 0 ] && printf '%dh' "$hours"
    elif [ "$hours" -gt 0 ]; then
        printf '%b↻%dh%dm' "$DIM" "$hours" "$minutes"
    else
        printf '%b↻%dm' "$DIM" "$minutes"
    fi
    printf '%b' "$RESET"
}

command -v curl >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

base_url="${TEAMCLAUDE_BASE_URL:-${ANTHROPIC_BASE_URL:-http://127.0.0.1:3456}}"
api_key="${TEAMCLAUDE_API_KEY:-${ANTHROPIC_API_KEY:-}}"
cache_file="${TEAMCLAUDE_QUOTA_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/teamclaude/statusline-quota.json}"
cache_dir=${cache_file%/*}
[ "$cache_dir" = "$cache_file" ] || mkdir -p "$cache_dir" 2>/dev/null || exit 0

now=$(date +%s)
cache_mtime=$(stat -f %m "$cache_file" 2>/dev/null || stat -c %Y "$cache_file" 2>/dev/null || printf 0)
quota_file=''
if [ -f "$cache_file" ] && [ $((now - cache_mtime)) -lt 15 ]; then
    quota_file="$cache_file"
else
    temp_file="${cache_file}.$$"
    quota_url="${base_url%/}/teamclaude/quota"
    if [ -n "$api_key" ]; then
        printf 'header = "x-api-key: %s"\n' "$api_key" \
            | curl --config - --fail --silent --show-error --connect-timeout 1 --max-time 1 "$quota_url" \
                >"$temp_file" 2>/dev/null
    else
        curl --fail --silent --show-error --connect-timeout 1 --max-time 1 "$quota_url" \
            >"$temp_file" 2>/dev/null
    fi
    if [ $? -eq 0 ] && jq -e '.aggregate | type == "object"' "$temp_file" >/dev/null 2>&1; then
        mv "$temp_file" "$cache_file"
        quota_file="$cache_file"
    else
        rm -f "$temp_file"
    fi
fi

[ -n "$quota_file" ] || exit 0

five_hour=$(jq -r '.aggregate.fiveHour.remaining // empty' "$quota_file" 2>/dev/null)
weekly=$(jq -r '.aggregate.weeklyShared.remaining // empty' "$quota_file" 2>/dev/null)
fable=$(jq -r '.aggregate.weeklyFable.remaining // empty' "$quota_file" 2>/dev/null)

aggregate_output=''
if [ -n "$five_hour" ]; then
    aggregate_output="5h $(usage_bar "$five_hour") $(quota_percent "$five_hour")"
fi
if [ -n "$weekly" ]; then
    aggregate_output="${aggregate_output:+$aggregate_output ${DIM}│${RESET} }7d $(usage_bar "$weekly") $(quota_percent "$weekly")"
fi
[ -n "$fable" ] && aggregate_output="${aggregate_output:+$aggregate_output ${DIM}│${RESET} }F7d $(quota_percent "$fable")"

accounts_output=''
while IFS= read -r account; do
    label=$(jq -r '
        if (.tier.seatTier // "") == "team_standard" then "Team"
        elif (.tier.rateLimitTier // "") | test("_max_[0-9]+x$") then
            "Max" + ((.tier.rateLimitTier | capture("_max_(?<multiple>[0-9]+)x$")).multiple)
        else .name
        end
    ' <<<"$account" 2>/dev/null)
    account_five=$(jq -r '.buckets.fiveHour.remaining // empty' <<<"$account" 2>/dev/null)
    account_five_reset=$(jq -r '.buckets.fiveHour.resetAt // empty' <<<"$account" 2>/dev/null)
    account_weekly=$(jq -r '.buckets.weeklyShared.remaining // empty' <<<"$account" 2>/dev/null)
    account_weekly_reset=$(jq -r '.buckets.weeklyShared.resetAt // empty' <<<"$account" 2>/dev/null)
    account_fable=$(jq -r '.buckets.weeklyFable.remaining // empty' <<<"$account" 2>/dev/null)
    account_fable_reset=$(jq -r '.buckets.weeklyFable.resetAt // empty' <<<"$account" 2>/dev/null)
    account_fable_source=$(jq -r '.buckets.weeklyFable.source // empty' <<<"$account" 2>/dev/null)

    account_cells=''
    if [ -n "$account_five" ]; then
        countdown=$(reset_in "$account_five_reset")
        account_cells="5h $(quota_percent "$account_five")${countdown:+ $countdown}"
    fi
    if [ -n "$account_weekly" ]; then
        countdown=$(reset_in "$account_weekly_reset")
        account_cells="${account_cells:+$account_cells ${DIM}·${RESET} }7d $(quota_percent "$account_weekly")${countdown:+ $countdown}"
    fi
    if [ -n "$account_fable" ] && [ "$account_fable_source" = "unified7dFable" ]; then
        countdown=$(reset_in "$account_fable_reset")
        account_cells="${account_cells:+$account_cells ${DIM}·${RESET} }F7d $(quota_percent "$account_fable")${countdown:+ $countdown}"
    fi
    [ -z "$account_cells" ] && continue
    accounts_output="${accounts_output:+$accounts_output ${DIM}│${RESET} }${BOLD}${label}${RESET} ${account_cells}"
done < <(jq -c '.accounts[]? | select(.disabled != true)' "$quota_file" 2>/dev/null)

if [ -n "$aggregate_output" ]; then
    printf '%bΣ%b %b left\n' "$CYAN" "$RESET" "$aggregate_output"
    [ -n "$accounts_output" ] && printf '  %b\n' "$accounts_output"
fi
