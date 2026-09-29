import type { Plugin } from '@opencode/plugin';
/**
 * Set up the plugin against an OpenCode v2 `Plugin.Context`.
 *
 * Exported separately from the dual-entrypoint default export (see
 * `index.ts`) so it can be unit-tested against a hand-built mock context
 * without needing a real OpenCode v2 install.
 */
export declare function setup(ctx: Plugin.Context): Promise<Plugin.Cleanup | undefined>;
