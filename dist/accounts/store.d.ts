import type { Account, Store } from './types.ts';
/**
 * OpenCode's data directory. Honours `XDG_DATA_HOME` the same way OpenCode
 * does, so the store sits next to `auth.json` on every platform we support.
 */
export declare function dataDir(): string;
export declare function storePath(): string;
export declare function statusPath(): string;
export declare function loadStore(): Store;
/**
 * Write the store atomically.
 *
 * `tmp` + `rename` so a concurrent reader never sees a half-written file, and
 * `0600` because this holds refresh tokens.
 */
export declare function saveStore(store: Store): void;
/**
 * Apply `mutate` to the freshest copy of the store, then persist.
 *
 * Re-reads immediately before mutating because several OpenCode servers (and
 * the CLI) can touch the file concurrently; the in-memory copy a caller is
 * holding may already be stale.
 */
export declare function updateStore(mutate: (store: Store) => void): Store;
/**
 * Seed the store from OpenCode's single-slot credential.
 *
 * Runs once, when multi-account support is first enabled: the existing login
 * becomes account #1 so nobody has to re-authenticate to adopt the fork.
 */
export declare function migrateFromOpencodeAuth(): Account | null;
export declare function findAccount(store: Store, needle: string): Account | undefined;
