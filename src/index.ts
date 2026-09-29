import type { Plugin } from '@opencode-ai/plugin'
import { AnthropicAuthPlugin } from './v1.ts'
import { setup as setupV2 } from './v2.ts'

const PLUGIN_ID = 'anthropic-auth'

/**
 * Structural, dependency-free shape of an OpenCode v2 plugin `setup`
 * function. Deliberately *not* `@opencode/plugin`'s `Plugin.Context` type:
 * that package is only a devDependency used for internal type-checking of
 * `v2.ts`, and this file's public `.d.ts` must not force every consumer
 * (including v1-only ones) to have it resolvable.
 */
type V2Setup = (ctx: unknown) => Promise<(() => void) | undefined>

export interface DualEntrypoint {
  /** Read by OpenCode v2's plugin loader (`Plugin.define`-shaped object). */
  readonly id: string
  readonly setup: V2Setup
  /**
   * Read by OpenCode v1's plugin loader when the default export is an
   * object rather than a bare function (object entrypoints, >=1.18.29).
   * `id`/`setup` are ignored by v1; `server` is ignored by v2.
   */
  readonly server: Plugin
}

const anthropicAuthPlugin: DualEntrypoint = {
  id: PLUGIN_ID,
  setup: setupV2 as unknown as V2Setup,
  server: AnthropicAuthPlugin,
}

export default anthropicAuthPlugin

/**
 * Named export kept for backward compatibility with configs/tests that
 * import the v1 factory directly (`import { AnthropicAuthPlugin } from
 * '@andrzejchm/opencode-anthropic-auth'`), and with OpenCode v1 versions
 * older than the object-entrypoint support (<1.18.29) that load a plugin by
 * calling every function-typed export of the module.
 */
export { AnthropicAuthPlugin }
