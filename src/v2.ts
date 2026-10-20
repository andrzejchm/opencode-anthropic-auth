// OpenCode v2 adapter.
//
// Registers the Anthropic Claude Pro/Max OAuth method through
// `ctx.integration.transform` (mirroring upstream's v2/main port) and applies
// the request/response rewrite through the `http.request` / `http.response`
// session hooks, scoped to the `anthropic` provider.
//
// Unlike upstream's v2 port, account selection goes through this fork's
// multi-account `Manager` (`accounts/manager.ts`) on every request, exactly
// like the v1 adapter's custom `fetch` does. Rotation on a rate limit relies
// on OpenCode's own retry of a 429 triggering a fresh `http.request` call —
// see the "Known limitations" note in the PR description / final report for
// what this does and doesn't guarantee.
//
// Only `@opencode/plugin` *types* are imported here (`import type`), never a
// runtime value from that package: the package isn't installed at all when
// this plugin runs under OpenCode v1, and this file must still be safely
// importable (though unused) in that case.
import type { Credential, Plugin } from '@opencode/plugin'
import { addAccount, LabelConflictError } from './accounts/login.ts'
import {
  createManager,
  PinnedAccountError,
  resolveConfig,
} from './accounts/manager.ts'
import type { Account } from './accounts/types.ts'
import { authorize, exchange } from './auth.ts'
import { BodyLimitError, contentLength, readBoundedText } from './bounded.ts'
import {
  compareClaudeCodeVersions,
  resolveClaudeCodeVersion,
} from './config.ts'
import { CLAUDE_CODE_VERSION } from './constants.ts'
import {
  createStrippedStream,
  headersAfterBodyTransform,
  isInsecure,
  mergeHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from './transform.ts'
import { parseClaudeCodeVersionRejection } from './version-rejection.ts'

const PLUGIN_ID = 'anthropic-auth'
const INTEGRATION_ID = 'anthropic'
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024
const MAX_RESPONSE_ERROR_BODY_BYTES = 256 * 1024

/** Session metadata key that pins a session to one account. */
export const PIN_METADATA_KEY = 'anthropicAccount'
/** Hidden OAuth form field an API client can use to label a new account. */
export const ACCOUNT_LABEL_FIELD = 'accountLabel'
/** Sessions whose pin (or lack of one) is remembered. */
const PIN_CACHE_SIZE = 1000
/** Guards the parent walk against a cycle or a pathological chain. */
const MAX_PARENT_DEPTH = 32

// `methodID` is a branded `Integration.MethodID` at the type level (a
// compile-time-only tag, no runtime representation), so a plain string
// literal needs a cast to satisfy the branded field.
const METHOD_ID = 'claude-max' as Credential.OAuth['methodID']

function warnIfInsecureUnsupported(): void {
  if (!isInsecure()) return
  console.warn(
    '[anthropic-auth] ANTHROPIC_INSECURE is set, but OpenCode v2 plugin ' +
      'request hooks cannot disable TLS verification for a custom ' +
      'ANTHROPIC_BASE_URL endpoint. TLS verification remains enabled — ' +
      'requests to an untrusted/self-signed endpoint will fail.',
  )
}

function toCredential(tokens: {
  refresh: string
  access: string
  expires: number
}): Credential.OAuth {
  return {
    type: 'oauth',
    methodID: METHOD_ID,
    refresh: tokens.refresh,
    access: tokens.access,
    expires: tokens.expires,
  }
}

type SessionLookup = (sessionID: string) => Promise<
  | {
      readonly parentID?: string
      readonly metadata?: Readonly<Record<string, unknown>>
    }
  | undefined
>

/**
 * Resolve the account a session is pinned to, or `null` when it isn't.
 *
 * The pin is the session's `metadata.anthropicAccount`. Subagent sessions are
 * created without the parent's metadata, so a session without the key
 * inherits from the nearest ancestor that has it. Results (including "not
 * pinned") are cached per session, least-recently-used first out, so steady
 * state costs no lookups. A failed lookup is not cached.
 */
export function createPinResolver(
  lookup: SessionLookup,
  limit = PIN_CACHE_SIZE,
): (sessionID: string) => Promise<string | null> {
  const cache = new Map<string, Promise<string | null>>()

  const remember = (id: string, value: Promise<string | null>): void => {
    cache.delete(id)
    cache.set(id, value)
    while (cache.size > limit) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  async function walk(sessionID: string): Promise<string | null> {
    const seen = new Set<string>()
    let id: string | undefined = sessionID
    for (let depth = 0; id && depth < MAX_PARENT_DEPTH; depth++) {
      if (seen.has(id)) break
      seen.add(id)
      const cached = id === sessionID ? undefined : cache.get(id)
      if (cached) return cached
      const session = await lookup(id)
      const pin = session?.metadata?.[PIN_METADATA_KEY]
      if (typeof pin === 'string' && pin.trim()) return pin.trim()
      id = session?.parentID
    }
    return null
  }

  return (sessionID) => {
    const cached = cache.get(sessionID)
    if (cached) {
      remember(sessionID, cached)
      return cached
    }
    const pending = walk(sessionID)
    remember(sessionID, pending)
    pending.catch(() => {
      if (cache.get(sessionID) === pending) cache.delete(sessionID)
    })
    return pending
  }
}

/**
 * Set up the plugin against an OpenCode v2 `Plugin.Context`.
 *
 * Exported separately from the dual-entrypoint default export (see
 * `index.ts`) so it can be unit-tested against a hand-built mock context
 * without needing a real OpenCode v2 install.
 */
export async function setup(
  ctx: Plugin.Context,
): Promise<Plugin.Cleanup | undefined> {
  warnIfInsecureUnsupported()

  // Resolved once so user-agent and billing metadata agree for every request
  // handled by this plugin generation — same rule as the v1 adapter.
  const resolution = resolveClaudeCodeVersion()
  if (resolution.type === 'invalid') {
    console.error(`[${PLUGIN_ID}] ${resolution.error}`)
  } else if (resolution.type === 'outdated') {
    console.warn(`[${PLUGIN_ID}] ${resolution.warning}`)
  }
  let claudeCodeVersion =
    resolution.type === 'invalid' ? CLAUDE_CODE_VERSION : resolution.version
  // A valid explicit override is absolute; automatic version-gate recovery
  // (below) only ever adopts a *newer* version, and must not do so when the
  // user has deliberately pinned one.
  const hasExplicitVersionOverride =
    process.env.ANTHROPIC_CLAUDE_CODE_VERSION !== undefined &&
    resolution.type !== 'invalid'

  const config = resolveConfig(ctx.options as Record<string, unknown>)
  const manager = createManager(config, (level, message) => {
    const method = level === 'info' ? 'log' : level
    console[method](`[${PLUGIN_ID}] ${message}`)
  })

  let active = true
  // Correlates the account used for a request with its response: v2 fires
  // `http.request` and `http.response` as two separate hook calls rather than
  // the single synchronous `fetch` v1 gets, so the account has to be threaded
  // through by reference.
  const accountByRequest = new WeakMap<Request, Account>()

  const resolvePin = createPinResolver(async (sessionID) =>
    typeof ctx.session.get === 'function'
      ? await ctx.session.get({
          sessionID,
        } as Parameters<typeof ctx.session.get>[0])
      : undefined,
  )

  /**
   * Today's selection for an unpinned session; only the pinned account for a
   * pinned one (or normal selection after it, with `pinnedFallback`).
   */
  async function acquireFor(sessionID: string): Promise<Account | null> {
    let pin: string | null
    try {
      pin = await resolvePin(sessionID)
    } catch (error) {
      console.warn(
        `[${PLUGIN_ID}] could not read session ${sessionID} to check for an ` +
          `account pin; using normal account selection: ${error instanceof Error ? error.message : String(error)}`,
      )
      pin = null
    }
    if (pin === null) return manager.acquire()

    try {
      return await manager.acquirePinned(pin)
    } catch (error) {
      if (!(error instanceof PinnedAccountError) || !config.pinnedFallback) {
        throw error
      }
      console.warn(
        `[${PLUGIN_ID}] ${error.summary} Falling back to normal account selection (pinnedFallback).`,
      )
      return manager.acquire()
    }
  }

  await ctx.integration.transform((draft) => {
    draft.method.update({
      integrationID: INTEGRATION_ID,
      method: {
        id: METHOD_ID,
        type: 'oauth',
        label: 'Claude Pro/Max',
        // Hidden and optional: the TUI, web app and CLI skip it and connect
        // exactly as before. API clients can pass
        // `answer: { accountLabel: "..." }` to name the new account.
        form: [
          {
            type: 'string',
            key: ACCOUNT_LABEL_FIELD,
            title: 'Account label',
            description:
              'Label for this Claude account in the multi-account store. Defaults to the account email.',
            hidden: true,
          },
        ],
      },
      authorize: async (answer) => {
        const requested = answer?.[ACCOUNT_LABEL_FIELD]
        const label =
          typeof requested === 'string' && requested.trim()
            ? requested.trim()
            : undefined
        const result = await authorize('max')
        return {
          url: result.url,
          instructions: 'Paste the authorization code here:',
          mode: 'code',
          callback: async (code: string) => {
            const credentials = await exchange(
              code,
              result.verifier,
              result.redirectUri,
              result.state,
            )
            if (credentials.type === 'failed') {
              throw new Error(
                'Failed to exchange the Claude Pro/Max authorization code. ' +
                  'Double-check that you pasted the full code and try again.',
              )
            }
            // Append to the multi-account store, exactly like the v1
            // adapter. OpenCode v2 still keeps its own single credential per
            // connection; ours is the source of truth for which account
            // actually serves a given request.
            await addAccount(
              credentials,
              config,
              label ? { label } : undefined,
            ).catch((error) => {
              // A clashing label is the caller's mistake and must surface;
              // anything else stays best-effort, as before.
              if (error instanceof LabelConflictError) throw error
            })
            return toCredential(credentials)
          },
        }
      },
      // OpenCode calls this to keep its own single connection credential
      // fresh. Real per-request account selection/refresh happens in
      // `http.request` via `manager.acquire()`; this just has to return
      // *something* valid so the connection doesn't look expired.
      refresh: async (credential) => {
        const account = await manager.acquire()
        return account ? toCredential(account) : credential
      },
      label: () => 'Claude Pro/Max (multi-account)',
    })
  })

  await ctx.session.hook(
    'http.request',
    async (event) => {
      if (!active) return
      const account = await acquireFor(event.sessionID)
      // No usable account (none configured, or all parked/revoked): leave
      // the request untouched. It will go out with whatever credential
      // OpenCode's own connection resolution attached, most likely failing
      // the same way v1's last-resort unauthenticated fetch does.
      if (!account) return

      const request = event.request
      const rewritten = rewriteUrl(request)
      const url = rewritten.url
      const pathname = url?.pathname

      const transformsBody =
        request.method === 'POST' &&
        (pathname === '/v1/messages' ||
          pathname === '/v1/messages/count_tokens')

      if (!transformsBody) {
        const headers = mergeHeaders(request)
        setOAuthHeaders(headers, account.access, claudeCodeVersion)
        const routed =
          rewritten.input instanceof Request
            ? rewritten.input
            : new Request(url ? url.toString() : request.url, request)
        event.request = new Request(routed, {
          headers,
          signal: request.signal,
        })
        accountByRequest.set(event.request, account)
        return
      }

      const hasBody = request.body !== null
      const declaredLength = contentLength(request.headers)
      if (
        hasBody &&
        declaredLength !== undefined &&
        declaredLength > MAX_REQUEST_BODY_BYTES
      ) {
        throw new BodyLimitError(
          'Anthropic request body',
          MAX_REQUEST_BODY_BYTES,
        )
      }
      const bodyText = hasBody
        ? await readBoundedText(
            request.clone().body,
            MAX_REQUEST_BODY_BYTES,
            'Anthropic request body',
          )
        : undefined
      if (!active) return

      const rewrittenBody =
        bodyText !== undefined
          ? rewriteRequestBody(bodyText, claudeCodeVersion)
          : undefined
      const bodyChanged = bodyText !== undefined && rewrittenBody !== bodyText

      const headers = bodyChanged
        ? headersAfterBodyTransform(mergeHeaders(request))
        : mergeHeaders(request)
      setOAuthHeaders(headers, account.access, claudeCodeVersion)

      const rewrittenRequest = new Request(url ? url.toString() : request.url, {
        method: request.method,
        headers,
        body: rewrittenBody,
        signal: request.signal,
      })

      event.request = rewrittenRequest
      accountByRequest.set(rewrittenRequest, account)
    },
    { providerID: INTEGRATION_ID },
  )

  await ctx.session.hook(
    'http.response',
    async (event) => {
      if (!active) return
      const account = accountByRequest.get(event.request)
      // Not a request this plugin rewrote (e.g. `acquire()` returned null
      // above) — leave the response alone.
      if (!account) return

      manager.record(account, event.response)

      if (!event.response.ok) {
        const text = await readBoundedText(
          event.response.clone().body,
          MAX_RESPONSE_ERROR_BODY_BYTES,
          'Anthropic error response',
        ).catch(() => '')

        // A 400 "claude_code_version_too_old" gate can be recovered from
        // immediately by reporting the version Anthropic asked for and
        // asking OpenCode to retry — the retried request re-enters
        // `http.request` above and picks it up from `claudeCodeVersion`.
        if (!hasExplicitVersionOverride && event.response.status === 400) {
          const rejection = parseClaudeCodeVersionRejection(
            text,
            claudeCodeVersion,
          )
          if (
            rejection &&
            compareClaudeCodeVersions(
              rejection.requiredVersion,
              claudeCodeVersion,
            ) === 1
          ) {
            claudeCodeVersion = rejection.requiredVersion
            const headers = new Headers(event.response.headers)
            headers.set('x-should-retry', 'true')
            event.response = new Response(event.response.body, {
              status: event.response.status,
              statusText: event.response.statusText,
              headers,
            })
          }
        }

        if (manager.isLimit(event.response, text)) {
          manager.park(account, event.response, text)
        }
        return
      }

      event.response = createStrippedStream(event.response)
    },
    { providerID: INTEGRATION_ID },
  )

  return () => {
    active = false
  }
}
