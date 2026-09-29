import { AnthropicAuthPlugin } from "./v1.js";
import { setup as setupV2 } from "./v2.js";
const PLUGIN_ID = 'anthropic-auth';
const anthropicAuthPlugin = {
    id: PLUGIN_ID,
    setup: setupV2,
    server: AnthropicAuthPlugin,
};
export default anthropicAuthPlugin;
/**
 * Named export kept for backward compatibility with configs/tests that
 * import the v1 factory directly (`import { AnthropicAuthPlugin } from
 * '@andrzejchm/opencode-anthropic-auth'`), and with OpenCode v1 versions
 * older than the object-entrypoint support (<1.18.29) that load a plugin by
 * calling every function-typed export of the module.
 */
export { AnthropicAuthPlugin };
