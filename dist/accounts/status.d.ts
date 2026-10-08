import type { Config, Store } from './types.ts';
export type StatusRow = {
    order: number;
    id: string;
    label: string;
    org: string | null;
    tier: string | null;
    state: string;
    /** Effective 5h switch threshold for this account (0..1). */
    threshold: number;
    /** Effective 7d weekly threshold for this account (0..1). */
    weeklyThreshold: number;
    /**
     * True when the reading predates the window it describes, so `u5h` is an
     * optimistic guess rather than an observation.
     */
    stale: boolean;
    u5h: number;
    resets5h: string | null;
    u7d: number;
    /** When the 7d window rolls over, or null if unknown. */
    resets7d: string | null;
    /** 7d utilization the account should have reached by now (0..1), or null if unknown. */
    paceTarget: number | null;
    /** Whether weekly pacing is enforced for this account (own setting, else global). */
    pacing: boolean;
    lastUsed: string | null;
    error: string | null;
};
export type Status = {
    updatedAt: string;
    active: string | null;
    switchThreshold: number;
    weeklyThreshold: number;
    weeklyPacing: boolean;
    accounts: StatusRow[];
};
export declare function buildStatus(store: Store, config: Config, now?: number): Status;
/**
 * Mirror the store to a secret-free file.
 *
 * Derived on every write rather than maintained separately, so it cannot drift
 * from the store. This is the file to `cat`, `jq` or `watch` — the store itself
 * holds refresh tokens and is not meant to be read by a human.
 */
export declare function writeStatus(store: Store, config: Config): void;
