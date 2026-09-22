# OpenCode Anthropic Auth — multi-account

Use several Claude Pro/Max subscriptions with [OpenCode](https://github.com/anomalyco/opencode) and rotate between them automatically as each one fills up its 5-hour limit.

A fork of [ex-machina-co/opencode-anthropic-auth](https://github.com/ex-machina-co/opencode-anthropic-auth), which does all the hard work of making a Claude subscription usable from OpenCode. This fork adds the multi-account layer on top.

> [!WARNING]
> No guarantees. Rotating subscriptions specifically to get past plan limits is plausibly a Terms of Service violation on **each** account involved, and upstream already notes that heavy automated usage has gotten people banned. You are choosing that risk, not avoiding it.
>
> Also: this is not a licence to hammer the API. Use it to stop losing an afternoon to a limit you hit at 4pm, not to run Ralph loops across three accounts.

---

## What it does

You log into 2+ Claude subscriptions. The plugin uses the first one until it reaches its switch threshold, moves to the next, and picks an account back up on its own once its 5-hour window resets.

```
$ oc-anthropic status
   #  ACCOUNT                ORG             TIER      5H   SWITCH  RESETS IN  7D    STATE
 > 1  you@work.example       Acme            max_5x    12%  80%     4h 8m      28%   ACTIVE
   2  you@side.example       Side Project    max_5x     8%  60%     18m        48%   idle
   3  you@personal.example   —               max_20x    0%  90%     4h 58m     13%   idle
```

Usage is read from the `anthropic-ratelimit-unified-*` headers that every `/v1/messages` response already carries, so tracking costs no extra requests and adds no latency.

---

## Install

This is not on npm. It installs straight from GitHub, so pin a commit or tag rather than tracking `main`.

### 1. Add the plugin

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": ["github:andrzejchm/opencode-anthropic-auth#v2.0.0"]
}
```

Remove `@ex-machina/opencode-anthropic-auth` if you have it — two plugins registering the same auth provider will fight.

> [!TIP]
> Pin to a tag or commit. An unpinned plugin re-resolves on startup, which is a supply-chain risk for *any* plugin, not just this one. `#v2.0.0` above is that pin.

### 2. Install the CLI

```bash
bun add -g github:andrzejchm/opencode-anthropic-auth#v2.0.0
```

Gives you `oc-anthropic`. The plugin works without it — the CLI is how you add accounts and see what's going on.

### 3. Log in

```bash
oc-anthropic login    # once per subscription
oc-anthropic status
```

If you were already using the upstream plugin, your existing login is imported automatically as account #1. No need to re-authenticate.

Accounts label themselves from `/api/oauth/profile`, so you never type a label and can't mix up which credential is which.

---

## How rotation works

Each account has a **switch threshold**. While the active account is below it, nothing changes. Once it crosses, the next account in order takes over.

```
account 1 (80%) ──crosses 80%──▶ account 2 (60%) ──crosses 60%──▶ account 3 (90%)
       ▲                                                                 │
       └──────────── its 5-hour window resets ◀──────────────────────────┘
```

Three rules worth knowing:

**Accounts come back on their own.** When an account hands over, it's parked until its 5-hour window actually resets — not until its utilization happens to dip. That's also what stops it flip-flopping around the threshold, which matters because prompt caching is per-account and every switch costs a full cache-miss re-read of the conversation.

**The last account is a floor, not a cliff.** If every account is over its threshold, requests keep going to the last one until Anthropic actually rejects them, rather than failing early while you still have headroom.

**A rate-limit response is handled mid-request.** On a 429 the account is parked and the request is retried on the next account, so you don't see the error. Only rate-limit responses trigger this — an ordinary 400 is returned as-is rather than burning every account on one malformed request.

**A broken account doesn't break the rotation.** If an account's refresh token has been revoked, it is parked and the request falls through to the next one. Run `oc-anthropic login` for that account to bring it back; `oc-anthropic status` shows the error against it.

---

## Commands

```
oc-anthropic                       # status (default)
oc-anthropic status                # usage, thresholds, resets, state
oc-anthropic refresh               # poll live usage for all accounts

oc-anthropic login                 # add another subscription
oc-anthropic remove <acct>         # drop one

oc-anthropic order <a> <b> <c>     # set rotation order
oc-anthropic threshold <acct> 80   # per-account switch point (or `default`)
oc-anthropic label <acct> <name>   # rename

oc-anthropic use <acct>            # force-switch now, ignoring thresholds
oc-anthropic unpark                # clear all parks, restart from #1
```

`<acct>` takes a full label, a unique prefix, or an account id — `oc-anthropic threshold you@wo 80` works.

`use` parks everything ahead of the target for an hour, so it sticks until those expire or you run `unpark`.

`refresh` only matters for accounts that haven't served a request recently; normal usage keeps itself current for free.

---

## Configuration

Everything is optional. The CLI writes to the store and always wins over config, so you won't set something with the CLI and have it silently ignored.

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": [
    ["github:andrzejchm/opencode-anthropic-auth#v2.0.0", {
      "switchThreshold": 0.6,
      "weeklyThreshold": 0.98,
      "accountOrder": ["you@work.example", "you@side.example"],
      "accountThresholds": { "you@work.example": 80 }
    }]
  ]
}
```

- **`ANTHROPIC_BASE_URL`** — Overrides the Anthropic API endpoint for both release lines, such as when using a proxy. Must be a valid HTTP(S) URL.
- **`ANTHROPIC_INSECURE`** — Skips TLS certificate verification. Behavior differs by OpenCode version:
    - **OpenCode v1** — Set to `1` or `true` to skip verification. Only effective when `ANTHROPIC_BASE_URL` is also set.
    - **OpenCode v2** — Not supported. OpenCode v2 plugin request hooks cannot disable TLS verification. If set, the plugin logs a warning and leaves verification enabled; requests to an untrusted or self-signed `ANTHROPIC_BASE_URL` will fail.
- **`ANTHROPIC_CLAUDE_CODE_VERSION`** — Overrides the Claude Code version reported to Anthropic for both release lines. Must be `major.minor.patch` (for example, `2.1.280`). Defaults to the bundled version; a malformed value is logged and the bundled version is used instead. A value older than the bundled version is honored but logs a warning, since reporting an older version can make newer models reject the request. Read once when the plugin loads, so restart OpenCode after changing it.

| Option | Default | Meaning |
|---|---|---|
| `switchThreshold` | `0.6` | 5-hour utilization at which an account hands over |
| `weeklyThreshold` | `0.98` | 7-day utilization at which an account is skipped entirely |
| `accountOrder` | login order | rotation order, by label or id |
| `accountThresholds` | `{}` | per-account overrides, keyed by label or id |

Thresholds accept `80` or `0.8` — both mean 80%.

Environment overrides: `ANTHROPIC_SWITCH_THRESHOLD`, `ANTHROPIC_WEEKLY_THRESHOLD`. Upstream's `ANTHROPIC_BASE_URL`, `ANTHROPIC_INSECURE` and `ANTHROPIC_CLAUDE_CODE_VERSION` still work.

---

## Files

| Path | Contents |
|---|---|
| `~/.local/share/opencode/anthropic-accounts.json` | the store: refresh tokens, mode `0600` |
| `~/.local/share/opencode/anthropic-status.json` | **secret-free**, rewritten on every switch |

The status file is the one to read. It's derived from the store on every write so it can't drift, and it contains no credentials — safe to `cat`, `jq`, `watch`, or point a status bar at:

```bash
watch -n5 'jq -r ".accounts[] | \"\(.state)\t\(.label)\t\(.u5h*100)%\"" \
  ~/.local/share/opencode/anthropic-status.json'
