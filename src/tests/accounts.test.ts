import { afterEach, describe, expect, mock, test } from 'bun:test'
import { statSync, writeFileSync } from 'node:fs'
import { addAccount } from '../accounts/login.ts'
import { normalizeThreshold, resolveConfig } from '../accounts/manager.ts'
import { buildStatus } from '../accounts/status.ts'
import {
  findAccount,
  loadStore,
  migrateFromOpencodeAuth,
  storePath,
} from '../accounts/store.ts'
import { DEFAULT_CONFIG } from '../accounts/types.ts'
import {
  clearStore,
  isolateStore,
  seedStore,
  testAccount,
  usage,
} from './helpers/store.ts'

const originalFetch = globalThis.fetch

isolateStore()

afterEach(() => {
  globalThis.fetch = originalFetch
})

function writeOpencodeAuth(entry: unknown): void {
  writeFileSync(
    process.env.OPENCODE_AUTH_FILE as string,
    JSON.stringify({ anthropic: entry }),
  )
}

describe('store', () => {
  test('round-trips accounts', () => {
    seedStore(testAccount({ label: 'a' }), testAccount({ id: 'b', label: 'b' }))
    expect(loadStore().accounts.map((a) => a.label)).toEqual(['a', 'b'])
  })

  test('writes the store readable only by its owner', () => {
    seedStore(testAccount())
    // The file holds refresh tokens.
    expect(statSync(storePath()).mode & 0o777).toBe(0o600)
  })

  test('treats a corrupt store as empty rather than throwing', () => {
    writeFileSync(storePath(), 'not json')
    expect(loadStore().accounts).toEqual([])
  })

  test('does not carry accounts between reads when the file is missing', () => {
    // Regression: loadStore used to spread a shared EMPTY_STORE, so every
    // "empty" store handed back the same accounts array. Pushing onto one
    // leaked into the next read — ghost accounts on a fresh install.
    clearStore()
    const first = loadStore()
    first.accounts.push(testAccount({ id: 'ghost', label: 'ghost' }))

    expect(loadStore().accounts).toEqual([])
  })

  test('finds an account by id, exact label, or unique prefix', () => {
    seedStore(testAccount({ id: 'uuid-1', label: 'you@work.example' }))
    const store = loadStore()

    expect(findAccount(store, 'uuid-1')?.label).toBe('you@work.example')
    expect(findAccount(store, 'you@work.example')?.id).toBe('uuid-1')
    expect(findAccount(store, 'you@wo')?.id).toBe('uuid-1')
    expect(findAccount(store, 'nope')).toBeUndefined()
  })
})

describe('migrateFromOpencodeAuth', () => {
  test("adopts OpenCode's existing credential as the first account", () => {
    clearStore()
    writeOpencodeAuth({
      type: 'oauth',
      refresh: 'r',
      access: 'a',
      expires: 123,
    })

    const migrated = migrateFromOpencodeAuth()

    expect(migrated).not.toBeNull()
    expect(loadStore().accounts).toHaveLength(1)
    // Unlabelled until its profile is looked up on first use.
    expect(migrated?.profileAt).toBeNull()
  })

  test('does nothing when accounts already exist', () => {
    seedStore(testAccount({ label: 'existing' }))
    writeOpencodeAuth({ type: 'oauth', refresh: 'r', access: 'a' })

    expect(migrateFromOpencodeAuth()).toBeNull()
    expect(loadStore().accounts.map((a) => a.label)).toEqual(['existing'])
  })

  test('ignores a non-oauth credential', () => {
    clearStore()
    writeOpencodeAuth({ type: 'api', key: 'sk-ant-whatever' })
    expect(migrateFromOpencodeAuth()).toBeNull()
  })
})

