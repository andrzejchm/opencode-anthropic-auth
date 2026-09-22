import type { Account } from './types.ts';
export declare function needsRefresh(account: Account, now?: number): boolean;
/**
 * Exchange an account's refresh token for a fresh access token.
 *
 * Deduplicated twice over, because Anthropic invalidates a refresh token the
 * moment it is exchanged, so two simultaneous exchanges revoke each other:
 *
 *  - within the process, concurrent callers share one inflight promise;
 *  - across processes, a file lock plus a re-read covers OpenCode's long-lived
 *    server racing the CLI or a second server.
 */
export declare function refreshAccount(account: Account): Promise<string>;
