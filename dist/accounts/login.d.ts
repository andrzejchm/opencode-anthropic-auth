import { type Account, type Config } from './types.ts';
export type Credentials = {
    refresh: string;
    access: string;
    expires: number;
};
/**
 * Add a freshly authorized subscription to the store.
 *
 * Identity comes from `/api/oauth/profile` rather than from anything the user
 * types, so an account cannot be mislabelled. The profile uuid also dedupes:
 * re-authorizing an existing account refreshes it in place instead of adding a
 * duplicate row.
 */
export declare function addAccount(credentials: Credentials, config?: Config): Promise<Account>;