```

Both paths can be overridden with `ANTHROPIC_ACCOUNTS_FILE` and `ANTHROPIC_STATUS_FILE`.

Switches are also logged to the OpenCode server log, with the reason:

```
switched to you@side.example (5h 8%) — left you@work.example at 5h 81%
```

---

## Works with the web and desktop apps

The plugin runs inside the OpenCode **server**, not the client, so rotation behaves the same whether you use the TUI, the web app, or the desktop app. There is deliberately no TUI panel — the status file and CLI work everywhere.

---

## Notes and limits

**OpenCode still shows one credential.** Its auth store has a single slot per provider, so `opencode auth list` shows one Anthropic entry regardless of how many accounts you have. That entry is a mirror; this plugin's store is the source of truth.

**Mid-request retry needs a replayable body.** Retrying on a different account requires re-sending the request body. That works for `/v1/messages`; if a request ever streams its body, it returns the rate-limit error instead of switching.

**Prompt caching is per-account.** Every switch costs one cache-miss re-read of the conversation. Parking-until-reset keeps that to roughly one switch per account per window — don't set thresholds so tight that it thrashes.

**One account per subscription.** Accounts are keyed by Anthropic's account uuid, so re-authorizing an existing account updates it in place instead of creating a duplicate.

**Token refresh is locked across processes.** Anthropic revokes a refresh token the moment it is exchanged, so two processes refreshing the same account at once revoke each other's credentials — easy to hit, since OpenCode runs a long-lived server while the CLI runs separately. Refreshes take a lock file in the data directory and re-read before exchanging.

---

## Development

```bash
bun install
bun test           # 275 tests
bun run build      # dist/ is committed — see below
bunx biome check .
```

`dist/` is checked in. OpenCode installs plugins straight from this repo and bun blocks the `prepare` script, so a source-only checkout would have no entrypoint. The pre-commit hook rebuilds and stages `dist/` whenever `src/` changes, so you should not need to think about it.

Rotation logic lives in `src/accounts/`:

| File | Responsibility |
|---|---|
| `selector.ts` | which account serves the next request — pure, heavily tested |
| `store.ts` | the account file: atomic writes, migration, lookup |
| `usage.ts` | rate-limit headers, `/api/oauth/usage`, `/api/oauth/profile` |
| `refresh.ts` | per-account token refresh, deduplicated in-process and across processes |
| `lock.ts` | cross-process file lock |
| `manager.ts` | glue between the request path and the store |
| `status.ts` | the secret-free status file |
| `cli.ts` | `oc-anthropic` |

Everything upstream does — system prompt sanitisation, tool prefixing, the billing header, streaming transforms — is untouched, so rebasing on upstream stays cheap.

---

## Licence

MIT, same as upstream. See [LICENSE](./LICENSE).

Credit to [ex-machina-co](https://github.com/ex-machina-co/opencode-anthropic-auth) for the plugin this is built on.
