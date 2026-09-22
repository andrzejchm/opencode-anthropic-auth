import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { loadStore } from '../accounts/store'
import { buildBillingHeaderValue } from '../cch'
import { ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR } from '../config'
import { CLAUDE_CODE_VERSION } from '../constants'
import { AnthropicAuthPlugin } from '../index'
import { isolateStore, seedStore, testAccount, usage } from './helpers/store'

/** Extract the URL string from a fetch input (string, URL, or Request). */
function extractUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

// Minimal mock of the OpenCode plugin client
function createMockClient() {
  return {
    auth: {
      set: mock(() => Promise.resolve()),
    },
    app: {
      log: mock(() => Promise.resolve()),
    },
  }
}

isolateStore()

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const EMPTY_POST = { method: 'POST', body: '{}' } as const

async function getPlugin(client?: ReturnType<typeof createMockClient>) {
  return (await AnthropicAuthPlugin({
    // @ts-expect-error: minimal mock for testing
    client: client ?? createMockClient(),
  })) as Promise<any>
}

// The plugin reads ANTHROPIC_CLAUDE_CODE_VERSION at load time, so an ambient
// value in the developer's shell would otherwise leak into every test in this
// file.
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

describe('AnthropicAuthPlugin', () => {
  test('returns an object with auth properties', async () => {
    const plugin = await getPlugin()
    expect(plugin.auth).toBeDefined()
    expect(plugin.auth.provider).toBe('anthropic')
    expect(plugin.auth.loader).toBeFunction()
    expect(plugin.auth.methods).toBeArray()
  })
})

describe('auth.methods', () => {
  test('has three auth methods', async () => {
    const plugin = await getPlugin()
    expect(plugin.auth.methods).toHaveLength(3)
  })

  test('first method is Claude Pro/Max OAuth with code flow', async () => {
    const plugin = await getPlugin()
    const method = plugin.auth.methods[0]
    expect(method.label).toBe('Claude Pro/Max')
    expect(method.type).toBe('oauth')
    expect(method.authorize).toBeFunction()
  })

  test('second method is Create an API Key OAuth with code flow', async () => {
    const plugin = await getPlugin()
    const method = plugin.auth.methods[1]
    expect(method.label).toBe('Create an API Key')
    expect(method.type).toBe('oauth')
    expect(method.authorize).toBeFunction()
  })

  test('third method is manual API key', async () => {
    const plugin = await getPlugin()
    const method = plugin.auth.methods[2]
    expect(method.label).toBe('Manually enter API Key')
    expect(method.type).toBe('api')
    expect(method.provider).toBe('anthropic')
  })
})

