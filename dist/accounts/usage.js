import { USER_AGENT } from "../constants.js";
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
function oauthHeaders(access) {
    return {
        authorization: `Bearer ${access}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': USER_AGENT,
    };
}
function num(value) {
    if (!value)
        return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
/**
 * Read usage off a real API response.
 *
 * Anthropic stamps `anthropic-ratelimit-unified-*` on every `/v1/messages`
 * response, so the common path costs nothing: no polling, no added latency.
 * Returns `null` when the headers are absent (non-inference endpoints).
 */
export function parseUsageHeaders(headers) {
    const u5h = num(headers.get('anthropic-ratelimit-unified-5h-utilization'));
    if (u5h === null)
        return null;
    return {
        u5h,
        reset5h: num(headers.get('anthropic-ratelimit-unified-5h-reset')) ?? 0,
        u7d: num(headers.get('anthropic-ratelimit-unified-7d-utilization')) ?? 0,
        reset7d: num(headers.get('anthropic-ratelimit-unified-7d-reset')) ?? 0,
        at: Date.now(),
    };
}
/** Is this response Anthropic telling us the account is out of headroom? */
export function isLimitResponse(response, body) {
    if (response.status === 429)
        return true;
    if (headersSayRejected(response.headers))
        return true;
    if (response.status !== 400)
        return false;
    const lowered = body.toLowerCase();
    return (lowered.includes('usage limit') ||
        lowered.includes('rate_limit') ||
        lowered.includes('out of extra usage'));
}
function headersSayRejected(headers) {
    return headers.get('anthropic-ratelimit-unified-5h-status') === 'rejected';
}
/** Unix seconds when the limit that just rejected us lifts, if stated. */
export function resetFromResponse(response) {
    return (num(response.headers.get('anthropic-ratelimit-unified-5h-reset')) ??
        num(response.headers.get('anthropic-ratelimit-unified-reset')) ??
        0);
}
/**
 * Poll usage directly.
 *
 * Only needed for accounts with no recorded usage — once an account has served
 * a request, its response headers keep the snapshot current for free.
 */
export async function probeUsage(access) {
    try {
        const response = await fetch(USAGE_URL, { headers: oauthHeaders(access) });
        if (!response.ok)
            return null;
        const json = (await response.json());
        const seconds = (iso) => iso ? Math.floor(new Date(iso).getTime() / 1000) : 0;
        return {
            // This endpoint reports percentages; the headers report fractions.
            u5h: (json.five_hour?.utilization ?? 0) / 100,
            reset5h: seconds(json.five_hour?.resets_at),
            u7d: (json.seven_day?.utilization ?? 0) / 100,
            reset7d: seconds(json.seven_day?.resets_at),
            at: Date.now(),
        };
    }
    catch {
        return null;
    }
}
/** Identify the subscription behind a token, so accounts label themselves. */
export async function fetchProfile(access) {
    try {
        const response = await fetch(PROFILE_URL, { headers: oauthHeaders(access) });
        if (!response.ok)
            return null;
        const json = (await response.json());
        if (!json.account?.uuid || !json.account.email)
            return null;
        return {
            uuid: json.account.uuid,
            email: json.account.email,
            org: json.organization?.name ?? null,
            // `default_claude_max_5x` → `max_5x`; keep anything unrecognised verbatim.
            tier: json.organization?.rate_limit_tier?.replace(/^default_claude_/, '') ??
                null,
        };
    }
    catch {
        return null;
    }
}
