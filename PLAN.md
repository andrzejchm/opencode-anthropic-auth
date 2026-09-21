# Multi-Account Rotation — Implementation Plan

Fork of `ex-machina-co/opencode-anthropic-auth` (MIT). Goal: authenticate several
Claude Max subscriptions at once and rotate between them based on 5-hour limit
utilization.

## 1. Feasibility (verified, not assumed)

| Question | Answer | Evidence |
|---|---|---|
| Can we swap credentials per request? | Yes | The plugin owns the entire `fetch` in `src/index.ts` `auth.loader`. The `Authorization` header is set by us in `setOAuthHeaders`. |
| Can we read 5-hour usage? | Yes, for free | Every `/v1/messages` response carries `anthropic-ratelimit-unified-5h-utilization` (0–1), `-5h-reset` (unix s), `-5h-status`, plus `7d` equivalents. Verified live. |
| Can we read usage without spending a request? | Yes | `GET https://api.anthropic.com/api/oauth/usage` with the OAuth bearer returns `five_hour: { utilization, resets_at }`, `seven_day: {...}`, and a `limits[]` array. Verified live. |
| Can we store N accounts? | Yes | OpenCode's auth store is one-credential-per-provider, but the plugin can keep its own store and only mirror the active account back. |
| Can we log in N times? | Yes | `auth.methods[].prompts` supports `text`/`select` inputs, and the OAuth `callback` is our code — we append to our store instead of replacing. |
| Can we label accounts reliably? | Yes, automatically | `GET /api/oauth/profile` returns `account.email`, `account.uuid`, `organization.name`, `rate_limit_tier` per token. Verified live. |
| Can we see what's active without a TUI? | Yes | The plugin runs in the OpenCode server, so a secret-free status file plus a `bin` CLI covers web and desktop equally. |

**Verdict: doable.** The rate-limit response headers make this much cheaper than
expected — no polling loop required on the hot path.

### Risk that is not technical

Rotating multiple subscriptions to extend past a plan's limits is a plausible
ToS violation on each account, and the upstream README already warns that heavy
or automated usage patterns have triggered bans. This plan does not make that
risk go away.

## 2. Selection algorithm

State per account: `utilization5h`, `reset5h`, `utilization7d`, `reset7d`,
`parkedUntil`, `lastSeenAt`.

```
eligible(a) = now >= a.parkedUntil
           && a.utilization5h < threshold      // default 0.60
           && a.utilization7d < weeklyThreshold // default 0.98

select():
  fresh = accounts in configured order, refreshed from cache/headers
  pick first eligible(a)                       -> use it
  if none eligible:
    pick the last account in order that is not hard-blocked
    (this is the "stay on the last one until it runs out" case)
  if all hard-blocked:
    pick the one with the earliest reset, surface the wait time
```

Parking (prevents flip-flop): when we leave account `a` because it crossed the
threshold, set `a.parkedUntil = a.reset5h`. It becomes eligible again only once
its window has genuinely rolled over — which is exactly the "switch back when a
previous one resets" requirement, and avoids oscillating around the 60% mark.

Prompt caching is per-account, so each switch forces a full cache-miss re-read of
the conversation. Switching only at request boundaries plus parking keeps the
number of switches to roughly one per account per 5-hour window.

## 3. Usage tracking

1. **Hot path (free):** after every response in `fetch`, parse
   `anthropic-ratelimit-unified-*` headers and write them to the active
   account's state. No extra latency, no extra requests.
2. **Cold start / parked accounts:** `resets_at` alone tells us deterministically
   when a parked account frees up, so usually no probe is needed. Probe
   `/api/oauth/usage` only when an account has no state at all, or state older
   than its own reset window.
3. **Hard failure:** on `429` or a usage-limit `400`, park the account using the
   response's reset header, switch, and retry the request once on the next
   account. Retry at most `n_accounts` times per request.

## 4. Storage

New file `~/.local/share/opencode/anthropic-accounts.json`:

