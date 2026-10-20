import { type Account, type Config } from './types.ts';
export type Credentials = {
    refresh: string;
    access: string;
    expires: number;
};
/** A label given at connect time is already used by a different account. */
export declare class LabelConflictError extends Error {
    readonly label: string;
    constructor(label: string);
}
export type AddAccountOptions = {
    /**
     * Label chosen by whoever connected the account. Without one the label
     * comes from the profile email, exactly as before this option existed.
     */
    label?: string;
};
/**
 * Add a freshly authorized subscription to the store.
 *
 * Identity comes from `/api/oauth/profile` rather than from anything the user
 * types, so an account cannot be mislabelled. The profile uuid also dedupes:
 * re-authorizing an existing account refreshes it in place instead of adding a
 * duplicate row. A label passed in `options` only names the row; identity is
 * still the profile uuid.
 */
export declare function addAccount(credentials: Credentials, config?: Config, options?: AddAccountOptions): Promise<Account>;
