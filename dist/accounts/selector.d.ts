import type { Account, Config, Store } from './types.ts';
export type AccountState = 'active' | 'idle' | 'parked' | 'blocked' | 'error';
/**
 * Utilization we should act on right now.
 *
 * A stored snapshot describes a window that may already have rolled over. Once
 * `reset5h` is in the past the window is empty regardless of what the last
 * reading said, so this is what makes an account come back by itself after its
 * five hours elapse — no polling required.
 */
export declare function effectiveU5h(account: Account, now: number): number;
export declare function effectiveU7d(account: Account, now: number): number;
/**
 * The 5h utilization at which this specific account should hand over.
 *
 * Precedence is most-specific-wins: a value stored on the account (set via
 * `oc-anthropic threshold`) beats a `accountThresholds` entry in config, which
 * beats the global default. Letting each account differ matters because plans
 * differ — a 20x account can safely absorb far more before you step off it
 * than a 5x one.
 */
export declare function thresholdFor(account: Account, config: Config): number;
/** Weekly limit exhausted — the account cannot serve anything until it resets. */
export declare function isBlocked(account: Account, config: Config, now: number): boolean;
/** Under its threshold, not parked, not weekly-blocked. */
export declare function isEligible(account: Account, config: Config, now: number): boolean;
/** Apply the configured rotation order; unlisted accounts keep store order. */
export declare function ordered(store: Store, config: Config): Account[];
export type Selection = {
    account: Account;
    reason: 'eligible' | 'last-resort';
};
/**
 * Pick the account to serve the next request.
 *
 * First choice is the earliest account in rotation order that still has
 * headroom — which means a reset account is picked back up automatically, and
 * in preference to later ones.
 *
 * When nothing has headroom we do not fail: we fall back to the last usable
 * account and keep going until Anthropic actually rejects us. That is the
 * "stay on the last one until it runs out" case.
 */
export declare function select(store: Store, config: Config, now?: number): Selection | null;
export declare function stateOf(account: Account, store: Store, config: Config, now?: number): AccountState;
