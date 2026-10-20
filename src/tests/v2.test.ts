import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { loadStore } from '../accounts/store'
import { ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR } from '../config'
import anthropicAuthPlugin, { AnthropicAuthPlugin } from '../index'
import { createPinResolver, setup } from '../v2'
import { isolateStore, seedStore, testAccount, usage } from './helpers/store'

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
type MockSession = { parentID?: string; metadata?: Record<string, unknown> }

function createMockContext(
  options: Record<string, unknown> = {},
  sessions?: Record<string, MockSession>,
) {
  const getSession = mock(async ({ sessionID }: { sessionID: string }) => {
    const session = sessions?.[sessionID]
    if (!session) throw new Error(`Session not found: ${sessionID}`)
    return { id: sessionID, ...session }
  })
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
      // Left out entirely unless a test supplies sessions, so the existing
      // tests also cover a host without `session.get`.
      ...(sessions ? { get: getSession } : {}),
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

  return {
    ctx,
    fire,
    getSession,
    getMethodRegistration: () => methodRegistration,
  }
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
    expect(registration.method).toMatchObject({
      id: 'claude-max',
      type: 'oauth',
      label: 'Claude Pro/Max',
    })
    expect(registration.authorize).toBeFunction()
    expect(registration.refresh).toBeFunction()
  })

  test('offers the account label only as a hidden, optional form field', async () => {
    const { ctx, getMethodRegistration } = createMockContext()
    await setup(ctx as never)

    // Hidden + not required + no default: every OpenCode client skips it and
    // connects exactly as it did without a form.
    expect(getMethodRegistration().method.form).toEqual([
      expect.objectContaining({
        type: 'string',
        key: 'accountLabel',
        hidden: true,
      }),
    ])
    const [field] = getMethodRegistration().method.form
    expect(field.required).toBeUndefined()
    expect(field.default).toBeUndefined()
  })
})