```jsonc
{
  "version": 1,
  "accounts": [
    {
      "id": "uuid",
      "label": "work",
      "refresh": "sk-ant-ort01-…",
      "access": "sk-ant-oat01-…",
      "expires": 1790046622352,
      "usage": { "u5h": 0.06, "reset5h": 1790035800, "u7d": 0.27, "reset7d": 1790031600, "at": 1790000000000 },
      "parkedUntil": 0
    }
  ]
}
```

- Atomic writes (`tmp` + `rename`), re-read before every write — several OpenCode
  instances may run concurrently.
- Token refresh becomes per-account and writes here, not to OpenCode's store.
- The **active** account is mirrored into OpenCode's `anthropic` auth entry so
  OpenCode still considers the provider authenticated and keeps calling `loader`.
- **Migration:** on first run, if this store is empty but OpenCode already holds
  an `anthropic` oauth credential, import it as account #1. No re-login needed.

## 5. Visibility and management (no TUI)

The server plugin runs inside the OpenCode server, not the client, so rotation
works identically for the web and desktop apps. Everything below is therefore
either a file on disk or a terminal command — no TUI plugin is built.

### 5a. Labels are automatic

`GET https://api.anthropic.com/api/oauth/profile` with an account's bearer
returns its identity (verified live):

```jsonc
{
  "account":      { "email": "andrzej@stikky.co", "full_name": "Andrzej" },
  "organization": { "name": "Latori", "rate_limit_tier": "default_claude_max_5x",
                    "subscription_status": "active" }
}
```

So every account self-labels as `andrzej@stikky.co (Latori · max_5x)` at login
time. No prompt to fill in, and no chance of mislabelling which credential is
which. A manual override is still available via the CLI.

The `account.uuid` is also the stable identity key — better than a
user-typed label for dedupe, and it catches "logged the same account in twice".

### 5b. The file to look into

Two files, because one of them holds tokens and the other is meant to be read:

`~/.local/share/opencode/anthropic-accounts.json` — the store, mode `0600`,
holds `refresh`/`access` per account. Not intended for eyeballing.

`~/.local/share/opencode/anthropic-status.json` — **secret-free**, rewritten on
every switch and every usage update, derived from the store so it cannot drift:

```jsonc
{
  "updatedAt": "2026-09-21T19:15:35Z",
  "active": "andrzej@stikky.co",
  "accounts": [
    { "order": 1, "label": "andrzej@stikky.co", "org": "Latori", "tier": "max_5x",
      "state": "parked",  "u5h": 0.63, "resets5h": "2026-09-22T00:10:00Z",
      "u7d": 0.28, "lastUsed": "2026-09-21T19:14:02Z" },
    { "order": 2, "label": "andrzej@personal.com", "org": null, "tier": "max_20x",
      "state": "active",  "u5h": 0.11, "resets5h": "2026-09-22T02:40:00Z",
      "u7d": 0.04, "lastUsed": "2026-09-21T19:15:35Z" },
    { "order": 3, "label": "spare@example.com", "org": null, "tier": "max_5x",
      "state": "idle",    "u5h": 0.00, "resets5h": null, "u7d": 0.00, "lastUsed": null }
  ]
}
```

`cat` it, `jq` it, `watch` it, or point a status bar at it. `state` is one of
`active` / `idle` / `parked` (over threshold, waiting for its 5h reset) /
`blocked` (weekly limit) / `error`.

### 5c. The CLI

A `bin` on the package — `oc-anthropic` — installed once with `bun link` from
the fork checkout. It operates on the same store, so it works whether or not
OpenCode is running.

| Command | Purpose |
|---|---|
| `oc-anthropic status` | default; prints the table below |
| `oc-anthropic login` | full OAuth flow, appends a new account, auto-labels it |
| `oc-anthropic order <label>...` | set rotation order |
| `oc-anthropic label <label> <new>` | override the auto-label |
| `oc-anthropic use <label>` | force-switch now, ignoring thresholds |
| `oc-anthropic remove <label>` | drop an account |
| `oc-anthropic refresh` | force-poll `/api/oauth/usage` for every account |

