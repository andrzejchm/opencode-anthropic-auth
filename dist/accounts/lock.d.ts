/**
 * Run `fn` while holding a cross-process lock.
 *
 * Needed because OpenCode runs a long-lived server while the CLI runs
 * separately, and Anthropic invalidates a refresh token the moment it is
 * exchanged. Two processes refreshing the same account at once therefore
 * revoke each other's credentials. In-process deduplication cannot see that.
 *
 * Falls back to running unlocked rather than failing: a missed lock degrades
 * to the old racy behaviour, while refusing to proceed would break the request
 * outright.
 */
export declare function withLock<T>(name: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T>;
