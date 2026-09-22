import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { needsRefresh, refreshAccount } from '../accounts/refresh.ts'
import { loadStore, saveStore } from '../accounts/store.ts'
import { isolateStore, seedStore, testAccount } from './helpers/store.ts'

isolateStore()

const TOKEN_URL = '/v1/oauth/token'

function extractUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function tokenResponse(refresh = 'new-refresh', access = 'new-access') {
  return new Response(
    JSON.stringify({
      refresh_token: refresh,
      access_token: access,
      expires_in: 3600,
    }),
    { status: 200 },
  )
}

describe('needsRefresh', () => {
  test('is false for a token with plenty of life left', () => {
    expect(needsRefresh(testAccount({ expires: Date.now() + 3_600_000 }))).toBe(
      false,
    )
  })

  test('is true for an expired token', () => {
    expect(needsRefresh(testAccount({ expires: Date.now() - 1000 }))).toBe(true)
  })

  test('is true just before expiry, so a token cannot lapse mid-flight', () => {
    expect(needsRefresh(testAccount({ expires: Date.now() + 30_000 }))).toBe(
      true,
    )
  })

  test('is true when there is no access token at all', () => {
    expect(needsRefresh(testAccount({ access: '', expires: 0 }))).toBe(true)
  })
})

describe('refreshAccount', () => {
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout

  beforeEach(() => {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
  })

  test('persists rotated tokens to the store', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(tokenResponse()),
    ) as unknown as typeof fetch

    const account = testAccount({ refresh: 'old-refresh', expires: 0 })
    seedStore(account)

    const access = await refreshAccount(account)

    expect(access).toBe('new-access')
    const stored = loadStore().accounts[0]!
    expect(stored.access).toBe('new-access')
    expect(stored.refresh).toBe('new-refresh')
    expect(stored.expires).toBeGreaterThan(Date.now())
  })

  test('retries a transient 5xx with backoff', async () => {
    let calls = 0
    const setTimeoutMock = mock((handler: () => unknown) => {
      handler()
      return 0
    })
    // @ts-expect-error — mock override for testing
    globalThis.setTimeout = setTimeoutMock

    globalThis.fetch = mock((input: any) => {
      if (!extractUrl(input).includes(TOKEN_URL)) {
        return Promise.resolve(new Response(null, { status: 200 }))
      }
      calls += 1
      if (calls === 1) {
        return Promise.resolve(
          new Response('Temporary failure', { status: 500 }),
        )
      }
      return Promise.resolve(tokenResponse())
    }) as unknown as typeof fetch

    const account = testAccount({ expires: 0 })
    seedStore(account)

    await refreshAccount(account)

    expect(calls).toBe(2)
    expect(setTimeoutMock).toHaveBeenCalledWith(expect.any(Function), 500)
  })

  test('does not retry a non-transient failure', async () => {
    let calls = 0
    globalThis.fetch = mock(() => {
      calls += 1
      return Promise.resolve(new Response('Forbidden', { status: 403 }))
    }) as unknown as typeof fetch

    const account = testAccount({ expires: 0 })
    seedStore(account)

    await expect(refreshAccount(account)).rejects.toThrow(
      'Token refresh failed: 403',
    )
    expect(calls).toBe(1)
  })

  test('deduplicates concurrent refreshes of the same account', async () => {
    let calls = 0
    globalThis.fetch = mock(() => {
      calls += 1
      return Promise.resolve(tokenResponse())
    }) as unknown as typeof fetch

    const account = testAccount({ expires: 0 })
    seedStore(account)

    // Anthropic rotates the refresh token on every exchange, so racing
    // exchanges would invalidate each other.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => refreshAccount(account)),
    )

    expect(calls).toBe(1)
    expect(results).toEqual(Array(5).fill('new-access'))
  })

  test('refreshes accounts independently of each other', async () => {
    const sent: string[] = []
    globalThis.fetch = mock((_input: any, init: any) => {
      sent.push(JSON.parse(init.body).refresh_token)
      return Promise.resolve(tokenResponse())
    }) as unknown as typeof fetch

    const a = testAccount({
      id: 'a',
      label: 'a',
      refresh: 'refresh-a',
      expires: 0,
    })
    const b = testAccount({
      id: 'b',
      label: 'b',
      refresh: 'refresh-b',
      expires: 0,
    })
    seedStore(a, b)

    await Promise.all([refreshAccount(a), refreshAccount(b)])

    expect(sent.sort()).toEqual(['refresh-a', 'refresh-b'])
  })

  test('skips the exchange when another process already refreshed', async () => {
    // Anthropic revokes a refresh token as soon as it is exchanged, so a
    // second exchange for the same account would invalidate the first
    // process's credentials. OpenCode's long-lived server racing the CLI hits
    // this for real.
    let calls = 0
    globalThis.fetch = mock(() => {
      calls += 1
      return Promise.resolve(tokenResponse())
    }) as unknown as typeof fetch

    const account = testAccount({ access: 'stale', expires: 0 })
    seedStore(account)

    // Another process refreshed between us reading the account and refreshing.
    const store = loadStore()
    store.accounts[0]!.access = 'refreshed-elsewhere'
    store.accounts[0]!.expires = Date.now() + 3_600_000
    saveStore(store)

    const access = await refreshAccount(account)

    expect(calls).toBe(0)
    expect(access).toBe('refreshed-elsewhere')
    expect(account.access).toBe('refreshed-elsewhere')
  })

  test('sends the refresh token currently on disk, not a stale snapshot', async () => {
    const sent: string[] = []
    globalThis.fetch = mock((_input: any, init: any) => {
      sent.push(JSON.parse(init.body).refresh_token)
      return Promise.resolve(tokenResponse())
    }) as unknown as typeof fetch

    const account = testAccount({ refresh: 'stale-refresh', expires: 0 })
    seedStore(account)

    // Another process rotated the token after this Account object was read.
    const store = loadStore()
    store.accounts[0]!.refresh = 'rotated-by-another-process'
    saveStore(store)

    await refreshAccount(account)

    expect(sent).toEqual(['rotated-by-another-process'])
  })
})
