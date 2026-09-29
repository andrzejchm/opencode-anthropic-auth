---
'@andrzejchm/opencode-anthropic-auth': minor
---

Support OpenCode v2 from the same package. The default export is now `{ id, setup, server }`: OpenCode v1 (>=1.18.29) loads `server` (the existing v1 plugin factory, unchanged), and OpenCode v2 loads `id`/`setup` (a `Plugin.define`-shaped object) and ignores `server`. `AnthropicAuthPlugin` is still exported by name for anything importing it directly.

The v2 adapter registers the Claude Pro/Max OAuth method and rewrites requests/responses through the `http.request`/`http.response` session hooks, scoped to the `anthropic` provider. It reuses this fork's multi-account rotation, per-account thresholds, weekly pacing, and cross-process refresh locking unchanged, and shares the same account store as v1 — logging in or checking `oc-anthropic status` behaves the same regardless of which OpenCode major version is running.

`ANTHROPIC_BASE_URL` and `ANTHROPIC_CLAUDE_CODE_VERSION` work the same on both. `ANTHROPIC_INSECURE` remains v1-only — OpenCode v2's request hooks cannot disable TLS verification — and the plugin logs a warning rather than silently ignoring it.

`@opencode/plugin` is a new devDependency used only for type-checking the v2 adapter; it is not a runtime dependency and is never imported as a value, so it has no effect on the v1 path.
