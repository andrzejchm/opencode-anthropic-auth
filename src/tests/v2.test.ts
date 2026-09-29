import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { loadStore } from '../accounts/store'
import { ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR } from '../config'
import anthropicAuthPlugin, { AnthropicAuthPlugin } from '../index'
import { setup } from '../v2'
import { isolateStore, seedStore, testAccount } from './helpers/store'

isolateStore()

const originalVersionEnv = process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR]
beforeEach(() => {
  delete process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR]
})
afterEach(() => {
  if (originalVersionEnv === undefined) {
    delete process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR]
  } else {
    process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR] = originalVersionEnv
  }
})

/**
 * Minimal, hand-built stand-in for OpenCode v2's `Plugin.Context`.
 *
 * Reproduces just enough of the real host's behavior to exercise the
 * adapter honestly:
 *  - `session.hook` records the `{providerID}` scope option and, like the
 *    real host, only invokes a hook's callback for a matching event — this
 *    is what actually proves "other providers are left untouched", since
 *    `v2.ts` itself does not re-check `providerID` (it trusts the host's
 *    scoping).
 *  - `integration.transform` runs the callback against a draft whose
 *    `method.update` just records the registration for inspection.
 */
function createMockContext(options: Record<string, unknown> = {}) {
  const hooks = new Map<
    string,
    { callback: (event: any) => unknown; options?: { providerID?: string } }[]
  >()
  let methodRegistration: any

  const ctx = {
    options,
    integration: {
      transform: mock(async (callback: (draft: unknown) => void) => {
        callback({
          method: {
            update: (registration: unknown) => {
              methodRegistration = registration
            },
          },
        })
        return { dispose: async () => {} }
      }),
    },
    session: {
      hook: mock(
        async (
          name: string,
          callback: (event: any) => unknown,
          hookOptions?: { providerID?: string },
        ) => {
          const list = hooks.get(name) ?? []
          list.push({ callback, options: hookOptions })
          hooks.set(name, list)
          return { dispose: async () => {} }
        },
      ),
    },
  }

  /** Fire a hook exactly like the real host would: scoped by providerID. */
  async function fire(name: string, event: Record<string, unknown>) {
    for (const { callback, options: hookOptions } of hooks.get(name) ?? []) {
      if (
        hookOptions?.providerID &&
        event.model &&
        (event.model as { providerID?: string }).providerID !==
          hookOptions.providerID
      ) {
        continue
      }
      await callback(event)
    }
  }

  return { ctx, fire, getMethodRegistration: () => methodRegistration }
}

function modelRef(providerID: string) {
  return { id: 'claude-x', modelID: 'claude-x', providerID, name: 'x' }
}

describe('dual entrypoint', () => {
  test('default export exposes id, setup and server', () => {
    expect(anthropicAuthPlugin.id).toBe('anthropic-auth')
    expect(anthropicAuthPlugin.setup).toBeFunction()
    expect(anthropicAuthPlugin.server).toBe(AnthropicAuthPlugin)
  })
})

describe('v2 setup: OAuth method registration', () => {
  test('registers the Claude Pro/Max OAuth method on the anthropic integration', async () => {
    const { ctx, getMethodRegistration } = createMockContext()
    await setup(ctx as never)

    const registration = getMethodRegistration()
    expect(registration.integrationID).toBe('anthropic')
    expect(registration.method).toEqual({
      id: 'claude-max',
      type: 'oauth',
      label: 'Claude Pro/Max',
    })
    expect(registration.authorize).toBeFunction()
    expect(registration.refresh).toBeFunction()
  })
})

describe('v2 setup: http.request', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('rewrites headers and body for the anthropic provider', async () => {
    seedStore(testAccount({ access: 'account-1-access' }))
    const { ctx, fire } = createMockContext()
    await setup(ctx as never)

    const request = new Request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'should-be-removed' },
      body: JSON.stringify({
        model: 'claude-x',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'bash', description: 'run a shell command' }],
      }),
    })
    const event: Record<string, unknown> = {
      sessionID: 'ses_1',
      agent: 'build',
      model: modelRef('anthropic'),
      kind: 'primary',
      request,
    }

    await fire('http.request', event)

    const rewritten = event.request as Request
    expect(rewritten.headers.get('authorization')).toBe(
      'Bearer account-1-access',
    )
    expect(rewritten.headers.get('x-api-key')).toBeNull()
    const betas = rewritten.headers.get('anthropic-beta') ?? ''
    expect(betas).toContain('oauth-2025-04-20')
    expect(betas).toContain('interleaved-thinking-2025-05-14')
    expect(new URL(rewritten.url).searchParams.get('beta')).toBe('true')

    const body = JSON.parse(await rewritten.clone().text())
    expect(body.tools[0].name).toBe('mcp_Bash')
    expect(
      body.system.some((block: { text: string }) =>
        block.text.includes('You are a Claude agent'),
      ),
    ).toBe(true)
  })

  test('leaves a non-anthropic provider request untouched', async () => {
    seedStore(testAccount())
    const { ctx, fire } = createMockContext()
    await setup(ctx as never)

    const request = new Request('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: '{}',
    })
    const event: Record<string, unknown> = {
      sessionID: 'ses_1',
      agent: 'build',
      model: modelRef('openai'),
      kind: 'primary',
      request,
    }

    await fire('http.request', event)

    // The host would never even invoke the callback for this event (the hook
    // is registered with providerID: 'anthropic'); this asserts that scoping.
    expect(event.request).toBe(request)
  })
})

describe('v2 setup: http.response', () => {
  test('strips the tool-name prefix from a successful response', async () => {
    seedStore(testAccount())
    const { ctx, fire } = createMockContext()
    await setup(ctx as never)

    const request = new Request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })
    const requestEvent: Record<string, unknown> = {
      sessionID: 'ses_1',
      agent: 'build',
      model: modelRef('anthropic'),
      kind: 'primary',
      request,
    }
    await fire('http.request', requestEvent)

    const response = Response.json(
      { name: 'mcp_Bash', type: 'tool_use' },
      { headers: { 'content-type': 'application/json' } },
    )
    const responseEvent: Record<string, unknown> = {
      ...requestEvent,
      request: requestEvent.request,
      response,
    }
    await fire('http.response', responseEvent)

    const stripped = responseEvent.response as Response
    const text = await stripped.text()
    expect(text).toContain('"name":"bash"')
  })

  test('rotates to the next account after a 429', async () => {
    seedStore(
      testAccount({ id: 'a1', label: 'a1', access: 'access-1' }),
      testAccount({ id: 'a2', label: 'a2', access: 'access-2' }),
    )
    const { ctx, fire } = createMockContext()
    await setup(ctx as never)

    async function messagesRoundTrip(responseInit: ResponseInit) {
      const request = new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      })
      const event: Record<string, unknown> = {
        sessionID: 'ses_1',
        agent: 'build',
        model: modelRef('anthropic'),
        kind: 'primary',
        request,
      }
      await fire('http.request', event)
      const usedAccessToken = (event.request as Request).headers.get(
        'authorization',
      )
      event.response = new Response('{"type":"error"}', responseInit)
      await fire('http.response', event)
      return usedAccessToken
    }

    const first = await messagesRoundTrip({
      status: 429,
      headers: { 'content-type': 'application/json' },
    })
    expect(first).toBe('Bearer access-1')

    const second = await messagesRoundTrip({ status: 200 })
    expect(second).toBe('Bearer access-2')

    const store = loadStore()
    expect(
      store.accounts.find((a) => a.id === 'a1')?.parkedUntil,
    ).toBeGreaterThan(Date.now())
  })
})
