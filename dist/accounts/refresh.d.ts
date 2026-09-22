import type { Account } from './types.ts';
export declare function needsRefresh(account: Account, now?: number): boolean;
/**
 * Exchange an account's refresh token for a fresh access token.
 *
 * Deduplicated per account: concurrent requests share one inflight refresh,
 * because Anthropic rotates the refresh token on every exchange and racing
 * exchanges invalidate each other.
 */
export declare function refreshAccount(account: Account): Promise<string>;