describe('auth.loader', () => {
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout

  /** The loader no longer takes credentials from getAuth — only the auth type. */
  const oauth = () => Promise.resolve({ type: 'oauth' })

  async function loaderFor(client?: ReturnType<typeof createMockClient>) {
    const plugin = await getPlugin(client)
    return plugin.auth.loader(oauth, { models: {} })
  }

  beforeEach(() => {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
    seedStore(testAccount())
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
  })

  test('returns empty object for non-oauth auth', async () => {
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () => Promise.resolve({ type: 'api' }),
      { models: {} },
    )
    expect(result).toEqual({})
  })

  test('zeros out model costs for oauth auth', async () => {
    const plugin = await getPlugin()
    const models = {
      'claude-3': {
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
      },
    }
    await plugin.auth.loader(oauth, { models })
    expect(models['claude-3'].cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    })
  })

  test('returns fetch wrapper for oauth auth', async () => {
    const result = await loaderFor()
    expect(result.apiKey).toBe('')
    expect(result.fetch).toBeFunction()
  })

  test('sets OAuth headers from the active account and prefixes tools', async () => {
    let capturedHeaders: Headers | undefined
    let capturedBody: string | undefined

    globalThis.fetch = mock((_input: any, init: any) => {
      capturedHeaders = init?.headers
      capturedBody = init?.body
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    seedStore(testAccount({ access: 'my-access-token' }))
    const result = await loaderFor()

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({ tools: [{ name: 'bash', type: 'function' }] }),
    })

    expect(capturedHeaders).toBeDefined()
    expect(capturedHeaders!.get('authorization')).toBe('Bearer my-access-token')
    expect(capturedHeaders!.get('x-api-key')).toBeNull()
    expect(capturedHeaders!.get('anthropic-beta')).toContain('oauth-2025-04-20')
    expect(JSON.parse(capturedBody!).tools[0].name).toBe('mcp_Bash')
  })

  test('refreshes an expired account before sending, and persists the new tokens', async () => {
    const calls: Array<{ url: string; body?: string }> = []

    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      calls.push({ url, body: init?.body })

      if (url.includes('/v1/oauth/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'new-refresh',
              access_token: 'new-access',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    seedStore(
      testAccount({
        access: 'expired-token',
        refresh: 'old-refresh',
        expires: Date.now() - 1000,
      }),
    )

    const result = await loaderFor()
    await result.fetch(MESSAGES_URL, EMPTY_POST)

    const tokenCall = calls.find((c) => c.url.includes('/v1/oauth/token'))
    expect(tokenCall).toBeDefined()
    expect(JSON.parse(tokenCall!.body!).refresh_token).toBe('old-refresh')

    // Credentials live in the account store now, not OpenCode's auth entry.
    const stored = loadStore().accounts[0]!
    expect(stored.access).toBe('new-access')
    expect(stored.refresh).toBe('new-refresh')

    // The request itself went out on the refreshed token.
    const messagesCall = calls.find((c) => c.url.includes('/v1/messages'))
    expect(messagesCall).toBeDefined()
  })

  test('strips tool prefix from streaming response', async () => {
    const encoder = new TextEncoder()
    const responseStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"content_block":{"type":"tool_use","name":"mcp_bash"}}\n\n',
          ),
        )
        controller.close()
      },
    })

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(responseStream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    ) as unknown as typeof fetch

    const result = await loaderFor()
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    const text = await response.text()
    expect(text).toContain('"name": "bash"')
    expect(text).not.toContain('mcp_bash')
  })

  test('adds beta=true to /v1/messages URL', async () => {
    let capturedUrl: string | undefined
    globalThis.fetch = mock((input: any) => {
      capturedUrl = extractUrl(input)
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const result = await loaderFor()
    await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(capturedUrl).toContain('beta=true')
  })

  test('records rate-limit headers from the response onto the account', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(null, {
          status: 200,
          headers: {
            'anthropic-ratelimit-unified-5h-utilization': '0.42',
            'anthropic-ratelimit-unified-5h-reset': '1790035800',
            'anthropic-ratelimit-unified-7d-utilization': '0.11',
          },
        }),
      ),
    ) as unknown as typeof fetch

    const result = await loaderFor()
    await result.fetch(MESSAGES_URL, EMPTY_POST)

    const stored = loadStore().accounts[0]!
    expect(stored.usage?.u5h).toBe(0.42)
    expect(stored.usage?.reset5h).toBe(1790035800)
    expect(stored.usage?.u7d).toBe(0.11)
    expect(stored.lastUsed).toBeNumber()
  })

  test('sends on the next account once the first is over its threshold', async () => {
    const tokensUsed: string[] = []
    globalThis.fetch = mock((_input: any, init: any) => {
      tokensUsed.push((init.headers as Headers).get('authorization') ?? '')
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    seedStore(
      testAccount({
        id: 'a',
        label: 'a',
        access: 'token-a',
        usage: usage(0.9),
      }),
      testAccount({
        id: 'b',
        label: 'b',
        access: 'token-b',
        usage: usage(0.1),
      }),
    )

    const result = await loaderFor()
    await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(tokensUsed).toEqual(['Bearer token-b'])
  })

  test('parks the account and retries on the next one when rate limited', async () => {
    const tokensUsed: string[] = []
    globalThis.fetch = mock((_input: any, init: any) => {
      const auth = (init.headers as Headers).get('authorization') ?? ''
      tokensUsed.push(auth)

      if (auth === 'Bearer token-a') {
        return Promise.resolve(
          new Response('rate_limit_error', {
            status: 429,
            headers: {
              'anthropic-ratelimit-unified-5h-reset': String(
                Math.floor(Date.now() / 1000) + 3600,
              ),
            },
          }),
        )
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    seedStore(
      testAccount({ id: 'a', label: 'a', access: 'token-a' }),
      testAccount({ id: 'b', label: 'b', access: 'token-b' }),
    )

    const result = await loaderFor()
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(tokensUsed).toEqual(['Bearer token-a', 'Bearer token-b'])
    expect(
      loadStore().accounts.find((a) => a.id === 'a')!.parkedUntil,
    ).toBeGreaterThan(Date.now())
  })

  test('returns a non-limit error unchanged instead of burning another account', async () => {
    const tokensUsed: string[] = []
    globalThis.fetch = mock((_input: any, init: any) => {
      tokensUsed.push((init.headers as Headers).get('authorization') ?? '')
      return Promise.resolve(
        new Response('{"error":"bad request"}', { status: 400 }),
      )
    }) as unknown as typeof fetch

    seedStore(
      testAccount({ id: 'a', label: 'a', access: 'token-a' }),
      testAccount({ id: 'b', label: 'b', access: 'token-b' }),
    )

    const result = await loaderFor()
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('bad request')
    expect(tokensUsed).toEqual(['Bearer token-a'])
  })

  test('gives up after every account has been rate limited', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('rate_limit_error', { status: 429 })),
    ) as unknown as typeof fetch

    seedStore(
      testAccount({ id: 'a', label: 'a', access: 'token-a' }),
      testAccount({ id: 'b', label: 'b', access: 'token-b' }),
    )

    const result = await loaderFor()
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(429)
  })
})

