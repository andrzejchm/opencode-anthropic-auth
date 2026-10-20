---
'@andrzejchm/opencode-anthropic-auth': minor
---

OpenCode v2: optionally pin a session to one Claude account through session metadata `anthropicAccount` (an account label, email or id). Child sessions inherit the pin from their nearest pinned ancestor. A pinned session only uses its account and fails with an error that names the account and its reset time when that account is unavailable. The new `pinnedFallback: true` option falls back to normal selection instead. The OAuth connect method also accepts an optional hidden `accountLabel` answer that labels the new account. Sessions without the key, and connects without the answer, behave exactly as before.