describe('v2 setup: connect label', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function stubOAuth(email: string, uuid = `uuid-${email}`) {
    globalThis.fetch = mock((input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (url.includes('/oauth/token')) {
        return Promise.resolve(
          Response.json({
            access_token: `access-${email}`,
            refresh_token: `refresh-${email}`,
            expires_in: 3600,
          }),
        )
      }
      if (url.includes('/api/oauth/profile')) {
        return Promise.resolve(
          Response.json({ account: { uuid, email }, organization: null }),
        )
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    }) as unknown as typeof fetch
  }

  async function connect(answer: Record<string, unknown> | undefined) {
    const { ctx, getMethodRegistration } = createMockContext()
    await setup(ctx as never)
    const authorization = await getMethodRegistration().authorize(answer)
    const state = new URL(authorization.url).searchParams.get('state')
    return authorization.callback(`code#${state}`)
  }

  test('labels a new account from the email when no label is given', async () => {
    stubOAuth('alice@example.com')
    await connect({})

    const [account] = loadStore().accounts
    expect(account?.label).toBe('alice@example.com')
    expect(account && 'email' in account).toBe(false)
  })

  test('labels a new account with accountLabel and remembers its email', async () => {
    stubOAuth('alice@example.com')
    await connect({ accountLabel: '  alice  ' })

    const [account] = loadStore().accounts
    expect(account?.label).toBe('alice')
    expect(account?.email).toBe('alice@example.com')
  })

  test('fails the connect when the label belongs to another account', async () => {
    seedStore(testAccount({ id: 'other', label: 'alice' }))
    stubOAuth('alice@example.com')

    await expect(connect({ accountLabel: 'alice' })).rejects.toThrow(
      'already labelled "alice"',
    )
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

describe('v2 setup: session account pinning', () => {
  const alice = () =>
    testAccount({ id: 'uuid-alice', label: 'alice', access: 'access-alice' })
  const bob = () =>
    testAccount({
      id: 'uuid-bob',
      label: 'bob',
      email: 'bob@example.com',
      access: 'access-bob',
    })
  const carol = () =>
    testAccount({ id: 'uuid-carol', label: 'carol', access: 'access-carol' })

  function requestEvent(sessionID: string): Record<string, unknown> {
    return {
      sessionID,
      agent: 'build',
      model: modelRef('anthropic'),
      kind: 'primary',
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
    }
  }

  async function send(
    fire: ReturnType<typeof createMockContext>['fire'],
    id: string,
  ) {
    const event = requestEvent(id)
    await fire('http.request', event)
    return (event.request as Request).headers.get('authorization')
  }

  test('a session without the key gets exactly the normal selection', async () => {
    seedStore(alice(), bob())
    const { ctx, fire } = createMockContext({}, { ses_1: { metadata: {} } })
    await setup(ctx as never)

    expect(await send(fire, 'ses_1')).toBe('Bearer access-alice')
    expect(loadStore().active).toBe('uuid-alice')
  })

  test('a lookup failure falls back to the normal selection', async () => {
    seedStore(alice(), bob())
    const { ctx, fire } = createMockContext({}, {})
    await setup(ctx as never)

    expect(await send(fire, 'ses_missing')).toBe('Bearer access-alice')
  })

  test.each([
    ['label', 'bob'],
    ['email', 'bob@example.com'],
    ['id', 'uuid-bob'],
  ])('pins by %s', async (_, pin) => {
    seedStore(alice(), bob(), carol())
    const { ctx, fire } = createMockContext(
      {},
      { ses_1: { metadata: { anthropicAccount: pin } } },
    )
    await setup(ctx as never)

    expect(await send(fire, 'ses_1')).toBe('Bearer access-bob')
  })

  test('pinned selections leave the global active account alone', async () => {
    seedStore(alice(), bob())
    const { ctx, fire } = createMockContext(
      {},
      {
        ses_bob: { metadata: { anthropicAccount: 'bob' } },
        ses_plain: {},
      },
    )
    await setup(ctx as never)

    expect(await send(fire, 'ses_bob')).toBe('Bearer access-bob')
    expect(loadStore().active).toBe('uuid-alice')
    expect(await send(fire, 'ses_plain')).toBe('Bearer access-alice')
    expect(await send(fire, 'ses_bob')).toBe('Bearer access-bob')
    expect(loadStore().active).toBe('uuid-alice')
  })

  test('ignores the 5h switch threshold, which only governs hand-over', async () => {
    seedStore(alice(), { ...bob(), usage: usage(0.9) })
    const { ctx, fire } = createMockContext(
      {},
      { ses_1: { metadata: { anthropicAccount: 'bob' } } },
    )
    await setup(ctx as never)

    expect(await send(fire, 'ses_1')).toBe('Bearer access-bob')
  })

  test('child sessions inherit the pin from the nearest ancestor', async () => {
    seedStore(alice(), bob(), carol())
    const { ctx, fire } = createMockContext(
      {},
      {
        ses_root: { metadata: { anthropicAccount: 'bob' } },
        ses_child: { parentID: 'ses_root' },
        ses_grandchild: { parentID: 'ses_child', metadata: { other: 1 } },
        ses_override: {
          parentID: 'ses_root',
          metadata: { anthropicAccount: 'carol' },
        },
      },
    )
    await setup(ctx as never)

    expect(await send(fire, 'ses_child')).toBe('Bearer access-bob')
    expect(await send(fire, 'ses_grandchild')).toBe('Bearer access-bob')
    expect(await send(fire, 'ses_override')).toBe('Bearer access-carol')
  })

  test('fails, naming the account and its reset, when the pinned account is parked', async () => {
    const until = Date.now() + 3_600_000
    seedStore(alice(), { ...bob(), parkedUntil: until })
    const { ctx, fire } = createMockContext(
      {},
      { ses_1: { metadata: { anthropicAccount: 'bob@example.com' } } },
    )
    await setup(ctx as never)

    const event = requestEvent('ses_1')
    const error = await (fire('http.request', event) as Promise<void>).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    )
    expect(error?.name).toBe('PinnedAccountError')
    expect(error?.message).toContain('"bob"')
    expect(error?.message).toContain(new Date(until).toISOString())
    expect(error?.message).toContain('pinnedFallback')
    // Nothing was sent with somebody else's credential.
    expect((event.request as Request).headers.get('authorization')).toBeNull()
  })

  test('fails when the pinned account is over its weekly limit', async () => {
    const reset7d = Math.floor((Date.now() + 86_400_000) / 1000)
    seedStore(alice(), { ...bob(), usage: usage(0.1, { u7d: 1, reset7d }) })
    const { ctx, fire } = createMockContext(
      {},
      { ses_1: { metadata: { anthropicAccount: 'bob' } } },
    )
    await setup(ctx as never)

    await expect(send(fire, 'ses_1')).rejects.toThrow(
      `weekly limit until ${new Date(reset7d * 1000).toISOString()}`,
    )
  })

  test('fails when the pinned account does not exist', async () => {
    seedStore(alice())
    const { ctx, fire } = createMockContext(
      {},
      { ses_1: { metadata: { anthropicAccount: 'nobody' } } },
    )
    await setup(ctx as never)

    await expect(send(fire, 'ses_1')).rejects.toThrow(
      'Claude account "nobody" was not found',
    )
  })

  test('a revoked pinned account is parked and fails instead of rotating', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('invalid_grant', { status: 400 })),
    ) as unknown as typeof fetch
    try {
      seedStore(alice(), { ...bob(), expires: Date.now() - 1 })
      const { ctx, fire } = createMockContext(
        {},
        { ses_1: { metadata: { anthropicAccount: 'bob' } } },
      )
      await setup(ctx as never)

      await expect(send(fire, 'ses_1')).rejects.toThrow(
        'could not refresh its token',
      )
      expect(
        loadStore().accounts.find((a) => a.id === 'uuid-bob')?.parkedUntil,
      ).toBeGreaterThan(Date.now())
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('a 429 parks the pinned account instead of rotating away from it', async () => {
    seedStore(alice(), bob())
    const { ctx, fire } = createMockContext(
      {},
      { ses_1: { metadata: { anthropicAccount: 'bob' } } },
    )
    await setup(ctx as never)

    const event = requestEvent('ses_1')
    await fire('http.request', event)
    event.response = new Response('{"type":"error"}', { status: 429 })
    await fire('http.response', event)

    expect(
      loadStore().accounts.find((a) => a.id === 'uuid-bob')?.parkedUntil,
    ).toBeGreaterThan(Date.now())
    await expect(send(fire, 'ses_1')).rejects.toThrow('is parked until')
  })

  test('pinnedFallback uses normal selection when the pinned account is unavailable', async () => {
    seedStore(alice(), { ...bob(), parkedUntil: Date.now() + 3_600_000 })
    const { ctx, fire } = createMockContext(
      { pinnedFallback: true },
      {
        ses_parked: { metadata: { anthropicAccount: 'bob' } },
        ses_missing: { metadata: { anthropicAccount: 'nobody' } },
      },
    )
    await setup(ctx as never)

    expect(await send(fire, 'ses_parked')).toBe('Bearer access-alice')
    expect(await send(fire, 'ses_missing')).toBe('Bearer access-alice')
  })

  test('pinnedFallback still prefers the pinned account when it is usable', async () => {
    seedStore(alice(), bob())
    const { ctx, fire } = createMockContext(
      { pinnedFallback: true },
      { ses_1: { metadata: { anthropicAccount: 'bob' } } },
    )
    await setup(ctx as never)

    expect(await send(fire, 'ses_1')).toBe('Bearer access-bob')
  })

  test('looks each session up once', async () => {
    seedStore(alice(), bob())
    const { ctx, fire, getSession } = createMockContext(
      {},
      {
        ses_root: { metadata: { anthropicAccount: 'bob' } },
        ses_child: { parentID: 'ses_root' },
        ses_plain: {},
      },
    )
    await setup(ctx as never)

    await send(fire, 'ses_root')
    await send(fire, 'ses_root')
    await send(fire, 'ses_child')
    await send(fire, 'ses_child')
    await send(fire, 'ses_plain')
    await send(fire, 'ses_plain')

    const looked = getSession.mock.calls.map(([input]) => input.sessionID)
    // The child reuses the root's cached answer instead of re-reading it.
    expect(looked).toEqual(['ses_root', 'ses_child', 'ses_plain'])
  })
})

describe('createPinResolver', () => {
  test('evicts the least recently used session beyond its limit', async () => {
    const lookup = mock(async (id: string) => ({
      metadata: { anthropicAccount: `pin-${id}` },
    }))
    const resolve = createPinResolver(lookup, 2)

    expect(await resolve('a')).toBe('pin-a')
    await resolve('b')
    await resolve('a') // a is now the most recent
    await resolve('c') // evicts b
    await resolve('a')
    expect(lookup).toHaveBeenCalledTimes(3)
    await resolve('b')
    expect(lookup).toHaveBeenCalledTimes(4)
  })

  test('does not cache a failed lookup', async () => {
    let fail = true
    const lookup = mock(async () => {
      if (fail) throw new Error('boom')
      return { metadata: { anthropicAccount: 'bob' } }
    })
    const resolve = createPinResolver(lookup)

    await expect(resolve('a')).rejects.toThrow('boom')
    fail = false
    expect(await resolve('a')).toBe('bob')
  })

  test('stops on a parent cycle', async () => {
    const resolve = createPinResolver(async (id) => ({
      parentID: id === 'a' ? 'b' : 'a',
    }))
    expect(await resolve('a')).toBeNull()
  })

  test('ignores a non-string or blank pin', async () => {
    const resolve = createPinResolver(async (id) => ({
      metadata: { anthropicAccount: id === 'n' ? 42 : '  ' },
    }))
    expect(await resolve('n')).toBeNull()
    expect(await resolve('blank')).toBeNull()
  })
})
