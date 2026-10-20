import type { Plugin } from '@opencode/plugin';
/** Session metadata key that pins a session to one account. */
export declare const PIN_METADATA_KEY = "anthropicAccount";
/** Hidden OAuth form field an API client can use to label a new account. */
export declare const ACCOUNT_LABEL_FIELD = "accountLabel";
type SessionLookup = (sessionID: string) => Promise<{
    readonly parentID?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
} | undefined>;
/**
 * Resolve the account a session is pinned to, or `null` when it isn't.
 *
 * The pin is the session's `metadata.anthropicAccount`. Subagent sessions are
 * created without the parent's metadata, so a session without the key
 * inherits from the nearest ancestor that has it. Results (including "not
 * pinned") are cached per session, least-recently-used first out, so steady
 * state costs no lookups. A failed lookup is not cached.
 */
export declare function createPinResolver(lookup: SessionLookup, limit?: number): (sessionID: string) => Promise<string | null>;
/**
 * Set up the plugin against an OpenCode v2 `Plugin.Context`.
 *
 * Exported separately from the dual-entrypoint default export (see
 * `index.ts`) so it can be unit-tested against a hand-built mock context
 * without needing a real OpenCode v2 install.
 */
export declare function setup(ctx: Plugin.Context): Promise<Plugin.Cleanup | undefined>;
export {};
