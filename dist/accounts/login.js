import { writeStatus } from "./status.js";
import { loadStore, saveStore } from "./store.js";
import { DEFAULT_CONFIG } from "./types.js";
import { fetchProfile } from "./usage.js";
/**
 * Add a freshly authorized subscription to the store.
 *
 * Identity comes from `/api/oauth/profile` rather than from anything the user
 * types, so an account cannot be mislabelled. The profile uuid also dedupes:
 * re-authorizing an existing account refreshes it in place instead of adding a
 * duplicate row.
 */
export async function addAccount(credentials, config = DEFAULT_CONFIG) {
    const profile = await fetchProfile(credentials.access);
    const store = loadStore();
    const existing = profile
        ? store.accounts.find((a) => a.id === profile.uuid)
        : undefined;
    if (existing) {
        existing.refresh = credentials.refresh;
        existing.access = credentials.access;
        existing.expires = credentials.expires;
        existing.parkedUntil = 0;
        existing.error = null;
        if (profile) {
            existing.label = profile.email;
            existing.org = profile.org;
            existing.tier = profile.tier;
            existing.profileAt = Date.now();
        }
        saveStore(store);
        writeStatus(store, config);
        return existing;
    }
    const account = {
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
    };
    store.accounts.push(account);
    if (!store.active)
        store.active = account.id;
    saveStore(store);
    writeStatus(store, config);
    return account;
}