describe('reported Claude Code version', () => {
  const originalFetch = globalThis.fetch
  const USER_MESSAGE = 'hello world test message'

  beforeEach(() => {
    seedStore(testAccount())
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  /**
   * Version-override diagnostics only.
   *
   * Account rotation logs through the same channel, so filtering by level
   * keeps these assertions about the version override rather than about
   * whatever the rotation happened to report.
   */
  function versionLogs(client: ReturnType<typeof createMockClient>) {
    const calls = (client.app.log as unknown as ReturnType<typeof mock>).mock
      .calls as Array<[{ body: { level: string; message: string } }]>
    return calls
      .map(([call]) => call.body)
      .filter((body) => body.level === 'warn' || body.level === 'error')
  }

  /**
   * Drive one OAuth request through the plugin and return the two places the
   * Claude Code version is reported to Anthropic.
   */
  async function captureReportedVersion(
    client: ReturnType<typeof createMockClient>,
  ) {
    let capturedHeaders: Headers | undefined
    let capturedBody: string | undefined

    globalThis.fetch = mock((_input: any, init: any) => {
      capturedHeaders = init?.headers
      capturedBody = init?.body
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin(client)
    const result = await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth' }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: USER_MESSAGE }],
      }),
    })

    return {
      userAgent: capturedHeaders!.get('user-agent'),
      billingHeader: JSON.parse(capturedBody!).system[0].text as string,
    }
  }

  /** Read the single override diagnostic the plugin emitted at startup. */
  function readSingleLog(client: ReturnType<typeof createMockClient>) {
    const logs = versionLogs(client)
    expect(logs).toHaveLength(1)
    return { body: logs[0]! }
  }

  test('reports the bundled version when the override is unset', async () => {
    const { userAgent, billingHeader } = await captureReportedVersion(
      createMockClient(),
    )

    expect(userAgent).toBe(`claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`)
    expect(billingHeader).toContain(`cc_version=${CLAUDE_CODE_VERSION}.`)
  })

  test('reports a valid override in both the user-agent and billing header', async () => {
    process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR] = '  2.9.99  '

    const { userAgent, billingHeader } = await captureReportedVersion(
      createMockClient(),
    )

    expect(userAgent).toBe('claude-cli/2.9.99 (external, cli)')
    // The billing suffix is derived from the override, not the bundled version.
    expect(billingHeader).toBe(
      buildBillingHeaderValue(
        [{ role: 'user', content: USER_MESSAGE }],
        '2.9.99',
        'sdk-cli',
      ),
    )
  })

  test('logs and falls back to the bundled version for a malformed override', async () => {
    process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR] = 'latest'
    const client = createMockClient()

    const { userAgent, billingHeader } = await captureReportedVersion(client)

    const logged = readSingleLog(client)
    expect(logged.body.level).toBe('error')
    expect(logged.body.message).toContain(ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR)
    expect(logged.body.message).toContain('major.minor.patch')

    // Falling back keeps both reported values valid and in agreement.
    expect(userAgent).toBe(`claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`)
    expect(billingHeader).toContain(`cc_version=${CLAUDE_CODE_VERSION}.`)
  })

  test('warns but still reports an override older than the bundled version', async () => {
    process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR] = '2.1.279'
    const client = createMockClient()

    const { userAgent, billingHeader } = await captureReportedVersion(client)

    const logged = readSingleLog(client)
    expect(logged.body.level).toBe('warn')
    expect(logged.body.message).toContain(ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR)
    expect(logged.body.message).toContain(CLAUDE_CODE_VERSION)

    // Warning it is not the same as ignoring it: the explicit override still
    // reaches both reported places.
    expect(userAgent).toBe('claude-cli/2.1.279 (external, cli)')
    expect(billingHeader).toContain('cc_version=2.1.279.')
  })

  test('stays silent for an override at or above the bundled version', async () => {
    process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR] = CLAUDE_CODE_VERSION
    const client = createMockClient()

    await captureReportedVersion(client)

    expect(versionLogs(client)).toEqual([])
  })

  test('loads without throwing when the client cannot log', async () => {
    process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR] = 'latest'

    const plugin = await AnthropicAuthPlugin({
      // @ts-expect-error: client without app.log, as in older OpenCode builds
      client: { auth: { set: mock(() => Promise.resolve()) } },
    })

    expect((plugin as any).auth.provider).toBe('anthropic')
  })
})
