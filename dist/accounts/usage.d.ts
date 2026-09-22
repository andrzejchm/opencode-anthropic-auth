import type { Profile, Usage } from './types.ts';
/**
 * Read usage off a real API response.
 *
 * Anthropic stamps `anthropic-ratelimit-unified-*` on every `/v1/messages`
 * response, so the common path costs nothing: no polling, no added latency.
 * Returns `null` when the headers are absent (non-inference endpoints).
 */
export declare function parseUsageHeaders(headers: Headers): Usage | null;
/** Is this response Anthropic telling us the account is out of headroom? */
export declare function isLimitResponse(response: Response, body: string): boolean;
/** Unix seconds when the limit that just rejected us lifts, if stated. */
export declare function resetFromResponse(response: Response): number;
/**
 * Poll usage directly.
 *
 * Only needed for accounts with no recorded usage — once an account has served
 * a request, its response headers keep the snapshot current for free.
 */
export declare function probeUsage(access: string): Promise<Usage | null>;
/** Identify the subscription behind a token, so accounts label themselves. */
export declare function fetchProfile(access: string): Promise<Profile | null>;
