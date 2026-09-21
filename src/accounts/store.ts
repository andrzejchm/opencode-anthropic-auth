import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { type Account, EMPTY_STORE, type Store } from './types.ts'

/**
 * OpenCode's data directory. Honours `XDG_DATA_HOME` the same way OpenCode
 * does, so the store sits next to `auth.json` on every platform we support.
 */
export function dataDir(): string {
  const xdg = process.env.XDG_DATA_HOME
  return join(
    xdg?.trim() ? xdg : join(homedir(), '.local', 'share'),
    'opencode',
  )
}

export function storePath(): string {
  return (
    process.env.ANTHROPIC_ACCOUNTS_FILE ||
    join(dataDir(), 'anthropic-accounts.json')
  )
}

export function statusPath(): string {
  return (
    process.env.ANTHROPIC_STATUS_FILE ||
    join(dataDir(), 'anthropic-status.json')
  )
}

function opencodeAuthPath(): string {
  return join(dataDir(), 'auth.json')
}

export function loadStore(): Store {
  try {
    const raw = readFileSync(storePath(), 'utf8')
    const parsed = JSON.parse(raw) as Store
    if (!parsed || !Array.isArray(parsed.accounts)) return { ...EMPTY_STORE }
    return {
      version: 1,
      active: parsed.active ?? null,
      accounts: parsed.accounts,
    }
  } catch {
    // Missing or corrupt store is not fatal — migration repopulates it.
    return { ...EMPTY_STORE }
  }
}

/**
 * Write the store atomically.
 *
 * `tmp` + `rename` so a concurrent reader never sees a half-written file, and
 * `0600` because this holds refresh tokens.
 */
export function saveStore(store: Store): void {
  const path = storePath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    /* best-effort on filesystems without POSIX modes */
  }
}

/**
 * Apply `mutate` to the freshest copy of the store, then persist.
 *
 * Re-reads immediately before mutating because several OpenCode servers (and
 * the CLI) can touch the file concurrently; the in-memory copy a caller is
 * holding may already be stale.
 */
export function updateStore(mutate: (store: Store) => void): Store {
  const store = loadStore()
  mutate(store)
  saveStore(store)
  return store
}

/**
 * Seed the store from OpenCode's single-slot credential.
 *
 * Runs once, when multi-account support is first enabled: the existing login
 * becomes account #1 so nobody has to re-authenticate to adopt the fork.
 */
export function migrateFromOpencodeAuth(): Account | null {
  const store = loadStore()
  if (store.accounts.length > 0) return null

  try {
    const auth = JSON.parse(readFileSync(opencodeAuthPath(), 'utf8')) as Record<
      string,
      { type?: string; refresh?: string; access?: string; expires?: number }
    >
    const entry = auth.anthropic
    if (entry?.type !== 'oauth' || !entry.refresh || !entry.access) return null

    const account: Account = {
      id: crypto.randomUUID(),
      label: 'imported',
      org: null,
      tier: null,
      refresh: entry.refresh,
      access: entry.access,
      expires: entry.expires ?? 0,
      usage: null,
      parkedUntil: 0,
      lastUsed: null,
      error: null,
    }
    saveStore({ version: 1, active: account.id, accounts: [account] })
    return account
  } catch {
    return null
  }
}

export function findAccount(store: Store, needle: string): Account | undefined {
  return (
    store.accounts.find((a) => a.id === needle) ??
    store.accounts.find((a) => a.label === needle) ??
    store.accounts.find((a) => a.label.startsWith(needle))
  )
}