```
$ oc-anthropic status
  #  ACCOUNT                        ORG      TIER     5H     RESETS IN   7D    STATE
  1  andrzej@stikky.co              Latori   max_5x   63%    4h 54m      28%   parked
> 2  andrzej@personal.com           —        max_20x  11%    7h 24m       4%   ACTIVE
  3  spare@example.com              —        max_5x    0%    —            0%   idle
```

`oc-anthropic login` matters more than it looks: it means accounts 2 and 3 never
have to go through `opencode auth login`, so OpenCode's single-slot auth store
stops being part of the login path at all. `authorize()` and `exchange()` in
`src/auth.ts` are already standalone functions — the bin is a thin wrapper.

### 5d. Switch visibility while working

On every switch the plugin calls `client.app.log({ service: 'anthropic-auth',
level: 'info', message: 'switched to <label> (5h 63% → parked)' })`, so the
reason for a switch is recoverable from the OpenCode log.

### 5e. Static config

Order and thresholds can be pinned in `opencode.json`; the CLI writes to the
store, and config wins on startup if both are set:

```jsonc
"plugin": [
  ["@andrzejchm/opencode-anthropic-auth", {
    "accountOrder": ["andrzej@stikky.co", "andrzej@personal.com", "spare@example.com"],
    "switchThreshold": 0.60,
    "weeklyThreshold": 0.98
  }]
]
```

## 6. Code layout (keeps upstream rebases cheap)

New files, so `git rebase upstream/main` stays mostly conflict-free:

| File | Responsibility |
|---|---|
| `src/accounts/store.ts` | Load/save/migrate the accounts file, atomic writes |
| `src/accounts/usage.ts` | Parse rate-limit headers, `/api/oauth/usage` probe |
| `src/accounts/selector.ts` | Eligibility + selection + parking, pure functions |
| `src/accounts/refresh.ts` | Per-account token refresh (moved out of `index.ts`) |
| `src/accounts/profile.ts` | `/api/oauth/profile` fetch → auto-label |
| `src/accounts/status.ts` | Render the secret-free `anthropic-status.json` |
| `src/index.ts` | Thin edits: call selector before request, feed headers after |
| `bin/oc-anthropic.ts` | CLI: status / login / order / label / use / remove |

`selector.ts` and `usage.ts` are pure and get the bulk of the unit tests
(threshold boundaries, all-exhausted, park/unpark across a reset, weekly block,
retry-on-429). Repo already uses `bun test` + biome + lefthook, so the existing
`bun run check` gate applies.

## 7. Order of work

1. Store + migration from the existing single credential (no behaviour change yet).
2. Per-account refresh, still single account. Verify nothing regressed.
3. Header parsing → usage state, logged only. Confirm numbers look right.
4. Selector + rotation behind an option, default off.
5. 429 park-and-retry.
6. Auto-labels via `/api/oauth/profile` + the secret-free status file.
7. `oc-anthropic` CLI: `status` first, then `login`, then the mutators.
8. Turn on by default in the fork, document, pin locally.

Steps 1–3 are safe to run against a single account before a second subscription
is available — and step 6's status file makes steps 3–5 observable while they're
being built, so it is worth pulling forward if rotation misbehaves.

## 8. Distribution

Local use needs no npm publish — build to `dist/` and reference it from a small
re-export file in `~/.config/opencode/plugins/`. Publishing under a personal npm
scope is optional and only worth it to get version pinning.

## 9. Open questions

- Does `/api/oauth/profile` distinguish two personal Max accounts with no org?
  `organization.name` is null for those, so the label falls back to email alone
  — fine, but worth confirming once a second account exists.
- Whether to expose a per-agent override (e.g. pin a heavy agent to one account)
  — not in the requirement, easy to add later on top of the selector.
- No TUI plugin is planned. If a visible in-app indicator is ever wanted for the
  web/desktop app, that is a separate question from this plan.