describe('addAccount', () => {
  function stubProfile(uuid: string, email: string) {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            account: { uuid, email },
            organization: {
              name: 'Acme',
              rate_limit_tier: 'default_claude_max_5x',
            },
          }),
        ),
      ),
    ) as unknown as typeof fetch
  }

  const credentials = { refresh: 'r', access: 'a', expires: 1 }

  test('labels the account from its own profile', async () => {
    clearStore()
    stubProfile('uuid-1', 'you@work.example')

    const account = await addAccount(credentials)

    expect(account.id).toBe('uuid-1')
    expect(account.label).toBe('you@work.example')
    expect(account.org).toBe('Acme')
    expect(account.tier).toBe('max_5x')
  })

  test('re-authorizing an existing account updates it in place', async () => {
    clearStore()
    stubProfile('uuid-1', 'you@work.example')
    await addAccount(credentials)
    await addAccount({ refresh: 'r2', access: 'a2', expires: 2 })

    const store = loadStore()
    expect(store.accounts).toHaveLength(1)
    expect(store.accounts[0]!.access).toBe('a2')
  })

  test('clears a park when an account is re-authorized', async () => {
    stubProfile('uuid-1', 'you@work.example')
    seedStore(
      testAccount({
        id: 'uuid-1',
        label: 'stale',
        parkedUntil: Date.now() + 9e6,
      }),
    )

    await addAccount(credentials)

    expect(loadStore().accounts[0]!.parkedUntil).toBe(0)
  })

  test('falls back to a positional label when the profile is unreachable', async () => {
    clearStore()
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 500 })),
    ) as unknown as typeof fetch

    const account = await addAccount(credentials)

    expect(account.label).toBe('account-1')
    expect(account.profileAt).toBeNull()
  })

  test('keeps existing accounts when adding another', async () => {
    stubProfile('uuid-2', 'second@example.com')
    seedStore(testAccount({ id: 'uuid-1', label: 'first' }))

    await addAccount(credentials)

    expect(loadStore().accounts.map((a) => a.label)).toEqual([
      'first',
      'second@example.com',
    ])
  })
})

describe('resolveConfig', () => {
  test('falls back to the defaults', () => {
    expect(resolveConfig()).toEqual(DEFAULT_CONFIG)
  })

  test('reads thresholds and order from plugin options', () => {
    const config = resolveConfig({
      switchThreshold: 0.8,
      weeklyThreshold: 0.9,
      accountOrder: ['b', 'a'],
      accountThresholds: { a: 80, b: 0.5 },
    })

    expect(config.switchThreshold).toBe(0.8)
    expect(config.accountOrder).toEqual(['b', 'a'])
    // Percentages and fractions are both accepted.
    expect(config.accountThresholds).toEqual({ a: 0.8, b: 0.5 })
  })

  test('ignores an out-of-range threshold instead of disabling rotation', () => {
    expect(resolveConfig({ switchThreshold: 0 }).switchThreshold).toBe(
      DEFAULT_CONFIG.switchThreshold,
    )
    expect(resolveConfig({ switchThreshold: 'abc' }).switchThreshold).toBe(
      DEFAULT_CONFIG.switchThreshold,
    )
  })

  test('drops non-string entries from the order', () => {
    expect(
      resolveConfig({ accountOrder: ['a', 7, null] }).accountOrder,
    ).toEqual(['a'])
  })
})

describe('normalizeThreshold', () => {
  test('accepts a percentage', () => {
    expect(normalizeThreshold(80)).toBe(0.8)
    expect(normalizeThreshold('80')).toBe(0.8)
  })

  test('accepts a fraction', () => {
    expect(normalizeThreshold(0.8)).toBe(0.8)
  })

  test('treats 100 and 1 as the same ceiling', () => {
    expect(normalizeThreshold(100)).toBe(1)
    expect(normalizeThreshold(1)).toBe(1)
  })

  test('rejects values that would break rotation', () => {
    expect(normalizeThreshold(0)).toBeNull()
    expect(normalizeThreshold(-5)).toBeNull()
    expect(normalizeThreshold(101)).toBeNull()
    expect(normalizeThreshold('abc')).toBeNull()
    expect(normalizeThreshold(undefined)).toBeNull()
  })
})

describe('buildStatus', () => {
  test('reports order, state and the effective threshold without secrets', () => {
    const store = seedStore(
      testAccount({ id: 'a', label: 'a', usage: usage(0.9) }),
      testAccount({ id: 'b', label: 'b', usage: usage(0.1) }),
    )
    store.active = 'b'

    const status = buildStatus(store, {
      ...DEFAULT_CONFIG,
      accountThresholds: { a: 0.95 },
    })

    expect(status.active).toBe('b')
    expect(status.accounts[0]).toMatchObject({
      order: 1,
      label: 'a',
      threshold: 0.95,
      u5h: 0.9,
      state: 'idle',
    })
    expect(status.accounts[1]).toMatchObject({ label: 'b', state: 'active' })
    expect(JSON.stringify(status)).not.toContain('refresh-token')
    expect(JSON.stringify(status)).not.toContain('access-token')
  })
})
