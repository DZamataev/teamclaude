#!/usr/bin/env bash
# Minimal Claude Code status line for TeamClaude fleet quota.

cat >/dev/null
umask 077

if [ -n "${NO_COLOR:-}" ]; then
    RESET=''; DIM=''; RED=''; GREEN=''; YELLOW=''; CYAN=''
else
    RESET='\033[0m'; DIM='\033[2m'; RED='\033[31m'
    GREEN='\033[32m'; YELLOW='\033[33m'; CYAN='\033[36m'
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
five_hour_reset=$(jq -r '.aggregate.fiveHour.nextResetAt // empty' "$quota_file" 2>/dev/null)
weekly=$(jq -r '.aggregate.weeklyShared.remaining // empty' "$quota_file" 2>/dev/null)
weekly_reset=$(jq -r '.aggregate.weeklyShared.nextResetAt // empty' "$quota_file" 2>/dev/null)
fable=$(jq -r '.aggregate.weeklyFable.remaining // empty' "$quota_file" 2>/dev/null)

output=''
if [ -n "$five_hour" ]; then
    countdown=$(reset_in "$five_hour_reset")
    output="5h $(quota_percent "$five_hour")${countdown:+ $countdown}"
fi
if [ -n "$weekly" ]; then
    countdown=$(reset_in "$weekly_reset")
    output="${output:+$output  }7d $(quota_percent "$weekly")${countdown:+ $countdown}"
fi
[ -n "$fable" ] && output="${output:+$output  }F7 $(quota_percent "$fable")"

[ -n "$output" ] && printf '%bΣ%b %b left\n' "$CYAN" "$RESET" "$output"
