import type { Plugin } from '@opencode-ai/plugin'
import { addAccount } from './accounts/login.ts'
import { createManager, resolveConfig } from './accounts/manager.ts'
import { authorize, exchange } from './auth.ts'
import { resolveClaudeCodeVersion } from './config.ts'
import { CLAUDE_CODE_VERSION } from './constants.ts'
import {
  createStrippedStream,
  isInsecure,
  mergeHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from './transform.ts'

/**
 * Write a line to the OpenCode server log.
 *
 * Best-effort: diagnostics must never take the plugin down, so a logging
 * failure is swallowed and the request proceeds.
 */
async function log(
  client: unknown,
  level: 'info' | 'warn' | 'error',
  message: string,
): Promise<void> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: SDK types don't expose app.log
    await (client as any)?.app?.log({
      body: { service: 'anthropic-auth', level, message },
    })
  } catch {
    /* Logging is best-effort. */
  }
}

export const AnthropicAuthPlugin: Plugin = async ({ client }, options) => {
  // Resolved once per plugin instance so every request reports the same
  // version in both the user-agent and the billing header.
  const resolution = resolveClaudeCodeVersion()
  if (resolution.type === 'invalid') {
    await log(client, 'error', resolution.error)
  } else if (resolution.type === 'outdated') {
    await log(client, 'warn', resolution.warning)
  }
  // Only a malformed override lacks a usable version; an outdated one was set
  // deliberately, so it is reported as configured.
  const claudeCodeVersion =
    resolution.type === 'invalid' ? CLAUDE_CODE_VERSION : resolution.version

  const config = resolveConfig(options)
  // Rotation logs keep their own level: switching accounts is routine, and
  // reporting it as a warning would bury the ones that matter.
  const manager = createManager(config, (level, message) => {
    void log(client, level, message)
  })

  return {
    auth: {
      provider: 'anthropic',
      async loader(
        getAuth: () => Promise<{ type: string }>,
        provider: { models: Record<string, { cost: unknown }> },
      ) {
        const auth = await getAuth()
        if (auth.type !== 'oauth') return {}

        // zero out cost for max plan
        for (const model of Object.values(provider.models)) {
          model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
        }

        return {
          apiKey: '',
          async fetch(input: string | URL | Request, init?: RequestInit) {
            let body = init?.body
            if (body && typeof body === 'string') {
              body = rewriteRequestBody(body, claudeCodeVersion)
            }
            // Only a string body can be replayed on a different account; a
            // stream is already consumed by the first attempt.
            const canRetry = typeof body === 'string' || body === undefined
            const rewritten = rewriteUrl(input)
            const attempts = canRetry ? Math.max(1, manager.size()) : 1

            let lastResponse: Response | null = null
            for (let attempt = 0; attempt < attempts; attempt++) {
              // A null account means the selected one could not be made
              // usable (revoked token, for instance); it has been parked, so
              // the next pass picks a different one.
              const account = await manager.acquire()
              if (!account) continue

              const requestHeaders = mergeHeaders(input, init)
              setOAuthHeaders(requestHeaders, account.access, claudeCodeVersion)

              const response = await fetch(rewritten.input, {
                ...init,
                body,
                headers: requestHeaders,
                ...(isInsecure() && { tls: { rejectUnauthorized: false } }),
              })

              manager.record(account, response)

              if (response.ok) return createStrippedStream(response)

              // Read the error body once so we can both classify it and still
              // hand a complete response back to the caller.
              const text = await response.text().catch(() => '')
              const replay = new Response(text, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              })

              if (!manager.isLimit(response, text)) return replay

              manager.park(account, response, text)
              lastResponse = replay
            }

            return (
              lastResponse ??
              createStrippedStream(await fetch(rewritten.input, init))
            )
          },
        }
      },
      methods: [
        {
          label: 'Claude Pro/Max',
          type: 'oauth',
          authorize: async () => {
            const result = await authorize('max')
            return {
              url: result.url,
              instructions: 'Paste the authorization code here:',
              method: 'code',
              callback: async (code: string) => {
                const credentials = await exchange(
                  code,
                  result.verifier,
                  result.redirectUri,
                  result.state,
                )
                // Append to the multi-account store. OpenCode still keeps a
                // single credential of its own; ours is the source of truth.
                if (credentials.type === 'success') {
                  await addAccount(credentials, config).catch(() => undefined)
                }
                return credentials
              },
            }
          },
        },
        {
          label: 'Create an API Key',
          type: 'oauth',
          authorize: async () => {
            const result = await authorize('console')
            return {
              url: result.url,
              instructions: 'Paste the authorization code here:',
              method: 'code',
              callback: async (code: string) => {
                const credentials = await exchange(
                  code,
                  result.verifier,
                  result.redirectUri,
                  result.state,
                )
                if (credentials.type === 'failed') return credentials
                const apiKey = await fetch(
                  `https://api.anthropic.com/api/oauth/claude_cli/create_api_key`,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      authorization: `Bearer ${credentials.access}`,
                    },
                  },
                ).then((r) => r.json() as Promise<{ raw_key: string }>)
                return { type: 'success' as const, key: apiKey.raw_key }
              },
            }
          },
        },
        {
          provider: 'anthropic',
          label: 'Manually enter API Key',
          type: 'api',
        },
      ],
    },
    // biome-ignore lint/suspicious/noExplicitAny: Plugin type doesn't include undocumented auth/hooks
  } as any
}
