import { type Account, type Config } from './types.ts';
import { isLimitResponse } from './usage.ts';
export type Logger = (level: 'info' | 'warn' | 'error', message: string) => void;
/** Read plugin options, falling back to env vars and then defaults. */
export declare function resolveConfig(options?: Record<string, unknown>): Config;
/** `0.8` and `80` both mean 80%. Returns null for anything unusable. */
export declare function normalizeThreshold(value: unknown): number | null;
/** `on`/`off` (also true/false, 1/0) for a CLI argument. Null for anything else. */
export declare function parsePacing(value: string): boolean | null;
export type Manager = {
    /** Number of accounts available, used to bound retries. */
    size: () => number;
    /** Pick an account and guarantee it has a usable access token. */
    acquire: () => Promise<Account | null>;
    /**
     * Use only the account a session is pinned to (by id, label or email).
     * Throws `PinnedAccountError` rather than picking another account.
     */
    acquirePinned: (pin: string) => Promise<Account>;
    /** Fold a response's rate-limit headers back into the store. */
    record: (account: Account, response: Response) => void;
    /** Mark an account exhausted so the next attempt moves on. */
    park: (account: Account, response: Response, body: string) => void;
    isLimit: typeof isLimitResponse;
};
export type PinnedAccountReason = 'not-found' | 'parked' | 'weekly-limit' | 'refresh-failed';
/** A session's pinned account can't serve this request. */
export declare class PinnedAccountError extends Error {
    readonly pin: string;
    readonly reason: PinnedAccountReason;
    /** Epoch ms when the account should be usable again, if known. */
    readonly until: number | null;
    /** Label of the matched account, when there is one. */
    readonly label?: string | undefined;
    /** First sentence of the message: which account, what's wrong, until when. */
    readonly summary: string;
    constructor(pin: string, reason: PinnedAccountReason, 
    /** Epoch ms when the account should be usable again, if known. */
    until: number | null, 
    /** Label of the matched account, when there is one. */
    label?: string | undefined);
}
export declare function createManager(config: Config, log: Logger): Manager;
/**
 * Name an account from its own profile, so labels can't be mixed up.
 *
 * Also adopts Anthropic's account uuid as the local id. Imported and
 * locally-generated ids would otherwise let the same subscription be added
 * twice, since `addAccount` dedupes on the profile uuid.
 */
export declare function labelAccount(account: Account, config: Config): Promise<void>;
