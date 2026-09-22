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
    u5h: number;
    resets5h: string | null;
    u7d: number;
    lastUsed: string | null;
    error: string | null;
};
export type Status = {
    updatedAt: string;
    active: string | null;
    switchThreshold: number;
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
