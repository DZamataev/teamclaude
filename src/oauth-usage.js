// Claude Code reads subscription usage from `GET {ANTHROPIC_BASE_URL}/api/oauth/usage`
// rather than from the rate-limit headers on a completion. The proxy models
// quota internally, so it has to answer that endpoint in the client's shape:
// percentages USED, 0..100 (the quota model keeps fractions 0..1) and ISO-8601
// reset times (the model keeps epoch milliseconds).

// Only the windows Anthropic documents. The model's weeklyFable bucket has no
// field the CLI reads, so it is not translated at all.
const WINDOWS = {
  five_hour: 'fiveHour',
  seven_day: 'weeklyShared',
  seven_day_sonnet: 'weeklySonnet',
};

/**
 * Translate an AccountManager#getQuotaSummary() payload into /api/oauth/usage.
 * @param {any} summary
 * @returns {Record<string, { utilization: number, resets_at?: string }>}
 */
export function oauthUsage(summary) {
  const aggregate = summary?.aggregate ?? {};
  /** @type {Record<string, { utilization: number, resets_at?: string }>} */
  const usage = {};
  for (const [key, field] of Object.entries(WINDOWS)) {
    const bucket = aggregate[field];
    const utilization = Number(bucket?.utilization);
    // An unknown window is left out, never stated as 0%: Max accounts on the
    // unified 7d model have no five-hour bucket, and a zero would claim the
    // client has one with nothing used.
    if (bucket == null || !Number.isFinite(utilization)) continue;
    // Rounded to hundredths of a percent: 0.523 * 100 is 52.300000000000004.
    const percent = Math.round(Math.max(0, Math.min(1, utilization)) * 10000) / 100;
    const resetsAt = Number(bucket.nextResetAt);
    usage[key] = {
      utilization: percent,
      ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resets_at: new Date(resetsAt).toISOString() } : {}),
    };
  }
  return usage;
}
