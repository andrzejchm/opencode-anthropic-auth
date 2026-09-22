import { writeStatus } from './status.ts'
import { loadStore, saveStore } from './store.ts'
import {
  type Account,
  type Config,
  DEFAULT_CONFIG,
  type Profile,
  type Store,
} from './types.ts'
import { fetchProfile } from './usage.ts'

export type Credentials = { refresh: string; access: string; expires: number }

/**
 * Locate an existing row for the subscription this profile describes.
 *
 * The account uuid is the identity, but an account migrated from OpenCode's
 * single credential is stored under a locally generated id until its profile
 * is first read — and that read never happens if its token has been revoked.
 * Falling back to the email stops re-authorizing such an account from adding a
 * duplicate instead of repairing the original.
 */
function findSameSubscription(store: Store, profile: Profile) {
  return (
    store.accounts.find((a) => a.id === profile.uuid) ??
    store.accounts.find((a) => a.label === profile.email)
  )
}

/**
 * Add a freshly authorized subscription to the store.
 *
 * Identity comes from `/api/oauth/profile` rather than from anything the user
 * types, so an account cannot be mislabelled. The profile uuid also dedupes:
 * re-authorizing an existing account refreshes it in place instead of adding a
 * duplicate row.
 */
export async function addAccount(
  credentials: Credentials,
  config: Config = DEFAULT_CONFIG,
): Promise<Account> {
  const profile = await fetchProfile(credentials.access)
  const store = loadStore()

  const existing = profile ? findSameSubscription(store, profile) : undefined

  if (existing && profile && existing.id !== profile.uuid) {
    // Matched by email: adopt the real identity so future logins match on uuid.
    if (store.active === existing.id) store.active = profile.uuid
    existing.id = profile.uuid
  }

  if (existing) {
    existing.refresh = credentials.refresh
    existing.access = credentials.access
    existing.expires = credentials.expires
    existing.parkedUntil = 0
    existing.error = null
    if (profile) {
      existing.label = profile.email
      existing.org = profile.org
      existing.tier = profile.tier
      existing.profileAt = Date.now()
      existing.error = null
    }
    saveStore(store)
    writeStatus(store, config)
    return existing
  }

  const account: Account = {
    id: profile?.uuid ?? crypto.randomUUID(),
    label: profile?.email ?? `account-${store.accounts.length + 1}`,
    org: profile?.org ?? null,
    tier: profile?.tier ?? null,
    refresh: credentials.refresh,
    access: credentials.access,
    expires: credentials.expires,
    usage: null,
    profileAt: profile ? Date.now() : null,
    threshold: null,
    parkedUntil: 0,
    lastUsed: null,
    error: null,
  }

  store.accounts.push(account)
  if (!store.active) store.active = account.id
  saveStore(store)
  writeStatus(store, config)
  return account
}
