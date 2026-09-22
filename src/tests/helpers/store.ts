import { afterEach, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveStore, storePath } from '../../accounts/store.ts'
import type { Account, Store, Usage } from '../../accounts/types.ts'

/**
 * Give every test its own store, status and OpenCode-auth file.
 *
 * Call once at the top of a test file. Without this, tests share the single
 * path set up in `setup.ts` and leak accounts into each other — a test that
 * expects an empty store sees whatever the previous one wrote.
 */
export function isolateStore(): void {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-anthropic-case-'))
    process.env.ANTHROPIC_ACCOUNTS_FILE = join(dir, 'accounts.json')
    process.env.ANTHROPIC_STATUS_FILE = join(dir, 'status.json')
    process.env.OPENCODE_AUTH_FILE = join(dir, 'opencode-auth.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
}

/** A usable account with a token that is not close to expiry. */
export function testAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: overrides.label ?? 'acct-1',
    label: 'acct-1',
    org: null,
    tier: null,
    refresh: 'refresh-token',
    access: 'access-token',
    expires: Date.now() + 3_600_000,
    usage: null,
    // Already looked up, so tests don't trigger a background profile fetch.
    profileAt: Date.now(),
    threshold: null,
    parkedUntil: 0,
    lastUsed: null,
    error: null,
    ...overrides,
  }
}

export function usage(u5h: number, overrides: Partial<Usage> = {}): Usage {
  return {
    u5h,
    reset5h: Math.floor((Date.now() + 2 * 3_600_000) / 1000),
    u7d: 0,
    reset7d: Math.floor((Date.now() + 48 * 3_600_000) / 1000),
    at: Date.now(),
    ...overrides,
  }
}

/** Replace the account store with exactly these accounts. */
export function seedStore(...accounts: Account[]): Store {
  const store: Store = {
    version: 1,
    active: accounts[0]?.id ?? null,
    accounts,
  }
  saveStore(store)
  return store
}

export function clearStore(): void {
  rmSync(storePath(), { force: true })
}
